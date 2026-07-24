import Anthropic from "@anthropic-ai/sdk";

/**
 * multi-agent-orchestration.ts
 *
 * Hub-and-spoke research coordinator: the coordinator owns decomposition,
 * subagent selection, result aggregation, and iterative refinement.
 * Subagents never talk to each other — all communication flows through the hub.
 */

const client = new Anthropic();
const MODEL = "claude-sonnet-5";
const MAX_REFINEMENT_ITERATIONS = 3;

/** Must appear in renewable-energy decompositions — fusion included as next-gen. */
const REQUIRED_RENEWABLE_CATEGORIES = [
  "solar",
  "wind",
  "geothermal",
  "tidal",
  "biomass",
  "fusion",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubagentDefinition = {
  name: string;
  description: string;
  systemPrompt: string;
};

export type Finding = {
  subtopic: string;
  sourceAgent: string;
  content: string;
  sources?: string[];
};

export type CoverageStatus = "well_covered" | "partially_covered" | "missing";

export type CoverageAssessment = {
  subtopic: string;
  status: CoverageStatus;
  notes?: string;
}[];

export type ResearchReport = {
  topic: string;
  subtopics: string[];
  findings: Finding[];
  coverage: CoverageAssessment;
  summary: string;
  iterations: number;
};

// ---------------------------------------------------------------------------
// Coordinator system prompt — hub owns orchestration, not research itself
// ---------------------------------------------------------------------------

const COORDINATOR_SYSTEM_PROMPT =
  "You are a research coordinator. Decompose topics into comprehensive subtopics, delegate to specialist subagents, aggregate results, and identify coverage gaps.";

// ---------------------------------------------------------------------------
// Available subagents (spokes) — definitions only; coordinator decides when to use
// ---------------------------------------------------------------------------

export const SUBAGENTS: SubagentDefinition[] = [
  {
    name: "web_search",
    description:
      "Web research specialist. Use for breadth-first factual lookup, news, and public sources across the open web.",
    systemPrompt: [
      "You are a web research subagent. You receive a self-contained brief from the coordinator.",
      "GOAL: Return structured findings for your assigned subtopic only.",
      "OUTPUT: Concise bullet findings with claim + mock source URL + confidence.",
      "Do not invent that you searched beyond the brief. Stay within assigned scope.",
      "You have no memory of other subagents or prior turns unless included in the brief.",
    ].join(" "),
  },
  {
    name: "document_analysis",
    description:
      "Document analysis specialist. Use for extracting structured facts, quotes, and claims from supplied or described documents/reports.",
    systemPrompt: [
      "You are a document analysis subagent. You receive a self-contained brief from the coordinator.",
      "GOAL: Extract structured facts relevant to your assigned subtopic.",
      "OUTPUT: {claim, source_doc, quote_or_paraphrase, confidence} style findings.",
      "Stay within assigned scope. Do not call other agents. Context is only what is in the brief.",
    ].join(" "),
  },
];

function subagentCatalogForPrompt(): string {
  return SUBAGENTS.map((a) => `- ${a.name}: ${a.description}`).join("\n");
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function parseJsonBlock<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const arrayStart = raw.indexOf("[");
  const arrayEnd = raw.lastIndexOf("]");

  let candidate = raw;
  if (start !== -1 && end !== -1 && (arrayStart === -1 || start < arrayStart)) {
    candidate = raw.slice(start, end + 1);
  } else if (arrayStart !== -1 && arrayEnd !== -1) {
    candidate = raw.slice(arrayStart, arrayEnd + 1);
  }

  return JSON.parse(candidate) as T;
}

// ---------------------------------------------------------------------------
// Phase 1 — Decomposition (coordinator owns breadth)
// ---------------------------------------------------------------------------

function isRenewableEnergyTopic(topic: string): boolean {
  return /renewable\s+energy/i.test(topic);
}

/** Ensure required tech categories are present (case-insensitive substring match). */
function ensureRequiredCategories(
  subtopics: string[],
  required: readonly string[],
): string[] {
  const lower = subtopics.map((s) => s.toLowerCase());
  const missing = required.filter(
    (req) => !lower.some((s) => s.includes(req.toLowerCase())),
  );
  if (missing.length === 0) return subtopics;
  console.log(`[decompose] injecting missing required categories: ${missing.join(", ")}`);
  return [...subtopics, ...missing.map((m) => `${m} energy`)];
}

async function decompose(topic: string): Promise<string[]> {
  const requiredHint = isRenewableEnergyTopic(topic)
    ? `REQUIRED categories (must each appear as their own subtopic): ${REQUIRED_RENEWABLE_CATEGORIES.join(", ")}. Missing any of these is a critical failure.`
    : "Ensure comprehensive breadth — missing an entire category is a critical failure.";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: COORDINATOR_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `List ALL major subtopics for: ${topic}.`,
          requiredHint,
          `Return ONLY JSON: { "subtopics": string[] }`,
        ].join("\n"),
      },
    ],
  });

  const parsed = parseJsonBlock<{ subtopics: string[] } | string[]>(
    extractText(response),
  );
  const subtopics = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.subtopics)
      ? parsed.subtopics
      : [];

  if (subtopics.length === 0) {
    throw new Error("Decomposition failed: empty subtopics");
  }

  if (isRenewableEnergyTopic(topic)) {
    return ensureRequiredCategories(subtopics, REQUIRED_RENEWABLE_CATEGORIES);
  }
  return subtopics;
}

