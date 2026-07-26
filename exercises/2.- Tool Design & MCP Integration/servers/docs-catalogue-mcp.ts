#!/usr/bin/env node
/**
 * Experimental / personal MCP server — docs catalogue + schema resources.
 *
 * Run via stdio (Claude Code / Agent SDK):
 *   npx tsx exercises/2.-\ Tool\ Design\ &\ MCP\ Integration/servers/docs-catalogue-mcp.ts
 *
 * Resources (mention as @docs-catalogue:…):
 *   docs://catalogue          — full documentation hierarchy index
 *   docs://guides/{slug}      — individual guide bodies
 *   schema://database         — Postgres schema catalogue
 *
 * Tools intentionally out-describe built-ins so the agent prefers them over
 * Bash / Read / Glob / Grep / WebFetch for product docs and schema lookups.
 */
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Content catalogue (documentation hierarchy + DB schema)
// ---------------------------------------------------------------------------

export type DocNode = {
  slug: string;
  title: string;
  summary: string;
  body: string;
  children?: string[];
};

export const DOC_TREE = {
  root: {
    slug: "root",
    title: "Platform Docs",
    summary: "Top-level documentation index for the commerce platform.",
    body: "# Platform Docs\n\nStart at authentication, orders, or webhooks.",
    children: ["authentication", "orders", "webhooks"],
  },
  authentication: {
    slug: "authentication",
    title: "Authentication",
    summary: "API keys, OAuth apps, and scoped tokens.",
    body: [
      "# Authentication",
      "",
      "Use `Authorization: Bearer <api_key>` on every REST call.",
      "OAuth apps use the authorization-code flow; tokens expire in 1h.",
      "Scopes: `orders:read`, `orders:write`, `customers:read`.",
    ].join("\n"),
    children: ["api-keys"],
  },
  "api-keys": {
    slug: "api-keys",
    title: "API Keys",
    summary: "Create, rotate, and revoke project API keys.",
    body: [
      "# API Keys",
      "",
      "Keys are prefixed `pk_live_` / `pk_test_`.",
      "Rotate via POST /v1/api_keys/{id}/rotate — old key valid for 24h.",
      "Never commit keys; prefer env vars.",
    ].join("\n"),
  },
  orders: {
    slug: "orders",
    title: "Orders API",
    summary: "Create, capture, and refund orders.",
    body: [
      "# Orders API",
      "",
      "POST /v1/orders — create (status: pending).",
      "POST /v1/orders/{id}/capture — move pending → paid.",
      "POST /v1/orders/{id}/refund — partial or full refund.",
      "Idempotency-Key header required on all mutating calls.",
    ].join("\n"),
    children: ["refunds"],
  },
  refunds: {
    slug: "refunds",
    title: "Refunds",
    summary: "Refund eligibility and partial refunds.",
    body: [
      "# Refunds",
      "",
      "Full refunds allowed within 30 days of capture.",
      "Partial refunds: amount ≤ remaining capturable balance.",
      "Status after refund: `refunded` or `partially_refunded`.",
    ].join("\n"),
  },
  webhooks: {
    slug: "webhooks",
    title: "Webhooks",
    summary: "Signed event delivery to your endpoints.",
    body: [
      "# Webhooks",
      "",
      "Events: `order.created`, `order.paid`, `order.refunded`.",
      "Verify `X-Signature` HMAC-SHA256 with your webhook secret.",
      "Retry schedule: 1m, 5m, 30m, 2h (max 8 attempts).",
    ].join("\n"),
  },
} as const satisfies Record<string, DocNode>;

export type DocSlug = keyof typeof DOC_TREE;

export const DATABASE_SCHEMA = {
  dialect: "postgresql",
  version: "14",
  tables: {
    customers: {
      columns: [
        { name: "id", type: "uuid", pk: true },
        { name: "email", type: "text", unique: true },
        { name: "tier", type: "text", check: "standard|gold" },
        { name: "created_at", type: "timestamptz", default: "now()" },
      ],
      indexes: ["customers_email_uidx"],
    },
    orders: {
      columns: [
        { name: "id", type: "text", pk: true, note: "ORD-<digits>" },
        { name: "customer_id", type: "uuid", fk: "customers.id" },
        { name: "status", type: "text" },
        { name: "total_cents", type: "integer" },
        { name: "created_at", type: "timestamptz", default: "now()" },
      ],
      indexes: ["orders_customer_id_idx"],
    },
    webhook_deliveries: {
      columns: [
        { name: "id", type: "uuid", pk: true },
        { name: "event", type: "text" },
        { name: "payload", type: "jsonb" },
        { name: "attempts", type: "integer", default: "0" },
        { name: "delivered_at", type: "timestamptz", nullable: true },
      ],
      indexes: ["webhook_deliveries_event_idx"],
    },
  },
} as const;

