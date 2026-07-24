import Anthropic from "@anthropic-ai/sdk";

/**
 * workflow-enforcement-and-handoff.ts
 *
 * Customer support agent with:
 *  1. Programmatic prerequisite gates (lock, not prompt)
 *  2. Multi-concern: decompose → investigate (shared verified ID) → synthesise
 *  3. Structured human handoffs (per-concern + multi-concern rollup)
 *
 * Tools: get_customer, lookup_order, process_refund, dispute_charge,
 *        update_shipping_address, escalate_to_human
 */

const MODEL = "claude-sonnet-5";
const MAX_ITERATIONS = 24;
const AUTOMATED_REFUND_LIMIT = 500;

const client = new Anthropic();

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

type Customer = {
  customer_id: string;
  name: string;
  email: string;
  verified: boolean;
  shipping_address: string;
};

type Order = {
  order_id: string;
  customer_id: string;
  total: number;
  status: "delivered" | "shipped" | "cancelled" | "refunded" | "return_pending";
  items: string[];
};

type BillCharge = {
  charge_id: string;
  customer_id: string;
  amount: number;
  description: string;
  disputed: boolean;
};

const CUSTOMERS: Record<string, Customer> = {
  "cust-1001": {
    customer_id: "cust-1001",
    name: "Jane Doe",
    email: "jane@example.com",
    verified: true,
    shipping_address: "42 Old Lane",
  },
  "cust-1002": {
    customer_id: "cust-1002",
    name: "Sam Rivera",
    email: "sam@example.com",
    verified: false,
    shipping_address: "9 Harbor Rd",
  },
};

const ORDERS: Record<string, Order> = {
  "ord-48219": {
    order_id: "ord-48219",
    customer_id: "cust-1001",
    total: 89.99,
    status: "delivered",
    items: ["Wireless mouse"],
  },
  "ord-99102": {
    order_id: "ord-99102",
    customer_id: "cust-1001",
    total: 649.0,
    status: "delivered",
    items: ["4K monitor"],
  },
  "ORD-789": {
    order_id: "ORD-789",
    customer_id: "cust-1001",
    total: 120.0,
    status: "delivered",
    items: ["Mechanical keyboard"],
  },
  "ord-22001": {
    order_id: "ord-22001",
    customer_id: "cust-1002",
    total: 42.5,
    status: "shipped",
    items: ["USB-C hub"],
  },
};

const CHARGES: BillCharge[] = [
  {
    charge_id: "chg-45",
    customer_id: "cust-1001",
    amount: 45.0,
    description: "Last bill — subscription addon",
    disputed: false,
  },
  {
    charge_id: "chg-12",
    customer_id: "cust-1001",
    amount: 12.0,
    description: "Last bill — shipping fee",
    disputed: false,
  },
];

// ---------------------------------------------------------------------------
// Concerns + session + handoff
// ---------------------------------------------------------------------------

export type ConcernType =
  | "return_order"
  | "dispute_charge"
  | "update_shipping"
  | "other";

export type ConcernStatus =
  | "pending"
  | "in_progress"
  | "resolved"
  | "escalated"
  | "blocked";

export type Concern = {
  id: string;
  type: ConcernType;
  description: string;
  status: ConcernStatus;
  details: Record<string, unknown>;
  result?: Record<string, unknown>;
};

export type HandoffSummary = {
  customer_id: string | null;
  summary: string;
  root_cause: string;
  recommended_action: string;
  partial_results: Record<string, unknown>;
  handoff_reason: string;
  concerns?: Concern[];
};

export type SessionState = {
  verified_customer_id: string | null;
  looked_up_order_id: string | null;
  steps_taken: string[];
  concerns: Concern[];
  handoffs: HandoffSummary[];
};

export function createSession(): SessionState {
  return {
    verified_customer_id: null,
    looked_up_order_id: null,
    steps_taken: [],
    concerns: [],
    handoffs: [],
  };
}

export function buildHandoffSummary(input: {
  session: SessionState;
  summary: string;
  root_cause: string;
  recommended_action: string;
  handoff_reason: string;
  partial_results?: Record<string, unknown>;
  concerns?: Concern[];
}): HandoffSummary {
  return {
    customer_id: input.session.verified_customer_id,
    summary: input.summary,
    root_cause: input.root_cause,
    recommended_action: input.recommended_action,
    partial_results: input.partial_results ?? {},
    handoff_reason: input.handoff_reason,
    concerns: input.concerns ?? [...input.session.concerns],
  };
}

