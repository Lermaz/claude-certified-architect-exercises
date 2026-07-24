import {
  query,
  tool,
  createSdkMcpServer,
  type HookCallback,
  type PreToolUseHookInput,
  type PostToolUseHookInput,
  HookEvent,
  HookCallbackMatcher,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * agent-sdk-hooks.ts
 *
 * Claude Agent SDK exercise covering:
 *  1. Three MCP tools that return heterogeneous date/status formats
 *  2. PostToolUse normalisation → ISO 8601 dates + English status strings
 *  3. PreToolUse: block process_refund when amount > $500 → escalate_to_human
 *  4. PreToolUse: block transfer_funds until aml_check passed this session
 */

const MODEL = "claude-opus-4-8";
const AUTOMATED_REFUND_LIMIT = 500; // $500
const MCP_SERVER = "ops";

// ---------------------------------------------------------------------------
// Session state (AML gate)
// ---------------------------------------------------------------------------

export type SessionState = {
  amlPassed: boolean;
  amlCheckId: string | null;
  steps: string[];
};

export function createSession(): SessionState {
  return { amlPassed: false, amlCheckId: null, steps: [] };
}

/** Mutable session bound into hooks/tools for the current run. */
let session: SessionState = createSession();

export function resetSession(): SessionState {
  session = createSession();
  return session;
}

export function getSession(): SessionState {
  return session;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

const NUMERIC_STATUS: Record<number, string> = {
  0: "pending",
  1: "active",
  2: "closed",
  3: "failed",
  200: "ok",
  400: "invalid",
  403: "forbidden",
  500: "error",
};

const CHAR_STATUS: Record<string, string> = {
  P: "pending",
  A: "active",
  C: "closed",
  F: "failed",
  X: "cancelled",
  O: "ok",
  E: "error",
};

/**
 * Unix seconds/ms, ISO 8601, or DD/MM/YYYY → ISO 8601 UTC.
 */
export function toIso8601(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value !== "string") {
    throw new Error(`Cannot normalise date: ${String(value)}`);
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return toIso8601(Number(trimmed));
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime()))
      throw new Error(`Invalid ISO date: ${trimmed}`);
    return d.toISOString();
  }
  const dmy = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    return new Date(
      Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)),
    ).toISOString();
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime()))
    throw new Error(`Unrecognised date: ${trimmed}`);
  return d.toISOString();
}

/**
 * Numeric codes, single-char codes, or English strings → English status.
 */
export function toEnglishStatus(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return NUMERIC_STATUS[value] ?? `unknown_status_${value}`;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d+$/.test(s)) return toEnglishStatus(Number(s));
    if (s.length === 1) {
      const mapped = CHAR_STATUS[s.toUpperCase()];
      if (mapped) return mapped;
    }
    // Already a string status (Tool B) — normalise to lowercase snake-ish English
    return s.toLowerCase().replace(/\s+/g, "_");
  }
  return String(value);
}

type NormalisedRecord = {
  date: string;
  status: string;
  [key: string]: unknown;
};

/**
 * Pull a JSON object out of an MCP CallToolResult (or plain object) and
 * rewrite date/status fields into a consistent shape.
 */
export function normaliseToolPayload(toolResponse: unknown): unknown {
  const { payload, wrapAsMcp } = unwrapToolResponse(toolResponse);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return toolResponse;
  }

  const src = payload as Record<string, unknown>;
  const out: NormalisedRecord = { ...src } as NormalisedRecord;

  const dateRaw =
    src.date ??
    src.timestamp ??
    src.created_at ??
    src.updated_at ??
    src.checked_at;
  if (dateRaw !== undefined) {
    out.date = toIso8601(dateRaw);
    delete out.timestamp;
    delete out.created_at;
    delete out.updated_at;
    delete out.checked_at;
  }

  const statusRaw = src.status ?? src.status_code ?? src.code;
  if (statusRaw !== undefined) {
    out.status = toEnglishStatus(statusRaw);
    delete out.status_code;
    delete out.code;
  }

  if (wrapAsMcp) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(out) }],
    };
  }
  return out;
}

/**
 * Unwrap a tool response from an MCP CallToolResult (or plain object) and return
 * the payload and a flag indicating if the response was wrapped as MCP.
 */
