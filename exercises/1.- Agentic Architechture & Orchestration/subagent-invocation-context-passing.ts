import { query, type AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

/**
 * subagent-invocation-context-passing.ts
 *
 * Coordinator + specialist subagents via the Claude Agent SDK.
 *
 * Critical: subagents start with a fresh context window. They do NOT inherit
 * the parent's conversation history. The ONLY user content they receive is the
 * Agent/Task tool's `prompt` string — so the coordinator must pack every path,
 * query, constraint, and prior decision into that brief.
 *
 * Pipeline: web-search ∥ document-analysis → synthesis (full structured payloads).
 */

const MODEL = "claude-sonnet-5";

// ---------------------------------------------------------------------------
// Structured result shapes (specialists → synthesis; metadata must survive)
// ---------------------------------------------------------------------------

export interface Finding {
  claim: string;
  source_url: string;
  document_name: string;
  page_number: number | null;
  confidence: "high" | "medium" | "low";
  retrieved_by: string;
}

interface SpecialistResults {
  findings: Finding[];
  query?: string;
  documents?: string[];
}

// ---------------------------------------------------------------------------
// Citation verification — every claim → source URL + page number
// ---------------------------------------------------------------------------

/** Pull candidate factual sentences / bullets from a synthesis report. */
export function extractClaims(report: string): string[] {
  return report
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim())
    .filter((line) => line.length >= 40)
    .filter((line) => !/^#{1,6}\s/.test(line)) // skip headings
    .filter((line) => !/^```/.test(line));
}

/**
 * Verify every claim in the report is attributable to a finding whose
 * source_url and/or page_number also appear in the report.
 * Returns claims that lack a matching citation.
 */
export function verifyCitations(report: string, findings: Finding[]): string[] {
  const uncited: string[] = [];
  const claims = extractClaims(report);
  for (const claim of claims) {
    const hasCitation = findings.some((f) => {
      // Claim must appear alongside its source (same shape as the exam snippet).
      if (!report.includes(claim)) return false;
      if (f.source_url && !report.includes(f.source_url)) return false;
      if (f.page_number != null) {
        const pageToken = String(f.page_number);
        const pageMentioned =
          report.includes(`p.${pageToken}`) ||
          report.includes(`p. ${pageToken}`) ||
          report.includes(`page ${pageToken}`) ||
          new RegExp(`\\b${pageToken}\\b`).test(report);
        if (!pageMentioned) return false;
      }
      // Need at least one concrete citation token from this finding.
      return Boolean(f.source_url) || f.page_number != null;
    });
    if (!hasCitation) uncited.push(claim);
  }
  return uncited;
}

// ---------------------------------------------------------------------------
// Synthesis brief — complete structured findings, metadata preserved
// ---------------------------------------------------------------------------

/**
 * The prompt the coordinator embeds when it invokes the synthesis subagent.
 * webSearchResults / docAnalysisResults are the structured findings the
 * research subagents returned — stringify them in full so no metadata is lost.
 */
export function buildSynthesisPrompt(
  webSearchResults: SpecialistResults,
  docAnalysisResults: SpecialistResults,
): string {
  return `Synthesise the following research findings into a coherent report. Every claim MUST include a citation with source URL and page number.

Web search findings:
${JSON.stringify(webSearchResults.findings, null, 2)}

Document analysis findings:
${JSON.stringify(docAnalysisResults.findings, null, 2)}

Output a report where every factual claim links to its source.`;
}

// ---------------------------------------------------------------------------
// Subagent definitions (spokes)
// ---------------------------------------------------------------------------

const webSearchAgent: AgentDefinition = {
  description:
    "Searches the web for current information and returns results with source URLs and titles.",
  tools: ["WebSearch", "WebFetch"],
  prompt:
    "Search for information on the given topic. Return each finding as JSON with fields: claim, source_url, source_title, retrieved_date.",
};

const documentAnalysisAgent: AgentDefinition = {
  description: "Analyses documents and returns findings with page references.",
  tools: ["Read", "Grep"],
  prompt:
    "Analyse the provided documents. Return each finding as JSON with fields: claim, document_name, page_number, section.",
};

const synthesisAgent: AgentDefinition = {
  description:
    "Synthesises findings from web-search and document-analysis into a cited report. Call only after both specialists return.",
  tools: [],
  prompt: [
    "You receive Web search findings and Document analysis findings as JSON.",
    "Synthesise a coherent report. Every factual claim MUST cite a source_url AND a page_number (use null/n/a only when the finding has no page).",
    "Preserve all metadata — do not drop URLs or page numbers.",
    "Inline citations next to each claim, e.g. (https://…, p.12).",
  ].join(" "),
};

export const SUBAGENTS: Record<string, AgentDefinition> = {
  "web-search": webSearchAgent,
  "document-analysis": documentAnalysisAgent,
  synthesis: synthesisAgent,
};

// ---------------------------------------------------------------------------
// Coordinator entry
// ---------------------------------------------------------------------------

export type CoordinatorResult = {
  report: string;
  findings: Finding[];
  uncited: string[];
};

/**
 * Run the coordinator agent. It delegates to web-search + document-analysis,
 * then passes both complete structured results to synthesis via buildSynthesisPrompt shape.
 * After synthesis, verifyCitations checks every claim has a source URL (+ page when known).
 */
export async function runCoordinator(
  userPrompt: string,
): Promise<CoordinatorResult> {
  let finalResult = "";

  // Captured specialist payloads — used if we need to rebuild the synthesis brief.
  let webSearchResults: SpecialistResults = { findings: [] };
  let docAnalysisResults: SpecialistResults = { findings: [] };

  for await (const message of query({
    prompt: userPrompt,
    options: {
      model: MODEL,
      // "Task" in the exam guide; renamed "Agent" in Claude Code v2.1.63
      allowedTools: ["Agent"],
      agents: SUBAGENTS,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (
          block.type === "tool_use" &&
          (block.name === "Agent" || block.name === "Task")
        ) {
          const input = block.input as {
            description?: string;
            prompt?: string;
            subagent_type?: string;
          };
          console.log(
            `[invoke] ${block.name} → ${input.subagent_type ?? "?"} (${input.description ?? ""})`,
          );
          if (input.prompt) {
            console.log(`[brief]\n${input.prompt}\n`);
          }

          // When coordinator is about to call synthesis, log the canonical
          // brief shape (complete findings from both specialists).
          if (input.subagent_type === "synthesis") {
            const expected = buildSynthesisPrompt(
              webSearchResults,
              docAnalysisResults,
            );
            console.log(`[synthesis-brief-template]\n${expected}\n`);
          }
        }
      }
    }

    // Capture specialist tool results so synthesis can receive full metadata.
    if (message.type === "user") {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_result") continue;
          const text =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter(
                      (c): c is { type: "text"; text: string } =>
                        typeof c === "object" &&
                        c !== null &&
                        "type" in c &&
                        c.type === "text",
                    )
                    .map((c) => c.text)
                    .join("\n")
                : "";
          const parsed = tryParseFindings(text);
          if (!parsed) continue;
          // Heuristic: web findings carry source_url; doc findings carry document_name.
          const looksWeb = parsed.findings.some((f) => !!f.source_url);
          const looksDoc = parsed.findings.some((f) => !!f.document_name);
          if (looksWeb) webSearchResults = parsed;
          if (looksDoc) docAnalysisResults = parsed;
        }
      }
    }

    if (message.type === "result" && "result" in message) {
      finalResult = String(message.result ?? "");
    }
  }

  const findings = [
    ...webSearchResults.findings,
    ...docAnalysisResults.findings,
  ];
  const uncited = verifyCitations(finalResult, findings);
  if (uncited.length > 0) {
    console.warn(
      `[verifyCitations] ${uncited.length} claim(s) missing source URL / page citation:`,
    );
    for (const c of uncited) console.warn(`  - ${c.slice(0, 120)}`);
  } else {
    console.log(
      `[verifyCitations] all ${extractClaims(finalResult).length} claim(s) attributed to a source URL` +
        (findings.some((f) => f.page_number != null)
          ? " (+ page where applicable)"
          : ""),
    );
  }

  return { report: finalResult, findings, uncited };
}

function tryParseFindings(text: string): SpecialistResults | null {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (fenced?.[1] ?? text).trim();
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const obj = JSON.parse(
      raw.slice(start, end + 1),
    ) as Partial<SpecialistResults>;
    if (!Array.isArray(obj.findings)) return null;
    return {
      findings: obj.findings as Finding[],
      query: obj.query,
      documents: obj.documents,
    };
  } catch {
    return null;
  }
}

/**
 * Runs the subagent invocation flow using context passing.
 *
 * This CLI entrypoint coordinates the following flow:
 * 1. Invokes both the `web-search` and `doc-analysis` subagents in parallel,
 *    emitting both Agent tool calls in a single response.
 * 2. Collects the complete, structured findings from both specialists.
 * 3. Passes these findings to the synthesis subagent, which generates a
 *    consolidated report using the subagents' results.
 * 4. Returns the synthetic report, the merged findings array, and a list of
 *    uncited claims (claims in the report not attributed to a source).
 *
 * Usage:
 *   Call `subagentInvocationContextPassing()` to orchestrate the research
 *   process and print the final report & citation check to the console.
 *
 * Returns:
 *   { report, findings, uncited }: The synthetic report string, all findings,
 *   and any extracted claims missing citations.
 */
export async function subagentInvocationContextPassing(): Promise<CoordinatorResult> {
  const prompt =
    "Research the topic. Invoke the web-search and doc-analysis subagents in parallel — emit both Agent tool calls in a single response — then pass their complete structured findings to the synthesis subagent.";

  console.log(`[coordinator] ${prompt}\n`);
  const { report, findings, uncited } = await runCoordinator(prompt);
  console.log("\n========== COORDINATOR RESULT ==========\n");
  console.log(report);
  console.log("\n========== CITATION CHECK ==========\n");
  console.log(
    uncited.length === 0
      ? `OK — every claim cites a source (${findings.length} findings).`
      : `FAIL — ${uncited.length} uncited claim(s):\n${uncited.map((c) => `- ${c}`).join("\n")}`,
  );
  return { report, findings, uncited };
}
