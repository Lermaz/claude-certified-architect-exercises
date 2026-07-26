import {
  query,
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * tool-interface-design.ts
 *
 * Exercise: precise MCP tool descriptions.
 *
 * Each tool description covers:
 *   purpose · expected inputs/formats · example queries · edge cases ·
 *   explicit boundaries against the sibling tool
 *
 * Contrast: vague one-liners like "Retrieves customer information" leave the
 * model guessing which tool owns which identifier.
 */

const MODEL = "claude-opus-4-8";
const MCP_SERVER = "commerce";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Customer = {
  customer_id: string;
  email: string;
  name: string;
  tier: "standard" | "gold";
  verified: boolean;
};

type Order = {
  order_id: string;
  customer_id: string;
  status: "pending" | "shipped" | "delivered" | "returned";
  total: number;
  items: string[];
};

const CUSTOMERS = {
  "cust-1001": {
    customer_id: "cust-1001",
    email: "alice@example.com",
    name: "Alice Nguyen",
    tier: "gold",
    verified: true,
  },
  "cust-1002": {
    customer_id: "cust-1002",
    email: "bob@example.com",
    name: "Bob Chen",
    tier: "standard",
    verified: false,
  },
} as const satisfies Record<string, Customer>;

const ORDERS = {
  "ORD-1001": {
    order_id: "ORD-1001",
    customer_id: "cust-1001",
    status: "delivered",
    total: 149.99,
    items: ["wireless-headphones", "usb-c-cable"],
  },
  "ORD-2002": {
    order_id: "ORD-2002",
    customer_id: "cust-1002",
    status: "shipped",
    total: 49.0,
    items: ["phone-case"],
  },
} as const satisfies Record<string, Order>;

function mcpJson(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

// ---------------------------------------------------------------------------
// Precise MCP tools
// ---------------------------------------------------------------------------

export const GET_CUSTOMER_DESCRIPTION = [
  "PURPOSE: Resolve a customer identity and return account profile fields only",
  "(customer_id, email, name, tier, verified). Use when the user asks who someone",
  "is, whether an account exists, loyalty/tier, or verification status.",
  "",
  "INPUTS (provide exactly one):",
  "- email: RFC 5322-ish address, lowercase preferred — e.g. alice@example.com",
  "- customer_id: id shaped cust-<digits> — e.g. cust-1001",
  "Do not pass both; if both are present, email wins.",
  "",
  "EXAMPLE QUERIES that should call this tool:",
  '- "Look up customer john@example.com"',
  '- "What loyalty tier is cust-1001?"',
  '- "Verify the customer account status for alice@example.com"',
  '- "Find the account for bob@example.com"',
  "",
  "EDGE CASES:",
  '- Unknown email/id → { error: "not_found" } (do not invent a customer).',
  "- Display names / phone numbers are NOT valid inputs — ask for email or customer_id.",
  '- Partial emails ("alice@") are invalid; require a full address.',
  "- This tool never returns orders, tracking, refunds, or line items.",
  "",
  "BOUNDARY vs lookup_order:",
  "- Use get_customer for people/accounts (email, customer_id, tier, verified).",
  "- Do NOT use get_customer for order numbers (ORD-*), package status, tracking,",
  "  refund eligibility, or purchase contents — call lookup_order instead.",
  "- If the user mentions both an email and an order id, call BOTH tools",
  "  (get_customer for the email, lookup_order for the order id).",
].join("\n");

export const LOOKUP_ORDER_DESCRIPTION = [
  "PURPOSE: Fetch a single commerce order by order_id and return order fields only",
  "(order_id, customer_id, status, total, items). Use for purchase status, tracking,",
  "refund eligibility questions that need order state, or line-item contents.",
  "",
  "INPUTS (required):",
  "- order_id: string shaped ORD-<digits>, case-insensitive — e.g. ORD-1001 or ord-1001",
  "Optional leading '#' is stripped (\"#12345\" is NOT valid here — must be ORD-prefixed).",
  "",
  "EXAMPLE QUERIES that should call this tool:",
  '- "What is the status of order ORD-1001?"',
  '- "Where is my package for ORD-2002?"',
  '- "Is order ORD-1001 eligible for a refund?"',
  '- "I need details on order ORD-1001"',
  '- "When will ORD-2002 arrive?" (returns status; ETA is not in the payload)',
  "",
  "EDGE CASES:",
  '- Unknown order_id → { error: "not_found" } (do not invent an order).',
  "- Bare numeric ids (#12345, 12345) are invalid — require ORD-<digits>.",
  "- customer_id / email / product SKU are NOT valid order_id values.",
  "- Does not list all orders for a customer — only one order_id at a time.",
  "- Does not return customer profile fields (name, tier, verified).",
  "",
  "BOUNDARY vs get_customer:",
  "- Use lookup_order for purchases/shipments (order_id, status, total, items).",
  "- Do NOT use lookup_order to resolve an email, phone, name, or loyalty tier —",
  "  call get_customer instead.",
  "- If you only have an email and need orders, get_customer first to obtain",
  "  customer_id; this tool still requires a concrete order_id (it does not",
  "  search by customer).",
  "- If the user mentions both an email and an order id, call BOTH tools.",
].join("\n");

const getCustomer = tool(
  "get_customer",
  GET_CUSTOMER_DESCRIPTION,
  {
    email: z
      .email()
      .optional()
      .describe("Customer email, e.g. alice@example.com"),
    customer_id: z
      .string()
      .regex(/^cust-\d+$/i)
      .optional()
      .describe("Customer id, e.g. cust-1001"),
  },
  async (args) => {
    const email = args.email?.trim().toLowerCase();
    const customerId = args.customer_id?.trim().toLowerCase();

    if (!email && !customerId) {
      return mcpJson({
        error: "invalid_input",
        message: "Provide email or customer_id",
      });
    }

    const customer =
      Object.values(CUSTOMERS).find((c) =>
        email
          ? c.email.toLowerCase() === email
          : c.customer_id.toLowerCase() === customerId,
      ) ?? null;

    if (!customer) {
      return mcpJson({
        error: "not_found",
        email: args.email ?? null,
        customer_id: args.customer_id ?? null,
      });
    }
    return mcpJson(customer);
  },
);

const lookupOrder = tool(
  "lookup_order",
  LOOKUP_ORDER_DESCRIPTION,
  {
    order_id: z
      .string()
      .describe(
        "Order id ORD-<digits>, e.g. ORD-1001 (optional leading # stripped)",
      ),
  },
  async (args) => {
    const raw = args.order_id.trim().replace(/^#/, "");
    const normalized = raw.toUpperCase();

    if (!/^ORD-\d+$/.test(normalized)) {
      return mcpJson({
        error: "invalid_input",
        message: "order_id must match ORD-<digits>",
        order_id: args.order_id,
      });
    }

    const order =
      Object.values(ORDERS).find(
        (o) => o.order_id.toUpperCase() === normalized,
      ) ?? null;

    if (!order) {
      return mcpJson({ error: "not_found", order_id: normalized });
    }
    return mcpJson(order);
  },
);

export const commerceServer = createSdkMcpServer({
  name: MCP_SERVER,
  version: "1.0.0",
  alwaysLoad: true,
  tools: [getCustomer, lookupOrder],
});

const mcp = (name: string) => `mcp__${MCP_SERVER}__${name}`;

export const ALLOWED_TOOLS = [
  mcp("get_customer"),
  mcp("lookup_order"),
] as const;

/** Exported so tests can assert on the precise copy. */
export const TOOL_DESCRIPTIONS = {
  get_customer: GET_CUSTOMER_DESCRIPTION,
  lookup_order: LOOKUP_ORDER_DESCRIPTION,
} as const;

// ---------------------------------------------------------------------------
// Prompt that requires correct tool routing
// ---------------------------------------------------------------------------

/**
 * Mixed identity signals — precise descriptions should route email → get_customer
 * and ORD-* → lookup_order (both tools, not one).
 */
export const PRECISE_INTERFACE_PROMPT = [
  "I need details on alice@example.com and their purchase ORD-1001.",
  "Use the available tools. Report what you found for both the customer and the order.",
].join(" ");

/**
 * Replaces the Claude Code preset — coding-harness keyword triggers would
 * compete with (and can override) the tool BOUNDARY sections.
 */
export const COMMERCE_SYSTEM_PROMPT = [
  "You are a commerce support agent.",
  "Choose tools solely from each tool's purpose, inputs, edge cases, and BOUNDARY sections.",
  "Do not invent order_ids or customer identifiers. Ask when inputs are missing or invalid.",
  "Do not use coding, filesystem, or git workflows — only the provided commerce tools.",
].join("\n");

export type ToolCallTrace = {
  toolName: string;
  input: unknown;
};

export type PreciseInterfaceRun = {
  result: string;
  toolCalls: ToolCallTrace[];
};

async function runQuery(prompt: string): Promise<PreciseInterfaceRun> {
  let finalResult = "";
  const toolCalls: ToolCallTrace[] = [];

  for await (const message of query({
    prompt,
    options: {
      model: MODEL,
      thinking: { type: "adaptive" },
      systemPrompt: COMMERCE_SYSTEM_PROMPT,
      mcpServers: { [MCP_SERVER]: commerceServer },
      allowedTools: [...ALLOWED_TOOLS],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          toolCalls.push({ toolName: block.name, input: block.input });
        }
      }
    }
    if (message.type === "result" && message.subtype === "success") {
      finalResult = message.result;
    }
  }

  return { result: finalResult, toolCalls };
}

/**
 * Run the precise-description scenario and print tool selection for review.
 */
export async function toolInterfaceDesign(): Promise<void> {
  console.log("--- precise tool descriptions ---");
  console.log({
    get_customer: GET_CUSTOMER_DESCRIPTION.slice(0, 120) + "…",
    lookup_order: LOOKUP_ORDER_DESCRIPTION.slice(0, 120) + "…",
  });
  console.log("--- prompt ---");
  console.log(PRECISE_INTERFACE_PROMPT);

  const { result, toolCalls } = await runQuery(PRECISE_INTERFACE_PROMPT);

  console.log("--- tool calls ---");
  console.log(JSON.stringify(toolCalls, null, 2));
  console.log("--- model result ---");
  console.log(result);
}
