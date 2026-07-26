import {
  query,
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * structured-error-responses.ts
 *
 * Exercise: MCP tool errors that agents can recover from.
 *
 * - Four errorCategory values → four recovery paths
 * - isError + structured metadata (errorCategory, isRetryable, description)
 * - Valid empty result (isError: false, resultCount: 0) ≠ access failure
 * - Host-side agent loop that branches on the metadata
 */

const MODEL = "claude-opus-4-8";
const MCP_SERVER = "customers";
const MAX_TRANSIENT_RETRIES = 3;
const REFUND_AUTO_LIMIT = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const ERROR_CATEGORIES = [
  "transient",
  "validation",
  "business",
  "permission",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export type FailureMode = ErrorCategory | "none" | "empty";

/** Payload Claude reads inside the tool_result text block when isError: true. */
export type StructuredErrorMeta = {
  errorCategory: ErrorCategory;
  isRetryable: boolean;
  description: string;
};

type Customer = {
  customer_id: string;
  email: string;
  name: string;
  tier: "standard" | "gold";
};

type LookupSuccess = {
  resultCount: number;
  customers: Customer[];
  message?: string;
};

type ParsedToolResult =
  | { ok: true; isError: false; data: LookupSuccess }
  | { ok: true; isError: true; error: StructuredErrorMeta }
  | { ok: false; reason: string };

export type RecoveryAction =
  | { kind: "retry"; attempt: number; backoffMs: number; description: string }
  | { kind: "fix_input"; from: string; to: string; description: string }
  | { kind: "escalate"; description: string }
  | { kind: "request_credentials"; description: string }
  | { kind: "accept_empty"; message: string }
  | { kind: "succeed"; customers: Customer[] }
  | { kind: "give_up"; description: string };

export type AgentLoopResult = {
  final: RecoveryAction;
  trace: RecoveryAction[];
  toolCalls: number;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CUSTOMERS = {
  "cust-1001": {
    customer_id: "cust-1001",
    email: "alice@example.com",
    name: "Alice Nguyen",
    tier: "gold",
  },
  "cust-1002": {
    customer_id: "cust-1002",
    email: "bob@example.com",
    name: "Bob Chen",
    tier: "standard",
  },
} as const satisfies Record<string, Customer>;

const CUSTOMER_ID_RE = /^cust-\d+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** How many consecutive transient failures remain before the mock "recovers". */
let transientFailBudget = 1;

export function resetTransientBudget(n = 1): void {
  transientFailBudget = n;
}

// ---------------------------------------------------------------------------
// Structured MCP responses
// ---------------------------------------------------------------------------

/**
 * Error envelope — metadata lives in the text JSON so any MCP client can
 * parse it (CallToolResult only guarantees content + isError).
 */
export function mcpError(
  category: ErrorCategory,
  retryable: boolean,
  description: string,
): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          errorCategory: category,
          isRetryable: retryable,
          description,
        } satisfies StructuredErrorMeta),
      },
    ],
  };
}