function unwrapToolResponse(toolResponse: unknown): {
  payload: unknown;
  wrapAsMcp: boolean;
} {
  if (!toolResponse || typeof toolResponse !== "object") {
    return { payload: toolResponse, wrapAsMcp: false };
  }
  const tr = toolResponse as Record<string, unknown>;
  if (Array.isArray(tr.content)) {
    const textBlock = tr.content.find(
      (b): b is { type: string; text: string } =>
        !!b &&
        typeof b === "object" &&
        (b as { type?: string }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    );
    if (textBlock) {
      try {
        return { payload: JSON.parse(textBlock.text), wrapAsMcp: true };
      } catch {
        return { payload: { raw: textBlock.text }, wrapAsMcp: true };
      }
    }
  }
  return { payload: tr, wrapAsMcp: false };
}

function mcpJson(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

// ---------------------------------------------------------------------------
// MCP tools — three heterogeneous formats + financial ops
// ---------------------------------------------------------------------------

/**
 * Tool: Unix timestamps + numeric status codes
 * Prerequisite: the tool must be called when a record needs to be fetched.
 * Postrequisite: the tool must return a record with a Unix timestamp and a numeric status code.
 */
const toolA = tool(
  "tool_a",
  "Fetch record A. Returns Unix epoch seconds and a numeric status_code (0=pending, 1=active, 2=closed, 3=failed).",
  {
    record_id: z.string().describe("Record identifier"),
  },
  async (args) =>
    mcpJson({
      source: "tool_a",
      record_id: args.record_id,
      timestamp: 1_704_067_200, // 2024-01-01T00:00:00.000Z
      status_code: 1,
      amount: 120.5,
    }),
);

/**
 * Tool: ISO 8601 dates + string statuses
 * Prerequisite: the tool must be called when a record needs to be fetched.
 * Postrequisite: the tool must return a record with an ISO 8601 date and a string status.
 */
const toolB = tool(
  "tool_b",
  "Fetch record B. Returns ISO 8601 dates and string statuses (e.g. active, pending).",
  {
    record_id: z.string().describe("Record identifier"),
  },
  async (args) =>
    mcpJson({
      source: "tool_b",
      record_id: args.record_id,
      date: "2024-06-15T14:30:00.000Z",
      status: "pending",
      amount: 89.99,
    }),
);

/**
 * Tool: DD/MM/YYYY dates + single-character status codes
 * Prerequisite: the tool must be called when a legacy record needs to be fetched.
 * Postrequisite: the tool must return a record with a DD/MM/YYYY date and a single-character status code.
 */
const toolC = tool(
  "tool_c",
  "Fetch record C (legacy). Returns DD/MM/YYYY dates and single-char status codes (A/P/C/F/X).",
  {
    record_id: z.string().describe("Record identifier"),
  },
  async (args) =>
    mcpJson({
      source: "tool_c",
      record_id: args.record_id,
      date: "22/07/2026",
      status: "A",
      amount: 45.0,
    }),
);

/**
 * Tool: issue a customer refund.
 * Prerequisite: the tool must be called when a customer requests a refund.
 * Postrequisite: the tool must return a completed result.
 */
const processRefund = tool(
  "process_refund",
  "Issue a customer refund. Automated limit is $500 — larger amounts must escalate to a human.",
  {
    customer_id: z.string(),
    order_id: z.string(),
    amount: z.number().describe("Refund amount in USD"),
  },
  async (args) =>
    mcpJson({
      refund_id: `ref_${Date.now()}`,
      customer_id: args.customer_id,
      order_id: args.order_id,
      amount: args.amount,
      status: "completed",
      date: new Date().toISOString(),
    }),
);

/**
 * Tool: hand off to a human agent with a structured escalation summary.
 * Prerequisite: the tool must be called when the automated refund limit is exceeded or AML/compliance requires review.
 * Postrequisite: the tool must return a queued result.
 */
const escalateToHuman = tool(
  "escalate_to_human",
  "Hand off to a human agent with a structured escalation summary. Use when automated refunds exceed policy limits or AML/compliance requires review.",
  {
    reason: z.string(),
    customer_id: z.string().optional(),
    amount: z.number().optional(),
    summary: z.string().describe("Structured handoff brief for the human"),
    recommended_action: z.string(),
  },
  async (args) =>
    mcpJson({
      ticket_id: `esc_${Date.now()}`,
      status: "queued",
      ...args,
      date: new Date().toISOString(),
    }),
);

/**
 * Tool: run an anti-money-laundering check for a transfer.
 * Prerequisite: the tool must be called before transfer_funds.
 * Postrequisite: the tool must return a pass result.
 */
const amlCheck = tool(
  "aml_check",
  "Run an anti-money-laundering check for a transfer. Must pass before transfer_funds.",
  {
    account_id: z.string(),
    amount: z.number(),
  },
  async (args) =>
    mcpJson({
      check_id: `aml_${args.account_id}_${Math.floor(args.amount)}`,
      account_id: args.account_id,
      amount: args.amount,
      // Intentionally heterogeneous — PostToolUse normalises + records pass
      checked_at: Math.floor(Date.now() / 1000),
      status_code: 200, // maps to "ok" / treated as pass
      result: "pass",
    }),
);

/**
 * Tool: transfer funds between accounts.
 * Prerequisite: the tool must be called after aml_check has passed in the current session.
 * Postrequisite: the tool must return a completed result.
 */
const transferFunds = tool(
  "transfer_funds",
  "Transfer funds between accounts. Requires a passing aml_check in the current session.",
  {
    from_account: z.string(),
    to_account: z.string(),
    amount: z.number(),
  },
  async (args) =>
    mcpJson({
      transfer_id: `txn_${Date.now()}`,
      ...args,
      status: "completed",
      date: new Date().toISOString(),
    }),
);

export const opsServer = createSdkMcpServer({
  name: MCP_SERVER,
  version: "1.0.0",
  alwaysLoad: true,
  tools: [
    toolA,
    toolB,
    toolC,
    processRefund,
    escalateToHuman,
    amlCheck,
    transferFunds,
  ],
});

const mcp = (name: string) => `mcp__${MCP_SERVER}__${name}`;

export const ALLOWED_TOOLS = [
  mcp("tool_a"),
  mcp("tool_b"),
  mcp("tool_c"),
  mcp("process_refund"),
  mcp("escalate_to_human"),
  mcp("aml_check"),
  mcp("transfer_funds"),
];

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * PostToolUse: normalise dates → ISO 8601, statuses → English; record AML pass.
 * Prerequisite: the tool must be a valid MCP tool.
 */
export const normaliseToolResults: HookCallback = async (input) => {
  if (input.hook_event_name !== "PostToolUse") return {};
  const post = input as PostToolUseHookInput;

  const normalised = normaliseToolPayload(post.tool_response);

  // Track AML success for the transfer_funds gate
  if (
    post.tool_name === mcp("aml_check") ||
    post.tool_name.endsWith("__aml_check")
  ) {
    const { payload } = unwrapToolResponse(normalised);
    const obj = (payload ?? {}) as Record<string, unknown>;
    const result = String(obj.result ?? obj.status ?? "").toLowerCase();
    const passed =
      result === "pass" || result === "ok" || result === "approved";
    if (passed) {
      session.amlPassed = true;
      session.amlCheckId =
        typeof obj.check_id === "string" ? obj.check_id : "unknown";
      session.steps.push(`aml_check:pass:${session.amlCheckId}`);
    } else {
      session.amlPassed = false;
      session.steps.push(`aml_check:fail`);
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: normalised,
      additionalContext:
        "Dates are ISO 8601 UTC; status fields are human-readable English strings.",
    },
  };
};

/**
 * PreToolUse: block process_refund over $500 and redirect to human escalation.
 * Prerequisite: process_refund must be called with an amount less than $500.
 */
export const enforceRefundLimit: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const pre = input as PreToolUseHookInput;
  if (
    pre.tool_name !== mcp("process_refund") &&
    !pre.tool_name.endsWith("__process_refund")
  ) {
    return {};
  }

  const toolInput = pre.tool_input as { amount?: number };
  const amount = Number(toolInput.amount ?? 0);
  if (amount > AUTOMATED_REFUND_LIMIT) {
    session.steps.push(`process_refund:blocked:${amount}`);
    return {
      systemMessage: `Refund $${amount} exceeds the $${AUTOMATED_REFUND_LIMIT} automated limit — escalate to a human.`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: [
          `Refund amount $${amount} exceeds the $${AUTOMATED_REFUND_LIMIT} automated policy limit.`,
          `Do NOT retry process_refund.`,
          `Call ${mcp("escalate_to_human")} with reason "refund_exceeds_agent_limit",`,
          `the customer_id, amount, a structured summary, and recommended_action.`,
        ].join(" "),
      },
    };
  }
  return {};
};