/** Roll up unresolved / escalated concerns into one human-ready brief. */
export function buildMultiConcernHandoff(session: SessionState): HandoffSummary {
  const unresolved = session.concerns.filter((c) => c.status !== "resolved");
  const resolved = session.concerns.filter((c) => c.status === "resolved");

  return buildHandoffSummary({
    session,
    summary: [
      `Multi-concern ticket: ${session.concerns.length} issue(s).`,
      `Resolved: ${resolved.map((c) => c.id).join(", ") || "none"}.`,
      `Needs human: ${unresolved.map((c) => `${c.id} (${c.type})`).join(", ") || "none"}.`,
    ].join(" "),
    root_cause: unresolved
      .map((c) => `${c.id}: ${c.description}`)
      .join("; "),
    recommended_action: unresolved
      .map((c) => {
        switch (c.type) {
          case "return_order":
            return `Process return for order ${c.details.order_id ?? "?"}`;
          case "dispute_charge":
            return `Review charge dispute of $${c.details.amount ?? "?"}`;
          case "update_shipping":
            return `Confirm shipping address update to ${c.details.address ?? "?"}`;
          default:
            return `Handle: ${c.description}`;
        }
      })
      .join(" | "),
    handoff_reason:
      unresolved.length > 0
        ? "One or more concerns require human action"
        : "Explicit escalation",
    partial_results: {
      steps_taken: [...session.steps_taken],
      resolved: resolved.map((c) => ({ id: c.id, result: c.result })),
      unresolved: unresolved.map((c) => ({
        id: c.id,
        type: c.type,
        status: c.status,
        details: c.details,
        result: c.result,
      })),
    },
    concerns: [...session.concerns],
  });
}

function markConcern(
  session: SessionState,
  match: (c: Concern) => boolean,
  patch: Partial<Concern>,
): void {
  const c = session.concerns.find(match);
  if (!c) return;
  Object.assign(c, patch);
}

// ---------------------------------------------------------------------------
// Decompose (code-owned step — not left to prompt memory)
// ---------------------------------------------------------------------------

export async function decomposeConcerns(userMessage: string): Promise<Concern[]> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      "Decompose the customer message into distinct support concerns.",
      "Return ONLY JSON: { concerns: [{ type, description, details }] }",
      "type must be one of: return_order | dispute_charge | update_shipping | other",
      "details: for return_order include order_id; for dispute_charge include amount;",
      "for update_shipping include address. Omit unknown fields.",
    ].join(" "),
    messages: [{ role: "user", content: userMessage }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const parsed = parseJsonBlock<{
    concerns: Array<{
      type: ConcernType;
      description: string;
      details?: Record<string, unknown>;
    }>;
  }>(text);

  return (parsed.concerns ?? []).map((c, i) => ({
    id: `c${i + 1}`,
    type: c.type,
    description: c.description,
    status: "pending" as const,
    details: c.details ?? {},
  }));
}