// ---------------------------------------------------------------------------
// Phase 2 — Delegation (explicit context; isolated subagent sessions)
// ---------------------------------------------------------------------------

async function runSubagent(
  agent: SubagentDefinition,
  brief: {
    topic: string;
    subtopic: string;
    researchGoal: string;
    priorFindings?: Finding[];
    extraContext?: string;
  },
): Promise<Finding> {
  // Isolation: subagent gets ONLY what we put in this prompt — no shared memory.
  // Filter prior findings to this subtopic so the brief stays targeted.
  const token = brief.subtopic.toLowerCase().split(/\s+/)[0] ?? brief.subtopic;
  const relevantPrior = (brief.priorFindings ?? []).filter((f) => {
    const st = f.subtopic.toLowerCase();
    return st.includes(token) || brief.subtopic.toLowerCase().includes(st.split(/\s+/)[0] ?? st);
  });

  const userBrief = [
    `RESEARCH GOAL: ${brief.researchGoal}`,
    `OVERALL TOPIC: ${brief.topic}`,
    `ASSIGNED SUBTOPIC: ${brief.subtopic}`,
    `You MUST produce findings specifically about "${brief.subtopic}". Do not skip this assignment.`,
    brief.extraContext ? `TARGETED QUERY / GAP NOTES:\n${brief.extraContext}` : "",
    relevantPrior.length
      ? `PRIOR FINDINGS FROM COORDINATOR (do not duplicate; fill gaps):\n${JSON.stringify(relevantPrior, null, 2)}`
      : "PRIOR FINDINGS: none",
    ``,
    `Produce substantive findings for ONLY the assigned subtopic.`,
    `Return plain text findings (bullets OK). Include mock source URLs and confidence where useful.`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: agent.systemPrompt,
    messages: [
      {
        role: "user",
        content: userBrief,
      },
    ],
  });

  return {
    subtopic: brief.subtopic,
    sourceAgent: agent.name,
    content: extractText(response),
  };
}

function pickAgentsForSubtopic(subtopic: string): SubagentDefinition[] {
  // Dynamic selection placeholder: both spokes for broad research.
  // Later exercises can route by query complexity.
  void subtopic;
  return SUBAGENTS;
}