export function mcpSuccess(data: LookupSuccess): CallToolResult {
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

/** Valid empty result — NOT an error. Query ran; zero matches. */
export function mcpEmpty(queryLabel: string): CallToolResult {
  return mcpSuccess({
    resultCount: 0,
    customers: [],
    message: `No customer found matching '${queryLabel}'. The query executed successfully but returned no matches.`,
  });
}

export function parseToolResult(result: CallToolResult): ParsedToolResult {
  const block = result.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    return { ok: false, reason: "missing text content block" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(block.text);
  } catch {
    return { ok: false, reason: "content text is not JSON" };
  }

  if (result.isError) {
    const err = payload as Partial<StructuredErrorMeta>;
    if (
      !err.errorCategory ||
      typeof err.isRetryable !== "boolean" ||
      typeof err.description !== "string"
    ) {
      return { ok: false, reason: "malformed structured error metadata" };
    }
    return {
      ok: true,
      isError: true,
      error: {
        errorCategory: err.errorCategory,
        isRetryable: err.isRetryable,
        description: err.description,
      },
    };
  }

  const data = payload as LookupSuccess;
  if (typeof data.resultCount !== "number" || !Array.isArray(data.customers)) {
    return { ok: false, reason: "malformed success payload" };
  }
  return { ok: true, isError: false, data };
}

// ---------------------------------------------------------------------------
// Mock customer lookup (core logic shared by MCP tool + agent loop)
// ---------------------------------------------------------------------------

export type CustomerLookupArgs = {
  customer_id?: string;
  email?: string;
  /** Force a simulated failure for demos / tests. */
  failure_mode?: FailureMode;
  /** When failure_mode=business, amount used to illustrate the policy breach. */
  refund_amount?: number;
};

export function customerLookupCore(args: CustomerLookupArgs): CallToolResult {
  const mode = args.failure_mode ?? "none";

  // --- Forced / simulated failure modes ------------------------------------
  if (mode === "transient") {
    if (transientFailBudget > 0) {
      transientFailBudget -= 1;
      return mcpError(
        "transient",
        true,
        "Connection to the customer database timed out after 5 seconds. The query did not execute. Retry after a brief delay.",
      );
    }
    // Budget exhausted → fall through and run the real query (DB "recovered").
  }

  if (mode === "permission") {
    return mcpError(
      "permission",
      false,
      "The current service account does not have permission to access customer PII. Request elevated credentials with customers:read scope.",
    );
  }

  if (mode === "business") {
    const amount = args.refund_amount ?? 750;
    return mcpError(
      "business",
      false,
      `Refund amount of $${amount} exceeds the $${REFUND_AUTO_LIMIT} automatic refund limit. Escalate to a human agent with the refund details — do not retry.`,
    );
  }

  if (mode === "empty") {
    const label = args.email ?? args.customer_id ?? "(no identifier)";
    return mcpEmpty(label);
  }

  // --- Validation (natural + forced) ---------------------------------------
  const rawId = args.customer_id?.trim();
  const rawEmail = args.email?.trim().toLowerCase();

  if (mode === "validation" || (rawId !== undefined && !CUSTOMER_ID_RE.test(rawId))) {
    const received = rawId ?? "(missing)";
    return mcpError(
      "validation",
      true,
      `customer_id must match cust-<digits> (e.g. cust-1001). Received: '${received}'. Reformat and retry.`,
    );
  }

  if (rawEmail !== undefined && !EMAIL_RE.test(rawEmail)) {
    return mcpError(
      "validation",
      true,
      `email must be a valid address (e.g. alice@example.com). Received: '${rawEmail}'. Fix the format and retry.`,
    );
  }

  if (!rawId && !rawEmail) {
    return mcpError(
      "validation",
      true,
      "Provide customer_id (cust-<digits>) or email. Received neither. Add a valid identifier and retry.",
    );
  }

  // --- Happy path / valid empty --------------------------------------------
  const matches = Object.values(CUSTOMERS).filter((c) =>
    rawEmail
      ? c.email.toLowerCase() === rawEmail
      : c.customer_id.toLowerCase() === rawId!.toLowerCase(),
  );

  if (matches.length === 0) {
    return mcpEmpty(rawEmail ?? rawId!);
  }

  return mcpSuccess({ resultCount: matches.length, customers: matches });
}

// ---------------------------------------------------------------------------
// MCP tool + server
// ---------------------------------------------------------------------------

export const CUSTOMER_LOOKUP_DESCRIPTION = [
  "PURPOSE: Look up a customer in the mock customer database by customer_id or email.",
  "Returns profile fields (customer_id, email, name, tier).",
  "",
  "INPUTS:",
  "- customer_id: cust-<digits> — e.g. cust-1001",
  "- email: full address — e.g. alice@example.com",
  "- failure_mode (optional, demos): none | transient | validation | business | permission | empty",
  "- refund_amount (optional): used when failure_mode=business to describe the policy breach",
  "",
  "ERRORS (isError: true) include JSON metadata:",
  "{ errorCategory, isRetryable, description }",
  "Categories: transient (retry), validation (fix input), business (escalate), permission (request credentials).",
  "",
  "EMPTY RESULT: isError: false with resultCount: 0 means the query succeeded and found nothing — do NOT retry.",
].join("\n");

const customerLookup = tool(
  "customer_lookup",
  CUSTOMER_LOOKUP_DESCRIPTION,
  {
    customer_id: z
      .string()
      .optional()
      .describe("Customer id, e.g. cust-1001"),
    email: z.email().optional().describe("Customer email"),
    failure_mode: z
      .enum(["none", "transient", "validation", "business", "permission", "empty"])
      .optional()
      .describe("Simulate a failure mode for demos"),
    refund_amount: z
      .number()
      .optional()
      .describe("Refund amount when failure_mode=business"),
  },
  async (args) => customerLookupCore(args),
);

export const customersServer = createSdkMcpServer({
  name: MCP_SERVER,
  version: "1.0.0",
  alwaysLoad: true,
  tools: [customerLookup],
});

const mcp = (name: string) => `mcp__${MCP_SERVER}__${name}`;

export const ALLOWED_TOOLS = [mcp("customer_lookup")] as const;

// ---------------------------------------------------------------------------
// Recovery helpers (host-side agent loop)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Naive cust-id repair: strip junk, ensure cust- prefix + digits. */
export function fixCustomerId(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return `cust-${digits}`;
}

function backoffMs(attempt: number): number {
  // attempt 0 → 50ms (demo-friendly; production would use seconds + jitter)
  return 50 * 2 ** attempt;
}

/**
 * Host-side agent loop: call customer_lookup, parse structured error metadata,
 * take the category-appropriate action.
 *
 *   transient  → retry with exponential backoff (clears failure_mode after budget)
 *   validation → reformats customer_id and retries once
 *   business   → escalate (no retry)
 *   permission → request elevated credentials (no retry)
 *   empty ok   → accept (resultCount: 0, isError: false)
 */
export async function structuredErrorAgentLoop(
  initial: CustomerLookupArgs,
  opts: { maxTransientRetries?: number; sleepFn?: typeof sleep } = {},
): Promise<AgentLoopResult> {
  const maxRetries = opts.maxTransientRetries ?? MAX_TRANSIENT_RETRIES;
  const wait = opts.sleepFn ?? sleep;

  let args: CustomerLookupArgs = { ...initial };
  let transientAttempts = 0;
  let validationFixes = 0;
  let toolCalls = 0;
  const trace: RecoveryAction[] = [];

  while (true) {
    toolCalls += 1;
    const raw = customerLookupCore(args);
    const parsed = parseToolResult(raw);

    if (!parsed.ok) {
      const giveUp: RecoveryAction = {
        kind: "give_up",
        description: `Unparseable tool result: ${parsed.reason}`,
      };
      trace.push(giveUp);
      return { final: giveUp, trace, toolCalls };
    }

    if (!parsed.isError) {
      if (parsed.data.resultCount === 0) {
        const action: RecoveryAction = {
          kind: "accept_empty",
          message: parsed.data.message ?? "No matches (valid empty result).",
        };
        trace.push(action);
        return { final: action, trace, toolCalls };
      }
      const action: RecoveryAction = {
        kind: "succeed",
        customers: parsed.data.customers,
      };
      trace.push(action);
      return { final: action, trace, toolCalls };
    }

    const { error } = parsed;

    switch (error.errorCategory) {
      case "transient": {
        if (!error.isRetryable || transientAttempts >= maxRetries) {
          const giveUp: RecoveryAction = {
            kind: "give_up",
            description: `Transient retries exhausted (${transientAttempts}/${maxRetries}): ${error.description}`,
          };
          trace.push(giveUp);
          return { final: giveUp, trace, toolCalls };
        }
        const delay = backoffMs(transientAttempts);
        const action: RecoveryAction = {
          kind: "retry",
          attempt: transientAttempts + 1,
          backoffMs: delay,
          description: error.description,
        };
        trace.push(action);
        await wait(delay);
        transientAttempts += 1;
        // Drop the simulated failure so the next call hits the recovered DB.
        args = { ...args, failure_mode: "none" };
        continue;
      }

      case "validation": {
        if (validationFixes > 0 || !args.customer_id) {
          const giveUp: RecoveryAction = {
            kind: "give_up",
            description: `Cannot auto-fix validation error: ${error.description}`,
          };
          trace.push(giveUp);
          return { final: giveUp, trace, toolCalls };
        }
        const fixed = fixCustomerId(args.customer_id);
        if (!fixed) {
          const giveUp: RecoveryAction = {
            kind: "give_up",
            description: `No digits to repair in customer_id='${args.customer_id}'`,
          };
          trace.push(giveUp);
          return { final: giveUp, trace, toolCalls };
        }
        const action: RecoveryAction = {
          kind: "fix_input",
          from: args.customer_id,
          to: fixed,
          description: error.description,
        };
        trace.push(action);
        validationFixes += 1;
        args = { ...args, customer_id: fixed, failure_mode: "none" };
        continue;
      }

      case "business": {
        const action: RecoveryAction = {
          kind: "escalate",
          description: error.description,
        };
        trace.push(action);
        return { final: action, trace, toolCalls };
      }

      case "permission": {
        const action: RecoveryAction = {
          kind: "request_credentials",
          description: error.description,
        };
        trace.push(action);
        return { final: action, trace, toolCalls };
      }

      default: {
        const _exhaustive: never = error.errorCategory;
        const giveUp: RecoveryAction = {
          kind: "give_up",
          description: `Unknown errorCategory: ${_exhaustive}`,
        };
        trace.push(giveUp);
        return { final: giveUp, trace, toolCalls };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Claude-driven demo (optional — model sees isError + metadata via MCP)
// ---------------------------------------------------------------------------

export const ERROR_AWARE_SYSTEM_PROMPT = [
  "You are a customer-support agent with one tool: customer_lookup.",
  "When a tool returns isError: true, parse the JSON in the content text for",
  "errorCategory / isRetryable / description, then act:",
  "- transient + isRetryable → retry the same lookup (do not invent data)",
  "- validation → fix the identifier format and call again",
  "- business → escalate to a human; do NOT retry",
  "- permission → ask for elevated credentials; do NOT retry",
  "When isError: false and resultCount: 0, that is a valid empty result — do NOT retry.",
].join("\n");

async function runClaudeDemo(prompt: string): Promise<string> {
  let finalResult = "";
  for await (const message of query({
    prompt,
    options: {
      model: MODEL,
      thinking: { type: "adaptive" },
      systemPrompt: ERROR_AWARE_SYSTEM_PROMPT,
      mcpServers: { [MCP_SERVER]: customersServer },
      allowedTools: [...ALLOWED_TOOLS],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === "result" && message.subtype === "success") {
      finalResult = message.result;
    }
  }
  return finalResult;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function logScenario(title: string, result: AgentLoopResult): void {
  console.log(`\n=== ${title} ===`);
  console.log("trace:", JSON.stringify(result.trace, null, 2));
  console.log("final:", JSON.stringify(result.final, null, 2));
  console.log(`toolCalls: ${result.toolCalls}`);
}

/**
 * Demo all four error categories + valid empty vs access failure, then
 * optionally run one Claude-driven scenario.
 */
export async function structuredErrorResponses(): Promise<void> {
  console.log("--- structured error responses ---");

  // 1. Transient → retry until mock DB recovers
  resetTransientBudget(2);
  logScenario(
    "transient (retry)",
    await structuredErrorAgentLoop({
      customer_id: "cust-1001",
      failure_mode: "transient",
    }),
  );

  // 2. Validation → fix input (digits recoverable → cust-1001)
  logScenario(
    "validation (fix input)",
    await structuredErrorAgentLoop({
      customer_id: "customer-1001", // wrong shape; fixCustomerId → cust-1001
      failure_mode: "validation",
    }),
  );

  // 3. Business → escalate (no retry)
  logScenario(
    "business (escalate)",
    await structuredErrorAgentLoop({
      customer_id: "cust-1001",
      failure_mode: "business",
      refund_amount: 750,
    }),
  );

  // 4. Permission → request credentials
  logScenario(
    "permission (request credentials)",
    await structuredErrorAgentLoop({
      customer_id: "cust-1001",
      failure_mode: "permission",
    }),
  );

  // 5. Valid empty ≠ access failure
  logScenario(
    "valid empty (isError: false, resultCount: 0)",
    await structuredErrorAgentLoop({
      email: "nobody@example.com",
      failure_mode: "none",
    }),
  );

  resetTransientBudget(1);
  logScenario(
    "access failure (transient timeout)",
    await structuredErrorAgentLoop(
      { customer_id: "cust-1001", failure_mode: "transient" },
      // Force give-up by refusing to clear: budget stays, but we still clear
      // failure_mode on retry in the loop — so use a zero budget path via
      // maxTransientRetries: 0 to show the exhausted branch if needed.
      { maxTransientRetries: 3 },
    ),
  );

  // Side-by-side envelopes for the exam distinction
  console.log("\n=== envelope contrast ===");
  console.log("empty:", JSON.stringify(mcpEmpty("john@example.com"), null, 2));
  console.log(
    "access failure:",
    JSON.stringify(
      mcpError(
        "transient",
        true,
        "Connection to the customer database timed out after 5 seconds. The query did not execute.",
      ),
      null,
      2,
    ),
  );

  if (process.env.RUN_CLAUDE_DEMO === "1") {
    console.log("\n=== Claude-driven demo ===");
    const reply = await runClaudeDemo(
      "Look up customer_id 'cust-1001' with failure_mode=business and refund_amount=750. Act on the error metadata.",
    );
    console.log(reply);
  }
}
