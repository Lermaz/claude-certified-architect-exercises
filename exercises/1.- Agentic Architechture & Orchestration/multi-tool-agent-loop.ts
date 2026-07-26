import Anthropic from "@anthropic-ai/sdk";

/**
 * multi-tool-agent-loop.ts
 *
 * This module provides an agent loop that allows a Claude agent to use multiple tools within an iterative reasoning process.
 * It is intended as part of a set of exercises aimed at building and testing multi-tool agent orchestration logic.
 *
 * Overview:
 * - The agent can select from a set of available tools, each with its own schema, to answer user queries.
 * - The available tools provided here are:
 *   - "calculator": For evaluating mathematical expressions. This tool restricts evaluation to safe, arithmetic-only computations.
 *   - "web_search": For performing mock web searches (stub only, no actual search integration), intended to emulate information retrieval use cases.
 * - The logic is capped by MAX_ITERATIONS to prevent infinite loops.
 *
 * Key Components:
 * - `tools`: An array of tool definitions following Anthropic's Tool schema, each with a name, description, and input schema.
 * - `evaluateExpression`: A safe evaluator for arithmetic expressions using restricted regex matching.
 * - `client`: An Anthropic SDK client instance.
 *
 * Implementation Expectations:
 * - The main export/function in this file (to be implemented below) should implement a loop that:
 *     1. Accepts/receives agent queries or goals.
 *     2. Lets the agent "think" and select which tool(s) to use based on the task.
 *     3. Invokes the chosen tool(s), passing arguments according to the corresponding input_schema.
 *     4. Collects tool outputs, feeds results back into the agent for further reasoning or final answers.
 *     5. Repeats the process (bounded by MAX_ITERATIONS) until a solution or stopping condition is reached.
 *
 * Integration:
 * - This file is imported and called by `main.ts`, which simply invokes the exported multi-tool agent loop.
 * - Intended for educational/demo use rather than production.
 * 
 * Note:
 * - All tool execution, reasoning, and result formatting should heed the provided schemas and descriptions.
 * - Web searching is mocked; no real-world HTTP requests are performed.
 * - Calculator evaluations are performed with security-focused safeguards to prevent code injection.
 *
 * Usage:
 * - To run the loop, execute `npm start` or `tsx main.ts` as configured in package.json.
 * 
 * Dependencies:
 * - @anthropic-ai/claude-agent-sdk and @anthropic-ai/sdk for Claude agent integration
 * - zod (dependency declared in package.json) may be used for schema validation if needed in later exercises.
 */
const MAX_ITERATIONS = 20;

const client = new Anthropic();

const tools: Anthropic.Tool[] = [
  {
    name: "calculator",
    description: [
      "Evaluate a mathematical expression and return the numeric result.",
      "Use when you need arithmetic (sums, products, percentages as fractions, etc.).",
      "Do not use for looking up facts or searching the web.",
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description:
            "Math expression to evaluate, e.g. '(15 / 100) * 2400' or '2 + 2 * 3'",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "web_search",
    description: [
      "Search the web for information and return mock results (stub — no live search).",
      "Use for factual or current-events style queries that need external information.",
      "Do not use for pure arithmetic; use calculator instead.",
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string",
        },
      },
      required: ["query"],
    },
  },
];

/** Safe arithmetic eval — digits, operators, parens, whitespace, decimal points only. */
function evaluateExpression(expression: string): number {
  const trimmed = expression.trim();
  if (!trimmed) throw new Error("Expression is empty");
  if (!/^[\d+\-*/().\s]+$/.test(trimmed)) {
    throw new Error(
      `Unsupported expression "${expression}". Use numbers and + - * / ( ) only.`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- intentional, input is char-whitelisted
  const result = new Function(`"use strict"; return (${trimmed})`)();
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error(`Expression did not evaluate to a finite number: ${expression}`);
  }
  return result;
}

function webSearchStub(query: string) {
  const slug = query.trim().toLowerCase().replace(/\s+/g, "-");
  return [
    {
      title: `Overview of ${query}`,
      url: `https://example.com/articles/${encodeURIComponent(slug)}`,
      snippet: `Mock summary of key points about "${query}".`,
    },
    {
      title: `${query} — recent developments`,
      url: `https://news.example.com/search?q=${encodeURIComponent(query)}`,
      snippet: `Stub coverage of recent developments related to "${query}".`,
    },
    {
      title: `${query} FAQ`,
      url: "https://docs.example.com/faq",
      snippet: `Frequently asked questions about "${query}" (mock data).`,
    },
  ];
}

function runTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "calculator": {
      const expression = String(input.expression ?? "");
      const result = evaluateExpression(expression);
      return JSON.stringify({ expression, result });
    }
    case "web_search": {
      const query = String(input.query ?? "");
      return JSON.stringify({ query, results: webSearchStub(query) }, null, 2);
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

async function agentLoop(userMessage: string): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];
  let iterations = 0;

  while (true) {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      tools,
      messages,
    });

    if (iterations >= MAX_ITERATIONS) {
        console.warn("Safety cap reached");
        continue;
    }
    iterations++;

    if (response.stop_reason === "end_turn") {
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }

    if (response.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        console.log(`[tool_use] ${block.name}(${JSON.stringify(block.input)})`);

        let content: string;
        let isError = false;
        try {
          content = runTool(block.name, block.input as Record<string, unknown>);
        } catch (err) {
          isError = true;
          content = err instanceof Error ? err.message : String(err);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content,
          is_error: isError,
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // max_tokens / pause_turn / refusal — surface whatever text we have
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
}

/**
 * CLI entry for the multi-tool agent loop exercise.
 *
 * Reads the user prompt from `process.argv` (or a Bitcoin price + calc default),
 * runs an iterative Claude tool-use loop (`calculator` + mocked `web_search`),
 * and prints the final text reply. Bounded by `MAX_ITERATIONS`.
 *
 * @example
 * ```ts
 * await multiToolAgentLoop();
 * // argv: "Search for ETH and calculate 2 * 3000"
 * ```
 */
export async function multiToolAgentLoop(): Promise<void> {
  const prompt =
    process.argv.slice(2).join(" ") ||
    "Search for the current price of Bitcoin and calculate what 3.5 coins would cost.";

  const result = await agentLoop(prompt);
  console.log(result);
}