function parseJsonBlock<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON in: ${text}`);
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

// ---------------------------------------------------------------------------
// Prerequisite gate (PreToolUse)
// ---------------------------------------------------------------------------

type GateResult =
  | { allow: true }
  | { allow: false; error: Record<string, unknown> };

const NEEDS_VERIFIED = new Set([
  "lookup_order",
  "process_refund",
  "dispute_charge",
  "update_shipping_address",
]);

export function preToolGate(
  name: string,
  input: Record<string, unknown>,
  session: SessionState,
): GateResult {
  if (NEEDS_VERIFIED.has(name) && !session.verified_customer_id) {
    return {
      allow: false,
      error: {
        status: "error",
        reason: "PREREQUISITE_VIOLATION",
        message: `${name} blocked: call get_customer and obtain a verified customer ID first.`,
        required_action: "call_get_customer",
      },
    };
  }

  if (name === "process_refund") {
    const customerId = String(input.customer_id ?? "");
    if (customerId !== session.verified_customer_id) {
      return {
        allow: false,
        error: {
          status: "error",
          reason: "CUSTOMER_MISMATCH",
          message: `customer_id ${customerId} does not match verified session ID ${session.verified_customer_id}.`,
          required_action: "use_verified_customer_id",
        },
      };
    }

    const amount = Number(input.amount);
    if (Number.isFinite(amount) && amount > AUTOMATED_REFUND_LIMIT) {
      return {
        allow: false,
        error: {
          status: "error",
          reason: "EXCEEDS_AUTOMATED_LIMIT",
          message: `Refund of $${amount} exceeds automated limit ($${AUTOMATED_REFUND_LIMIT}).`,
          required_action: "escalate_to_human",
          limit: AUTOMATED_REFUND_LIMIT,
        },
      };
    }
  }

  return { allow: true };
}

export function postToolHook(
  name: string,
  result: Record<string, unknown>,
  session: SessionState,
): void {
  if (
    name === "get_customer" &&
    result.verified === true &&
    result.customer_id
  ) {
    session.verified_customer_id = String(result.customer_id);
    session.steps_taken.push(`get_customer:${result.customer_id}:verified`);
  } else if (name === "get_customer") {
    session.steps_taken.push(
      `get_customer:${result.customer_id ?? "unknown"}:unverified`,
    );
  }

  if (name === "lookup_order" && result.order_id) {
    session.looked_up_order_id = String(result.order_id);
    session.steps_taken.push(`lookup_order:${result.order_id}`);
  }

  if (name === "process_refund" && result.status === "refunded") {
    session.steps_taken.push(
      `process_refund:${result.order_id}:$${result.amount}`,
    );
    markConcern(
      session,
      (c) =>
        c.type === "return_order" &&
        String(c.details.order_id ?? "").toLowerCase() ===
          String(result.order_id).toLowerCase(),
      { status: "resolved", result },
    );
  }

  if (name === "dispute_charge" && result.status === "disputed") {
    session.steps_taken.push(`dispute_charge:$${result.amount}`);
    markConcern(
      session,
      (c) =>
        c.type === "dispute_charge" &&
        Number(c.details.amount) === Number(result.amount),
      { status: "resolved", result },
    );
  }

  if (name === "update_shipping_address" && result.status === "updated") {
    session.steps_taken.push(`update_shipping:${result.new_address}`);
    markConcern(
      session,
      (c) => c.type === "update_shipping",
      { status: "resolved", result },
    );
  }

  if (name === "escalate_to_human" && result.handoff) {
    session.steps_taken.push("escalate_to_human");
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools: Anthropic.Tool[] = [
  {
    name: "get_customer",
    description:
      "Look up a customer by email or customer_id. Returns customer_id + verified. Call first.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Customer email" },
        customer_id: { type: "string", description: "Customer ID if known" },
      },
    },
  },
  {
    name: "lookup_order",
    description: "Look up order details by order_id. Requires verified customer.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Order ID to look up" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "process_refund",
    description: [
      "Refund an order (returns / damaged goods).",
      "Requires verified customer_id.",
      `Amounts over $${AUTOMATED_REFUND_LIMIT} are blocked — call escalate_to_human.`,
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
        order_id: { type: "string" },
        amount: { type: "number" },
        reason: { type: "string" },
      },
      required: ["customer_id", "order_id", "amount"],
    },
  },
  {
    name: "dispute_charge",
    description:
      "Open a billing dispute for a charge amount on the customer's last bill. Requires verified customer.",
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Charge amount to dispute" },
        reason: { type: "string", description: "Why the charge is disputed" },
      },
      required: ["amount"],
    },
  },
  {
    name: "update_shipping_address",
    description:
      "Update the verified customer's shipping address. Requires verified customer.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "New shipping address" },
      },
      required: ["address"],
    },
  },
  {
    name: "escalate_to_human",
    description: [
      "Escalate unresolved or out-of-policy concerns to a human.",
      "Builds a structured multi-concern handoff (customer ID, summary, root cause,",
      "recommended action, partial results). Call when a concern cannot be auto-resolved,",
      "or after finishing what you can and something remains for a human.",
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Why escalation is needed",
        },
        concern_ids: {
          type: "array",
          items: { type: "string" },
          description: "Concern IDs to mark escalated (omit = all unresolved)",
        },
      },
      required: ["reason"],
    },
  },
];

function executeTool(
  name: string,
  input: Record<string, unknown>,
  session: SessionState,
): Record<string, unknown> {
  switch (name) {
    case "get_customer": {
      const email = input.email ? String(input.email).toLowerCase() : null;
      const id = input.customer_id ? String(input.customer_id) : null;
      const customer =
        (id && CUSTOMERS[id]) ||
        Object.values(CUSTOMERS).find((c) => c.email.toLowerCase() === email);

      if (!customer) {
        return { status: "error", message: "Customer not found" };
      }
      return {
        customer_id: customer.customer_id,
        name: customer.name,
        email: customer.email,
        verified: customer.verified,
        shipping_address: customer.shipping_address,
      };
    }

    case "lookup_order": {
      const orderId = String(input.order_id ?? "");
      const order =
        ORDERS[orderId] ||
        ORDERS[orderId.toUpperCase()] ||
        Object.values(ORDERS).find(
          (o) => o.order_id.toLowerCase() === orderId.toLowerCase(),
        );
      if (!order) {
        return { status: "error", message: `Order ${orderId} not found` };
      }
      if (order.customer_id !== session.verified_customer_id) {
        return {
          status: "error",
          message: "Order does not belong to the verified customer",
        };
      }
      return { ...order };
    }

    case "process_refund": {
      const orderId = String(input.order_id ?? "");
      const amount = Number(input.amount);
      const order =
        ORDERS[orderId] ||
        Object.values(ORDERS).find(
          (o) => o.order_id.toLowerCase() === orderId.toLowerCase(),
        );
      if (!order) {
        return { status: "error", message: `Order ${orderId} not found` };
      }
      if (order.customer_id !== session.verified_customer_id) {
        return {
          status: "error",
          message: "Order does not belong to the verified customer",
        };
      }
      if (amount > order.total) {
        return {
          status: "error",
          message: `Refund $${amount} exceeds order total $${order.total}`,
        };
      }
      order.status = "refunded";
      return {
        status: "refunded",
        order_id: order.order_id,
        customer_id: session.verified_customer_id,
        amount,
        reason: input.reason ?? "customer_request",
      };
    }

    case "dispute_charge": {
      const amount = Number(input.amount);
      const charge = CHARGES.find(
        (c) =>
          c.customer_id === session.verified_customer_id &&
          c.amount === amount &&
          !c.disputed,
      );
      if (!charge) {
        return {
          status: "error",
          message: `No open charge of $${amount} on last bill for this customer`,
        };
      }
      charge.disputed = true;
      return {
        status: "disputed",
        charge_id: charge.charge_id,
        amount: charge.amount,
        description: charge.description,
        reason: input.reason ?? "customer_dispute",
      };
    }

    case "update_shipping_address": {
      const address = String(input.address ?? "").trim();
      if (!address) {
        return { status: "error", message: "address is required" };
      }
      const customer = CUSTOMERS[session.verified_customer_id!];
      const previous = customer.shipping_address;
      customer.shipping_address = address;
      return {
        status: "updated",
        customer_id: customer.customer_id,
        previous_address: previous,
        new_address: address,
      };
    }

    case "escalate_to_human": {
      const reason = String(input.reason ?? "escalation requested");
      const ids = Array.isArray(input.concern_ids)
        ? (input.concern_ids as string[])
        : null;

      for (const c of session.concerns) {
        if (c.status === "resolved") continue;
        if (ids && !ids.includes(c.id)) continue;
        c.status = "escalated";
      }

      const handoff = buildMultiConcernHandoff(session);
      handoff.handoff_reason = reason;
      session.handoffs.push(handoff);
      return { status: "escalated", handoff };
    }

    default:
      return { status: "error", message: `Unknown tool: ${name}` };
  }
}

function runTool(
  name: string,
  input: Record<string, unknown>,
  session: SessionState,
): string {
  const gate = preToolGate(name, input, session);
  if (!gate.allow) {
    if (gate.error.reason === "EXCEEDS_AUTOMATED_LIMIT") {
      markConcern(
        session,
        (c) =>
          c.type === "return_order" &&
          String(c.details.order_id ?? "").toLowerCase() ===
            String(input.order_id ?? "").toLowerCase(),
        {
          status: "escalated",
          result: gate.error,
        },
      );
      const handoff = buildHandoffSummary({
        session,
        summary: `Customer requested refund of $${input.amount} on order ${input.order_id}.`,
        root_cause: "Refund amount exceeds automated authorization limit",
        recommended_action: `Manually approve or deny refund of $${input.amount}`,
        handoff_reason: String(gate.error.message),
        partial_results: {
          order_id: input.order_id,
          amount: input.amount,
          steps_taken: [...session.steps_taken],
          concerns: session.concerns,
        },
      });
      session.handoffs.push(handoff);
      return JSON.stringify({ ...gate.error, handoff }, null, 2);
    }
    return JSON.stringify(gate.error, null, 2);
  }

  const result = executeTool(name, input, session);
  postToolHook(name, result, session);

  if (name === "get_customer" && result.verified === false) {
    for (const c of session.concerns) {
      if (c.status === "pending") c.status = "blocked";
    }
    const handoff = buildMultiConcernHandoff(session);
    handoff.handoff_reason = "Customer not verified";
    handoff.root_cause = "Identity verification failed";
    handoff.recommended_action =
      "Complete identity verification, then resume open concerns";
    session.handoffs.push(handoff);
    return JSON.stringify({ ...result, handoff }, null, 2);
  }

  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Agent loop — decompose first, then investigate, then synthesise
// ---------------------------------------------------------------------------

const SYSTEM = [
  "You are a customer support resolution agent.",
  "The user message has ALREADY been decomposed into concerns listed below.",
  "Workflow: (1) get_customer + verify, (2) investigate EACH concern with the right tool,",
  "prefer parallel tool calls in one turn when independent, (3) synthesise ONE unified reply",
  "covering every concern — never drop one.",
  "Tool map: return_order → lookup_order then process_refund;",
  "dispute_charge → dispute_charge; update_shipping → update_shipping_address;",
  "other / blocked / over-limit → escalate_to_human.",
  "If any concern remains unresolved after you do what you can, call escalate_to_human",
  "so the human gets a structured multi-concern handoff.",
  "Be concise and factual.",
].join(" ");

function concernsBrief(session: SessionState): string {
  if (session.concerns.length === 0) return "(no concerns extracted)";
  return session.concerns
    .map(
      (c) =>
        `- ${c.id} [${c.type}] status=${c.status}: ${c.description} details=${JSON.stringify(c.details)}`,
    )
    .join("\n");
}

async function agentLoop(
  userMessage: string,
  session: SessionState = createSession(),
): Promise<{ reply: string; session: SessionState }> {
  // --- 1. Decompose (code-owned) ---
  console.log("[decompose] extracting concerns...");
  session.concerns = await decomposeConcerns(userMessage);
  console.log("[decompose]", JSON.stringify(session.concerns, null, 2));

  const enrichedUser = [
    userMessage,
    "",
    "--- Decomposed concerns (investigate each, then one unified reply) ---",
    concernsBrief(session),
  ].join("\n");

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: enrichedUser },
  ];

  // --- 2. Investigate / act ---
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      tools,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      // --- 3. If anything still open, force multi-concern handoff ---
      const open = session.concerns.filter((c) => c.status !== "resolved");
      if (open.length > 0 && session.handoffs.length === 0) {
        const handoff = buildMultiConcernHandoff(session);
        session.handoffs.push(handoff);
        console.log("[handoff] auto-built for unresolved concerns");
      }

      const reply = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return { reply, session };
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        console.log(`[tool_use] ${block.name}(${JSON.stringify(block.input)})`);

        // Mark matching concerns in_progress
        for (const c of session.concerns) {
          if (c.status !== "pending") continue;
          if (
            (block.name === "process_refund" || block.name === "lookup_order") &&
            c.type === "return_order"
          ) {
            c.status = "in_progress";
          }
          if (block.name === "dispute_charge" && c.type === "dispute_charge") {
            c.status = "in_progress";
          }
          if (
            block.name === "update_shipping_address" &&
            c.type === "update_shipping"
          ) {
            c.status = "in_progress";
          }
        }

        const content = runTool(
          block.name,
          block.input as Record<string, unknown>,
          session,
        );
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content,
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    const reply = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { reply, session };
  }

  return { reply: "Safety cap reached", session };
}

/**
 * CLI entry for the workflow-enforcement / handoff exercise.
 *
 * Prompt from `process.argv` or a multi-concern default (return + dispute +
 * address update). Runs the support agent loop with:
 * - programmatic prerequisite gates (identity lock, refund limit)
 * - per-concern investigation sharing verified customer ID
 * - structured human handoffs (`escalate_to_human`) when automation can't proceed
 *
 * Prints agent reply and serialised {@link SessionState}.
 *
 * @example
 * ```ts
 * await workflowEnforcementAndHandoff();
 * // argv: "I'm jane@example.com — refund ORD-789 please"
 * ```
 */
export async function workflowEnforcementAndHandoff(): Promise<void> {
  const prompt =
    process.argv.slice(2).join(" ") ||
    "Hi, I'm jane@example.com. I need to return order ORD-789, dispute a charge of 45.00 on my last bill, and update my shipping address to 123 New Street.";

  const { reply, session } = await agentLoop(prompt);
  console.log("\n=== agent reply ===\n");
  console.log(reply);
  console.log("\n=== session ===\n");
  console.log(JSON.stringify(session, null, 2));
}