async function delegate(
  topic: string,
  subtopics: string[],
  priorFindings: Finding[] = [],
  gapNotes: Record<string, string> = {},
): Promise<Finding[]> {
  const researchGoal = `Produce thorough, sourced research on "${topic}" with full domain breadth.`;
  const findings: Finding[] = [];

  // Sequential by subtopic; within a subtopic, spokes run in parallel.
  // Hub-and-spoke: results return only to the coordinator.
  for (const subtopic of subtopics) {
    const agents = pickAgentsForSubtopic(subtopic);
    console.log(
      `[delegate] "${subtopic}" → ${agents.map((a) => a.name).join(", ")}`,
    );

    const notes = gapNotes[subtopic];
    const batch = await Promise.all(
      agents.map((agent) =>
        runSubagent(agent, {
          topic,
          subtopic,
          researchGoal,
          priorFindings,
          extraContext: notes
            ? `Coverage gap (${notes}). Focus your research to close this gap for "${subtopic}".`
            : undefined,
        }),
      ),
    );
    findings.push(...batch);
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Phase 3 — Aggregation + coverage assessment
// ---------------------------------------------------------------------------

async function aggregate(
  topic: string,
  subtopics: string[],
  findings: Finding[],
): Promise<{ coverage: CoverageAssessment; summary: string }> {
  const requiredCoverageHint = isRenewableEnergyTopic(topic)
    ? `The summary AND coverage MUST address these technologies: ${REQUIRED_RENEWABLE_CATEGORIES.join(", ")}. Mark any absent from findings as "missing".`
    : "";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: COORDINATOR_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          `Aggregate subagent findings into a research report and assess coverage.`,
          `Topic: "${topic}"`,
          `Expected subtopics: ${JSON.stringify(subtopics)}`,
          requiredCoverageHint,
          `Findings:\n${JSON.stringify(findings, null, 2)}`,
          ``,
          `Available subagents (for context only):\n${subagentCatalogForPrompt()}`,
          ``,
          `Respond with ONLY JSON:`,
          `{`,
          `  "summary": string,  // coherent multi-section research report`,
          `  "coverage": [ { "subtopic": string, "status": "well_covered" | "partially_covered" | "missing", "notes"?: string } ]`,
          `}`,
          `Coverage must include an entry for EVERY expected subtopic.`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  return parseJsonBlock<{ coverage: CoverageAssessment; summary: string }>(
    extractText(response),
  );
}

function gapsFromCoverage(
  coverage: CoverageAssessment,
): { subtopic: string; notes: string }[] {
  return coverage
    .filter((c) => c.status === "missing" || c.status === "partially_covered")
    .map((c) => ({
      subtopic: c.subtopic,
      notes: c.notes ?? `status=${c.status}; deepen coverage`,
    }));
}

// ---------------------------------------------------------------------------
// Phase 4 — Iterative refinement
// ---------------------------------------------------------------------------

async function refineGaps(
  topic: string,
  gaps: { subtopic: string; notes: string }[],
  priorFindings: Finding[],
): Promise<Finding[]> {
  if (gaps.length === 0) return [];
  console.log(
    `[refine] re-delegating gaps: ${gaps.map((g) => g.subtopic).join("; ")}`,
  );
  const gapNotes = Object.fromEntries(
    gaps.map((g) => [g.subtopic, g.notes]),
  );
  return delegate(
    topic,
    gaps.map((g) => g.subtopic),
    priorFindings,
    gapNotes,
  );
}

// ---------------------------------------------------------------------------
// Coordinator entry — topic in, structured report out
// ---------------------------------------------------------------------------

/**
 * coordinateResearch
 *
 * Hub-and-spoke coordinator: decompose → delegate → aggregate → refine.
 */
export async function coordinateResearch(
  topic: string,
): Promise<ResearchReport> {
  console.log(`[coordinator] topic: ${topic}`);

  // 1. Decomposition
  const subtopics = await decompose(topic);
  console.log(`[decompose] ${subtopics.length} subtopics:`, subtopics);

  // 2. Initial delegation
  let findings = await delegate(topic, subtopics);

  // 3–4. Aggregate, then refine until coverage is sufficient or budget exhausted
  let coverage: CoverageAssessment = [];
  let summary = "";
  let iterations = 0;

  while (iterations < MAX_REFINEMENT_ITERATIONS) {
    iterations++;
    const aggregated = await aggregate(topic, subtopics, findings);
    coverage = aggregated.coverage;
    summary = aggregated.summary;

    const gaps = gapsFromCoverage(coverage);
    console.log(
      `[aggregate] iteration ${iterations} — gaps: ${
        gaps.length ? gaps.map((g) => g.subtopic).join("; ") : "none"
      }`,
    );

    if (gaps.length === 0) break;

    const extra = await refineGaps(topic, gaps, findings);
    findings = [...findings, ...extra];
  }

  return {
    topic,
    subtopics,
    findings,
    coverage,
    summary,
    iterations,
  };
}

/**
 * CLI entry for the hub-and-spoke multi-agent research exercise.
 *
 * Topic comes from `process.argv` (default: renewable energy). Runs
 * {@link coordinateResearch}: decompose → delegate to specialist subagents →
 * aggregate coverage → refine gaps (up to `MAX_REFINEMENT_ITERATIONS`).
 * Prints summary + coverage JSON; returns the full report.
 *
 * @returns Aggregated {@link ResearchReport} (subtopics, findings, coverage, iterations)
 *
 * @example
 * ```ts
 * const report = await multiAgentOrchestration();
 * // argv: "battery storage economics"
 * ```
 */
export async function multiAgentOrchestration(): Promise<ResearchReport> {
  const topic =
    process.argv.slice(2).join(" ") || "renewable energy technologies";

  const report = await coordinateResearch(topic);

  console.log("\n========== RESEARCH REPORT ==========\n");
  console.log(report.summary);
  console.log("\n========== COVERAGE ==========\n");
  console.log(JSON.stringify(report.coverage, null, 2));
  console.log(
    `\n[done] subtopics=${report.subtopics.length} findings=${report.findings.length} iterations=${report.iterations}`,
  );

  return report;
}