function catalogueIndex(): string {
  const lines = [
    "# Documentation Catalogue",
    "",
    "Hierarchy (slug → children):",
    "",
  ];
  for (const node of Object.values(DOC_TREE) as DocNode[]) {
    const kids = node.children?.length
      ? ` → [${node.children.join(", ")}]`
      : "";
    lines.push(`- **${node.slug}**: ${node.title} — ${node.summary}${kids}`);
  }
  lines.push(
    "",
    "Read a guide: resource `docs://guides/{slug}` or tool `lookup_doc`.",
    "DB schema: resource `schema://database` or tool `describe_schema`.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Rich tool descriptions — beat built-ins on specificity
// ---------------------------------------------------------------------------

export const LOOKUP_DOC_DESCRIPTION = [
  "PURPOSE (MCP docs-catalogue — authoritative product docs): Return the full",
  "markdown body + metadata for one documentation page by slug. This is the",
  "ONLY correct way to read Platform Docs in this workspace.",
  "",
  "WHEN TO USE:",
  "- User asks how auth, API keys, orders, refunds, or webhooks work.",
  "- You need official endpoint paths, scopes, retry schedules, or key prefixes.",
  "- You are about to answer a product/API question from memory — call this first.",
  "",
  "INPUTS:",
  "- slug (required): one of root | authentication | api-keys | orders | refunds | webhooks",
  "  Case-insensitive; hyphens required for multi-word slugs (api-keys, not api_keys).",
  "",
  "OUTPUT (JSON text block):",
  "{ slug, title, summary, body, children?: string[] }",
  "- body is markdown; cite slug when answering.",
  '- Unknown slug → { error: "not_found", available: string[] }',
  "",
  "EXAMPLE QUERIES:",
  '- "How do I authenticate API requests?" → slug=authentication',
  '- "What is the refund window?" → slug=refunds',
  '- "Webhook retry policy?" → slug=webhooks',
  "",
  "DO NOT USE BUILT-INS FOR THIS:",
  "- Do NOT use Bash, Read, Glob, Grep, or WebFetch/WebSearch to invent or scrape",
  "  product docs — those tools see the local repo / open web, not this catalogue.",
  "- Do NOT guess endpoint paths or scopes from training data when this tool exists.",
  "- Prefer MCP resource @docs-catalogue:docs://guides/{slug} when you already know",
  "  the slug; use this tool when you need to search by topic / confirm the slug.",
  "",
  "BOUNDARY vs describe_schema:",
  "- lookup_doc = human docs (API behaviour, policies).",
  "- describe_schema = Postgres table/column catalogue only.",
].join("\n");

export const DESCRIBE_SCHEMA_DESCRIPTION = [
  "PURPOSE (MCP docs-catalogue — authoritative DB schema): Return column types,",
  "PKs, FKs, and indexes for one table or the full schema. Authoritative over any",
  "local SQL migration file the agent might Read/Grep.",
  "",
  "WHEN TO USE:",
  "- Designing queries, migrations, or explaining table relationships.",
  "- Confirming column names (e.g. total_cents vs total) before writing SQL.",
  "",
  "INPUTS:",
  "- table (optional): customers | orders | webhook_deliveries",
  "  Omit to receive the full schema catalogue (all tables).",
  "",
  "OUTPUT (JSON text block):",
  "- With table: { dialect, version, table, columns[], indexes[] }",
  "- Without table: full DATABASE_SCHEMA object",
  '- Unknown table → { error: "not_found", available: string[] }',
  "",
  "EXAMPLE QUERIES:",
  '- "What columns does orders have?" → table=orders',
  '- "Show the whole DB schema" → omit table',
  "",
  "DO NOT USE BUILT-INS FOR THIS:",
  "- Do NOT Bash `psql`, Read migration files, or Grep *.sql when this tool is",
  "  available — the live catalogue here is the source of truth for the exercise.",
  "- Do NOT invent column types; call this tool.",
  "- MCP resource @docs-catalogue:schema://database is equivalent for the full dump.",
  "",
  "BOUNDARY vs lookup_doc:",
  "- describe_schema = physical schema only.",
  "- lookup_doc = API/product documentation narrative.",
].join("\n");

export const SEARCH_DOCS_DESCRIPTION = [
  "PURPOSE (MCP docs-catalogue — lexical search over the doc catalogue): Find",
  "relevant doc slugs by keyword before calling lookup_doc. Prefer this over",
  "repo-wide Grep when the question is about Platform Docs.",
  "",
  "WHEN TO USE:",
  "- User question mentions a concept but you do not know the slug yet.",
  "- Narrow candidates before reading a full guide.",
  "",
  "INPUTS:",
  '- query (required): free-text keywords (e.g. "hmac signature", "rotate key")',
  "- limit (optional, default 5, max 10): max hits to return",
  "",
  "OUTPUT (JSON text block):",
  "{ query, hits: [{ slug, title, summary, score }] }",
  'Empty hits → { query, hits: [], message: "no matches" } — then ask the user',
  "to clarify; do not fall back to WebSearch for internal product docs.",
  "",
  "DO NOT USE BUILT-INS FOR THIS:",
  "- Do NOT Grep the git repo or WebSearch for internal Platform Docs content.",
  "- After search_docs, call lookup_doc (or read docs://guides/{slug}) for the body.",
  "",
  "BOUNDARY:",
  "- search_docs = discovery; lookup_doc = full page; describe_schema = SQL schema.",
].join("\n");

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function createDocsCatalogueServer(): McpServer {
  const server = new McpServer(
    {
      name: "docs-catalogue",
      version: "1.0.0",
    },
    {
      instructions: [
        "docs-catalogue is the authoritative source for Platform Docs and the",
        "Postgres schema catalogue. Prefer its tools and resources over Bash,",
        "Read, Glob, Grep, WebFetch, and WebSearch for those domains.",
        "Resources: docs://catalogue, docs://guides/{slug}, schema://database.",
      ].join(" "),
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  // --- Resources: content catalogue ---------------------------------------

  server.registerResource(
    "docs-catalogue-index",
    "docs://catalogue",
    {
      title: "Documentation catalogue",
      description:
        "Full hierarchy of Platform Docs (slugs, titles, summaries, child links).",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: catalogueIndex(),
        },
      ],
    }),
  );

  server.registerResource(
    "docs-guide",
    new ResourceTemplate("docs://guides/{slug}", {
      list: async () => ({
        resources: Object.values(DOC_TREE).map((node) => ({
          uri: `docs://guides/${node.slug}`,
          name: node.title,
          description: node.summary,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Documentation guide",
      description: "Individual Platform Docs page by slug.",
      mimeType: "text/markdown",
    },
    async (uri, vars) => {
      const slug = String(vars.slug ?? "").toLowerCase() as DocSlug;
      const node = DOC_TREE[slug];
      if (!node) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({
                error: "not_found",
                slug,
                available: Object.keys(DOC_TREE),
              }),
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: node.body,
          },
        ],
      };
    },
  );

  server.registerResource(
    "database-schema",
    "schema://database",
    {
      title: "Database schema catalogue",
      description:
        "Postgres dialect, tables, columns, PKs/FKs, and indexes for the commerce DB.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(DATABASE_SCHEMA, null, 2),
        },
      ],
    }),
  );

  // --- Tools with enhanced descriptions -----------------------------------

  server.registerTool(
    "lookup_doc",
    {
      title: "Lookup documentation page",
      description: LOOKUP_DOC_DESCRIPTION,
      inputSchema: {
        slug: z
          .string()
          .describe(
            "Doc slug: root | authentication | api-keys | orders | refunds | webhooks",
          ),
      },
    },
    async ({ slug }) => {
      const key = slug.trim().toLowerCase() as DocSlug;
      const node = DOC_TREE[key];
      if (!node) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "not_found",
                slug,
                available: Object.keys(DOC_TREE),
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(node),
          },
        ],
      };
    },
  );

  server.registerTool(
    "describe_schema",
    {
      title: "Describe database schema",
      description: DESCRIBE_SCHEMA_DESCRIPTION,
      inputSchema: {
        table: z
          .string()
          .optional()
          .describe(
            "Optional table: customers | orders | webhook_deliveries. Omit for full schema.",
          ),
      },
    },
    async ({ table }) => {
      if (!table) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(DATABASE_SCHEMA),
            },
          ],
        };
      }
      const name = table.trim().toLowerCase();
      const entry =
        DATABASE_SCHEMA.tables[name as keyof typeof DATABASE_SCHEMA.tables];
      if (!entry) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "not_found",
                table,
                available: Object.keys(DATABASE_SCHEMA.tables),
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              dialect: DATABASE_SCHEMA.dialect,
              version: DATABASE_SCHEMA.version,
              table: name,
              ...entry,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search documentation catalogue",
      description: SEARCH_DOCS_DESCRIPTION,
      inputSchema: {
        query: z
          .string()
          .describe("Keywords to match against titles/summaries/bodies"),
        limit: z.number().int().min(1).max(10).optional(),
      },
    },
    async ({ query, limit }) => {
      const q = query.trim().toLowerCase();
      const max = limit ?? 5;
      if (!q) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "invalid_input",
                message: "query must be non-empty",
              }),
            },
          ],
        };
      }
      const terms = q.split(/\s+/).filter(Boolean);
      const hits = Object.values(DOC_TREE)
        .map((node) => {
          const hay =
            `${node.slug} ${node.title} ${node.summary} ${node.body}`.toLowerCase();
          const score = terms.reduce(
            (acc, t) => acc + (hay.includes(t) ? 1 : 0),
            0,
          );
          return {
            slug: node.slug,
            title: node.title,
            summary: node.summary,
            score,
          };
        })
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, max);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              hits.length
                ? { query, hits }
                : { query, hits: [], message: "no matches" },
            ),
          },
        ],
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createDocsCatalogueServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