/**
 * PreToolUse: block transfer_funds until aml_check has passed this session.
 * Prerequisite: aml_check must have passed in the current session.
 */
export const requireAmlBeforeTransfer: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const pre = input as PreToolUseHookInput;
  if (
    pre.tool_name !== mcp("transfer_funds") &&
    !pre.tool_name.endsWith("__transfer_funds")
  ) {
    return {};
  }

  if (!session.amlPassed) {
    session.steps.push("transfer_funds:blocked:aml_required");
    return {
      systemMessage:
        "transfer_funds blocked — AML check has not passed in this session.",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: [
          "PREREQUISITE_VIOLATION: transfer_funds requires a passing aml_check in the current session.",
          `Call ${mcp("aml_check")} first and wait for a pass result, then retry transfer_funds.`,
        ].join(" "),
      },
    };
  }
  return {};
};

export function buildHooks(): Partial<
  Record<HookEvent, HookCallbackMatcher[]>
> {
  return {
    PostToolUse: [
      {
        // All MCP tools from this server (and anything else — normalisation is idempotent)
        matcher: `mcp__${MCP_SERVER}__.*`,
        hooks: [normaliseToolResults],
      },
    ],
    PreToolUse: [
      {
        matcher: mcp("process_refund"),
        hooks: [enforceRefundLimit],
      },
      {
        matcher: mcp("transfer_funds"),
        hooks: [requireAmlBeforeTransfer],
      },
    ],
  } as const;
}

