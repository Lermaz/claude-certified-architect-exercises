import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServerConfig, query } from "@anthropic-ai/claude-agent-sdk";

/**
 * mcp-server-integration.ts
 *
 * Exercise: project vs user MCP config, resources, and tool-description routing.
 *
 * 1. Project `.mcp.json` — community GitHub MCP (docker + `${GITHUB_TOKEN}`)
 * 2. User `~/.claude.json` — experimental docs-catalogue stdio server
 * 3. docs-catalogue exposes a content catalogue as MCP resources
 * 4. Tool descriptions explicitly outrank Bash/Read/Grep/WebFetch for docs/schema
 *
 * Config files (not invented here):
 *   - repo root `.mcp.json`
 *   - `~/.claude.json` → mcpServers["docs-catalogue"]
 *   - `servers/docs-catalogue-mcp.ts` (stdio process)
 */

const MODEL = "claude-opus-4-8";
const MCP_SERVER = "docs-catalogue";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_SERVER_SCRIPT = path.join(
  __dirname,
  "servers",
  "docs-catalogue-mcp.ts",
);

/** Stdio config for the experimental docs-catalogue server (same shape as ~/.claude.json). */
export const docsCatalogueMcpConfig = {
  command: "npx",
  args: ["tsx", DOCS_SERVER_SCRIPT],
} as const satisfies McpServerConfig;

/** Mirrors project `.mcp.json` github entry (env expansion happens in Claude Code). */
export const githubMcpConfig = {
  command: "docker",
  args: [
    "run",
    "-i",
    "--rm",
    "-e",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "ghcr.io/github/github-mcp-server",
  ],
  env: {
    // Claude Code expands ${GITHUB_TOKEN} in .mcp.json; here we pass the live env.
    GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? "",
  },
} as const;

const mcp = (name: string) => `mcp__${MCP_SERVER}__${name}`;

export const ALLOWED_TOOLS = [
  mcp("lookup_doc"),
  mcp("describe_schema"),
  mcp("search_docs"),
] as const;

/**
 * Tempting prompt: built-ins (Read/Grep/WebSearch) look plausible, but the
 * enhanced MCP descriptions should win for Platform Docs + schema.
 */
export const CATALOGUE_PROMPT = [
  "Using only the docs-catalogue MCP tools/resources (not Bash, Read, Grep, or web search):",
  "1) Find the official webhook signature verification guidance.",
  "2) List the columns on the orders table from the schema catalogue.",
  "Cite the doc slug and the schema resource/tool you used.",
].join(" ");

export const SYSTEM_PROMPT = [
  "You are integrating with MCP servers configured for this project.",
  "For Platform Docs and the commerce Postgres schema, prefer docs-catalogue",
  "tools and resources over any built-in filesystem or web tools.",
  "Resource URIs: docs://catalogue, docs://guides/{slug}, schema://database.",
].join("\n");

export type ToolCallTrace = {
  toolName: string;
  input: unknown;
};

export type McpIntegrationRun = {
  result: string;
  toolCalls: ToolCallTrace[];
  mcpServers: unknown;
};

async function runQuery(prompt: string): Promise<McpIntegrationRun> {
  let finalResult = "";
  const toolCalls: ToolCallTrace[] = [];
  let mcpServers: unknown = null;

  for await (const message of query({
    prompt,
    options: {
      model: MODEL,
      thinking: { type: "adaptive" },
      systemPrompt: SYSTEM_PROMPT,
      // In-process exercise: wire the experimental server explicitly.
      // Project GitHub lives in `.mcp.json` (settingSources: ["project"]).
      mcpServers: {
        [MCP_SERVER]: docsCatalogueMcpConfig,
      },
      settingSources: ["project", "user"],
      allowedTools: [...ALLOWED_TOOLS],
      // Deny common built-ins so description quality is what steers routing
      // when both surfaces are present in a full Claude Code session.
      disallowedTools: [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
      ],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      mcpServers = message.mcp_servers;
    }
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

  return { result: finalResult, toolCalls, mcpServers };
}

/**
 * Print config pointers, then run the catalogue routing scenario.
 */
export async function mcpServerIntegration(): Promise<void> {
  console.log("--- MCP config surfaces ---");
  console.log({
    project: ".mcp.json → github (docker + ${GITHUB_TOKEN})",
    user: "~/.claude.json → docs-catalogue (stdio)",
    serverScript: DOCS_SERVER_SCRIPT,
    resources: [
      "docs://catalogue",
      "docs://guides/{slug}",
      "schema://database",
    ],
  });

  console.log("--- prompt ---");
  console.log(CATALOGUE_PROMPT);

  const { result, toolCalls, mcpServers } = await runQuery(CATALOGUE_PROMPT);

  console.log("--- mcp servers (init) ---");
  console.log(JSON.stringify(mcpServers, null, 2));
  console.log("--- tool calls ---");
  console.log(JSON.stringify(toolCalls, null, 2));
  console.log("--- model result ---");
  console.log(result);
}