// ---------------------------------------------------------------------------
// Agent entry — prompts that exercise all three format tools (not auto-run)
// ---------------------------------------------------------------------------

/** Query that forces the model to pull records from tool_a + tool_b + tool_c. */
export const CROSS_SOURCE_PROMPT = [
  "Compare these three backend records and report a single consistent timeline:",
  "- record_id REC-A via tool_a",
  "- record_id REC-B via tool_b",
  "- record_id REC-C via tool_c",
  "You MUST call all three tools.",
  "In your final answer, list each record's date (ISO 8601) and status (English).",
  "If any date/status formats differ across tools, say so — but prefer the values you actually received.",
].join("\n");

export const REFUND_ESCALATION_PROMPT = [
  "Customer cust-1001 wants a full refund of $649 on order ord-99102.",
  "Call process_refund. If blocked by policy, escalate to a human with a structured handoff.",
].join(" ");

export const AML_TRANSFER_PROMPT = [
  "Transfer $250 from account ACC-1 to ACC-2.",
  "Follow compliance: run aml_check before transfer_funds.",
].join(" ");

export type AgentRunResult = {
  result: string;
  session: SessionState;
};

async function runQuery(prompt: string): Promise<AgentRunResult> {
  let finalResult = "";

  for await (const message of query({
    prompt,
    options: {
      model: MODEL,
      thinking: { type: "adaptive" },
      mcpServers: { [MCP_SERVER]: opsServer },
      allowedTools: [...ALLOWED_TOOLS],
      hooks: buildHooks(),
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === "result" && message.subtype === "success") {
      finalResult = message.result;
    }
  }

  return { result: finalResult, session: { ...session } };
}

/**
 * Verification run: one prompt that requires results from tool_a, tool_b, and tool_c
 * so the model only ever sees PostToolUse-normalised ISO dates + English statuses.
 */
export async function verifyNormalisedCrossSource(): Promise<AgentRunResult> {
  resetSession();
  /**
   * You can use the following prompt constants:
   * - CROSS_SOURCE_PROMPT: requires results from tool_a, tool_b, and tool_c
   * - REFUND_ESCALATION_PROMPT: requires a refund to be issued
   * - AML_TRANSFER_PROMPT: requires a transfer of funds to be made
   */
  return runQuery(CROSS_SOURCE_PROMPT);
}

/**
 * CLI entry for the Claude Agent SDK hooks exercise.
 *
 * Resets session state, runs {@link verifyNormalisedCrossSource} (cross-source
 * prompt requiring `tool_a` / `tool_b` / `tool_c`), and prints the model result
 * plus session. Demonstrates:
 * 1. Heterogeneous MCP tool payloads (dates/statuses)
 * 2. PostToolUse normalisation → ISO 8601 + English statuses
 * 3. PreToolUse: block `process_refund` when amount &gt; $500 → escalate
 * 4. PreToolUse: block `transfer_funds` until `aml_check` passed this session
 *
 * @example
 * ```ts
 * await agentSdkHooks();
 * ```
 */
export async function agentSdkHooks(): Promise<void> {
  resetSession();
  const { result, session: s } = await verifyNormalisedCrossSource();
  console.log("--- cross-source (normalised) ---");
  console.log(result);
  console.log("--- session ---");
  console.log(s);
}
