import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/**
 * tool-distribution-and-tool-choice.ts
 *
 * Exercise: least-privilege toolsets + tool_choice workflow control.
 *
 * - 3 roles × 4–5 scoped tools (no cross-role clutter)
 * - synthesis gets scoped verify_fact (simple lookups; complex → coordinator)
 * - document-analysis: tool_choice forced extract_metadata on turn 1, then auto
 * - load_document replaces generic fetch_url (document URLs only)
 */

const MODEL = "claude-opus-4-8";
const client = new Anthropic();

// ---------------------------------------------------------------------------
// Role → tool distribution (4–5 each; names don't overlap across roles)
// ---------------------------------------------------------------------------

export const AGENT_ROLES = {
  "web-search": {
    description:
      "Discover and collect current web evidence. No document parsing or report writing.",
    tools: [
      "search_web",
      "fetch_page",
      "extract_links",
      "save_snippet",
      "rank_results",
    ] as const,
    toolChoice: { type: "auto" } as const,
  },
  "document-analysis": {
    description:
      "Load and analyse documents. Metadata extraction is mandatory before enrichment.",
    tools: [
      "load_document",
      "extract_metadata",
      "extract_data_points",
      "summarize_content",
      "verify_claim",
    ] as const,
    /** First API turn only — then switch to auto for enrichment. */
    initialToolChoice: {
      type: "tool",
      name: "extract_metadata",
    } as const,
    subsequentToolChoice: { type: "auto" } as const,
  },
  synthesis: {
    description:
      "Compile a cited report from specialist findings. Simple fact checks stay local.",
    tools: [
      "compile_report",
      "verify_fact",
      "format_citation",
      "assess_coverage",
      "flag_gap",
    ] as const,
    toolChoice: { type: "auto" } as const,
  },
} as const;

export type AgentRole = keyof typeof AGENT_ROLES;
export type ToolsForRole<R extends AgentRole> =
  (typeof AGENT_ROLES)[R]["tools"][number];

/** Anti-pattern: unbounded fetch — do not attach to any agent. */
export const REJECTED_GENERIC_TOOL = "fetch_url" as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOCUMENT_EXT = /\.(pdf|docx?|txt|md|html?|csv|xlsx?)$/i;
const TRUSTED_DOC_HOSTS = new Set([
  "docs.example.com",
  "files.example.com",
  "static.example.com",
]);

const DOC_STORE: Record<
  string,
  { title: string; pages: number; author: string; body: string }
> = {
  "https://docs.example.com/reports/q1-revenue.pdf": {
    title: "Q1 Revenue Report",
    pages: 12,
    author: "Finance",
    body: "Q1 revenue was $4.2M, up 18% YoY. Enterprise ARR reached $11M.",
  },
  "https://files.example.com/briefs/market-outlook.docx": {
    title: "Market Outlook Brief",
    pages: 6,
    author: "Strategy",
    body: "Cloud spend is projected to grow 22% in 2026. APAC leads adoption.",
  },
};

const WEB_HITS = [
  {
    url: "https://news.example.com/cloud-spend-2026",
    title: "Cloud spend outlook 2026",
    snippet: "Analysts project 22% cloud spend growth in 2026.",
  },
  {
    url: "https://news.example.com/enterprise-arr",
    title: "Enterprise ARR benchmarks",
    snippet: "Median enterprise ARR for mid-market SaaS crossed $10M.",
  },
];

/** Simple single-source facts — verify_fact handles these locally. */
const SIMPLE_FACTS: Record<string, { verdict: boolean; source: string }> = {
  "q1 revenue was $4.2m": {
    verdict: true,
    source: "https://docs.example.com/reports/q1-revenue.pdf",
  },
  "cloud spend growth is 22% in 2026": {
    verdict: true,
    source: "https://news.example.com/cloud-spend-2026",
  },
  "enterprise arr reached $11m": {
    verdict: true,
    source: "https://docs.example.com/reports/q1-revenue.pdf",
  },
};

export type ToolCallTrace = { role: AgentRole; tool: string; input: unknown };

// ---------------------------------------------------------------------------
// Constrained load_document (replaces fetch_url)
// ---------------------------------------------------------------------------

export function isDocumentUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (DOCUMENT_EXT.test(parsed.pathname)) return true;
  return TRUSTED_DOC_HOSTS.has(parsed.hostname);
}

/**
 * Least-privilege replacement for fetch_url: only document URLs are accepted.
 * Rejects arbitrary pages, APIs, images, etc. with a structured error.
 */
export function loadDocument(url: string):
  | {
      ok: true;
      document: (typeof DOC_STORE)[string] & { url: string };
    }
  | {
      ok: false;
      error: "invalid_document_url";
      message: string;
      url: string;
    } {
  if (!isDocumentUrl(url)) {
    return {
      ok: false,
      error: "invalid_document_url",
      message:
        "load_document only accepts http(s) document URLs (pdf/docx/txt/md/html/csv/xlsx) " +
        "or hosts under docs|files|static.example.com. Use the web-search agent for pages.",
      url,
    };
  }
  const doc = DOC_STORE[url];
  if (!doc) {
    return {
      ok: false,
      error: "invalid_document_url",
      message: `No document registered at ${url}`,
      url,
    };
  }
  return { ok: true, document: { url, ...doc } };
}

// ---------------------------------------------------------------------------
// Scoped verify_fact (synthesis only — simple lookups)
// ---------------------------------------------------------------------------

export type VerifyFactResult =
  | {
      kind: "simple";
      claim: string;
      verified: boolean;
      source: string;
      note: string;
    }
  | {
      kind: "escalate";
      claim: string;
      reason: string;
      route: "coordinator→web-search";
    };

/**
 * Synthesis-local fact check for the ~85% simple single-source case.
 * Multi-source / judgement-heavy claims escalate to the coordinator.
 */
export function verifyFact(claim: string): VerifyFactResult {
  const key = claim
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, "");
  const looksComplex =
    /\b(compare|versus|vs\.?|across|multiple|corroborat|contradict|trend)\b/i.test(
      claim,
    ) || claim.split(/\s+/).length > 24;

  if (looksComplex) {
    return {
      kind: "escalate",
      claim,
      reason: "Claim requires multi-source judgement",
      route: "coordinator→web-search",
    };
  }

  const hit = SIMPLE_FACTS[key];
  if (hit) {
    return {
      kind: "simple",
      claim,
      verified: hit.verdict,
      source: hit.source,
      note: "Resolved via scoped verify_fact — no coordinator round-trip.",
    };
  }

  return {
    kind: "escalate",
    claim,
    reason:
      "No simple single-source match — escalate for full web-search verification",
    route: "coordinator→web-search",
  };
}

// ---------------------------------------------------------------------------
// Runnable tools per role (Messages API / tool runner)
// ---------------------------------------------------------------------------

function json(data: unknown): string {
  return JSON.stringify(data);
}

// --- web-search ---

const searchWeb = betaZodTool({
  name: "search_web",
  description:
    "Search the public web for a query. Use for discovery only — not for loading PDFs/docs.",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    max_results: z.number().int().min(1).max(10).optional(),
  }),
  run: async ({ query, max_results = 5 }) =>
    json({
      query,
      results: WEB_HITS.slice(0, max_results),
    }),
});

const fetchPage = betaZodTool({
  name: "fetch_page",
  description:
    "Fetch an HTML news/article page by URL. Do NOT use for PDFs or office docs.",
  inputSchema: z.object({
    url: z.url(),
  }),
  run: async ({ url }) => {
    const hit = WEB_HITS.find((h) => h.url === url);
    return json(
      hit ?? { error: "not_found", url, message: "Page not in fixture index" },
    );
  },
});

const extractLinks = betaZodTool({
  name: "extract_links",
  description: "Extract outbound links from a previously fetched page URL.",
  inputSchema: z.object({
    url: z.url(),
  }),
  run: async ({ url }) =>
    json({
      url,
      links: WEB_HITS.filter((h) => h.url !== url).map((h) => h.url),
    }),
});

const saveSnippet = betaZodTool({
  name: "save_snippet",
  description:
    "Persist a short evidence snippet with its source URL for later synthesis.",
  inputSchema: z.object({
    source_url: z.url(),
    snippet: z.string().min(1).max(500),
  }),
  run: async (input) => json({ saved: true, ...input }),
});

const rankResults = betaZodTool({
  name: "rank_results",
  description: "Rank saved/fetched web results by relevance to a query.",
  inputSchema: z.object({
    query: z.string(),
    urls: z.array(z.url()).min(1),
  }),
  run: async ({ query, urls }) =>
    json({
      query,
      ranked: urls.map((url, i) => ({ url, score: 1 - i * 0.1 })),
    }),
});

export const WEB_SEARCH_TOOLS = [
  searchWeb,
  fetchPage,
  extractLinks,
  saveSnippet,
  rankResults,
];

// --- document-analysis ---

const loadDocumentTool = betaZodTool({
  name: "load_document",
  description: [
    "Load a document by URL. ACCEPTS only document URLs (pdf/docx/txt/md/html/csv/xlsx)",
    "or trusted doc hosts (docs|files|static.example.com).",
    "REJECTS generic web pages — those belong to the web-search agent's fetch_page.",
    "This replaces the unsafe generic fetch_url tool.",
  ].join(" "),
  inputSchema: z.object({
    url: z.url().describe("Document URL only — not arbitrary pages"),
  }),
  run: async ({ url }) => json(loadDocument(url)),
});

const extractMetadata = betaZodTool({
  name: "extract_metadata",
  description:
    "MANDATORY FIRST STEP: extract title, author, page count from a loaded document URL. Must run before enrichment tools.",
  inputSchema: z.object({
    url: z.url(),
  }),
  run: async ({ url }) => {
    const loaded = loadDocument(url);
    if (!loaded.ok) return json(loaded);
    const { title, author, pages } = loaded.document;
    return json({ url, title, author, pages });
  },
});

const extractDataPoints = betaZodTool({
  name: "extract_data_points",
  description:
    "Extract numeric/factual data points from a document. Call only AFTER extract_metadata.",
  inputSchema: z.object({
    url: z.url(),
    focus: z.string().optional(),
  }),
  run: async ({ url, focus }) => {
    const loaded = loadDocument(url);
    if (!loaded.ok) return json(loaded);
    return json({
      url,
      focus: focus ?? null,
      data_points: [
        { claim: "Q1 revenue was $4.2M", page: 2 },
        { claim: "Enterprise ARR reached $11M", page: 5 },
      ],
    });
  },
});

const summarizeContent = betaZodTool({
  name: "summarize_content",
  description:
    "Summarise document body. Call only AFTER extract_metadata has completed.",
  inputSchema: z.object({
    url: z.url(),
    max_sentences: z.number().int().min(1).max(8).optional(),
  }),
  run: async ({ url, max_sentences = 3 }) => {
    const loaded = loadDocument(url);
    if (!loaded.ok) return json(loaded);
    const sentences = loaded.document.body
      .split(/(?<=\.)\s+/)
      .slice(0, max_sentences);
    return json({ url, summary: sentences.join(" ") });
  },
});

const verifyClaim = betaZodTool({
  name: "verify_claim",
  description:
    "Check a claim against a loaded document's body (document-grounded, not web search).",
  inputSchema: z.object({
    url: z.url(),
    claim: z.string(),
  }),
  run: async ({ url, claim }) => {
    const loaded = loadDocument(url);
    if (!loaded.ok) return json(loaded);
    const supported = loaded.document.body
      .toLowerCase()
      .includes(claim.toLowerCase().slice(0, 24));
    return json({ url, claim, supported });
  },
});

export const DOCUMENT_ANALYSIS_TOOLS = [
  loadDocumentTool,
  extractMetadata,
  extractDataPoints,
  summarizeContent,
  verifyClaim,
];

// --- synthesis ---

const compileReport = betaZodTool({
  name: "compile_report",
  description:
    "Compile specialist findings into a draft report. Prefer provided findings over new research.",
  inputSchema: z.object({
    title: z.string(),
    findings_json: z
      .string()
      .describe("JSON array of findings from web-search and document-analysis"),
  }),
  run: async ({ title, findings_json }) => {
    let findings: unknown[] = [];
    try {
      findings = JSON.parse(findings_json) as unknown[];
    } catch {
      return json({ error: "invalid_findings_json" });
    }
    const lines = findings.map((f, i) => `${i + 1}. ${JSON.stringify(f)}`);
    return json({
      title,
      draft: [`# ${title}`, "", ...lines].join("\n"),
    });
  },
});

const verifyFactTool = betaZodTool({
  name: "verify_fact",
  description: [
    "SCOPED cross-role tool: verify a SIMPLE single-source factual claim locally",
    "(known fixture facts / trivial lookups). Use during synthesis to avoid",
    "coordinator round-trips for the common case (~85%).",
    "ESCALATE to the coordinator (web-search agent) when the claim needs",
    "multi-source corroboration, comparison, trend analysis, or is unknown.",
    "Do NOT use this as a general web search.",
  ].join(" "),
  inputSchema: z.object({
    claim: z.string().describe("Atomic factual claim to verify"),
  }),
  run: async ({ claim }) => json(verifyFact(claim)),
});

const formatCitation = betaZodTool({
  name: "format_citation",
  description: "Format a citation string from source URL + optional page.",
  inputSchema: z.object({
    source_url: z.url(),
    page: z.number().int().positive().nullable().optional(),
  }),
  run: async ({ source_url, page = null }) =>
    json({
      citation: page != null ? `(${source_url}, p.${page})` : `(${source_url})`,
    }),
});

const assessCoverage = betaZodTool({
  name: "assess_coverage",
  description:
    "Assess whether findings adequately cover the research question; list gaps.",
  inputSchema: z.object({
    question: z.string(),
    findings_json: z.string(),
  }),
  run: async ({ question, findings_json }) => {
    let count = 0;
    try {
      count = (JSON.parse(findings_json) as unknown[]).length;
    } catch {
      /* ignore */
    }
    return json({
      question,
      finding_count: count,
      coverage: count >= 2 ? "adequate" : "thin",
      gaps:
        count >= 2 ? [] : ["Need at least one web and one document finding"],
    });
  },
});

const flagGap = betaZodTool({
  name: "flag_gap",
  description:
    "Flag a coverage gap that requires coordinator re-delegation (not local verify_fact).",
  inputSchema: z.object({
    gap: z.string(),
    suggested_agent: z.enum(["web-search", "document-analysis"]),
  }),
  run: async (input) => json({ flagged: true, ...input }),
});

export const SYNTHESIS_TOOLS = [
  compileReport,
  verifyFactTool,
  formatCitation,
  assessCoverage,
  flagGap,
];

export const TOOLS_BY_ROLE = {
  "web-search": WEB_SEARCH_TOOLS,
  "document-analysis": DOCUMENT_ANALYSIS_TOOLS,
  synthesis: SYNTHESIS_TOOLS,
} as const;

// ---------------------------------------------------------------------------
// Agent runners
// ---------------------------------------------------------------------------

function textFromMessage(message: Anthropic.Beta.Messages.BetaMessage): string {
  return message.content
    .filter(
      (b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

function toolNamesFromMessage(
  message: Anthropic.Beta.Messages.BetaMessage,
): string[] {
  return message.content
    .filter(
      (b): b is Anthropic.Beta.Messages.BetaToolUseBlock =>
        b.type === "tool_use",
    )
    .map((b) => b.name);
}

export type RoleRunResult = {
  role: AgentRole;
  text: string;
  toolCalls: string[];
  /** Present for document-analysis — proves forced-first then auto. */
  toolChoiceSequence?: Array<"forced:extract_metadata" | "auto">;
};

/**
 * Document analysis: turn 1 forces extract_metadata; later turns use auto.
 * (thinking is omitted — incompatible with forced tool_choice.)
 */
export async function runDocumentAnalysisAgent(
  userPrompt: string,
): Promise<RoleRunResult> {
  const role = "document-analysis" as const;
  const toolCalls: string[] = [];
  const toolChoiceSequence: RoleRunResult["toolChoiceSequence"] = [];

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    system: [
      AGENT_ROLES[role].description,
      "Workflow: extract_metadata FIRST (enforced), then load_document / extract_data_points / summarize_content / verify_claim as needed.",
      "Never call tools outside your role.",
    ].join("\n"),
    tools: DOCUMENT_ANALYSIS_TOOLS,
    tool_choice: {
      type: "tool",
      name: "extract_metadata",
    },
    messages: [{ role: "user", content: userPrompt }],
    max_iterations: 8,
  });

  let turn = 0;
  let last: Anthropic.Beta.Messages.BetaMessage | undefined;

  for await (const message of runner) {
    turn += 1;
    last = message;
    toolCalls.push(...toolNamesFromMessage(message));

    if (turn === 1) {
      toolChoiceSequence.push("forced:extract_metadata");
      // Mandatory step done — free selection for enrichment.
      runner.setMessagesParams((params) => ({
        ...params,
        tool_choice: { type: "auto" },
      }));
    } else {
      toolChoiceSequence.push("auto");
    }
  }

  const final = last ?? (await runner.done());
  return {
    role,
    text: textFromMessage(final),
    toolCalls,
    toolChoiceSequence,
  };
}

export async function runWebSearchAgent(
  userPrompt: string,
): Promise<RoleRunResult> {
  const role = "web-search" as const;
  const toolCalls: string[] = [];

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: [
      AGENT_ROLES[role].description,
      "Use only web-search tools. Return structured findings with URLs.",
    ].join("\n"),
    tools: WEB_SEARCH_TOOLS,
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: userPrompt }],
    max_iterations: 6,
  });

  let last: Anthropic.Beta.Messages.BetaMessage | undefined;
  for await (const message of runner) {
    last = message;
    toolCalls.push(...toolNamesFromMessage(message));
  }

  const final = last ?? (await runner.done());
  return { role, text: textFromMessage(final), toolCalls };
}

export async function runSynthesisAgent(
  userPrompt: string,
): Promise<RoleRunResult> {
  const role = "synthesis" as const;
  const toolCalls: string[] = [];

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: [
      AGENT_ROLES[role].description,
      "Use verify_fact for simple single-source checks only.",
      "If verify_fact returns kind:escalate, say so — do not invent a web search.",
      "Prefer compile_report + format_citation + assess_coverage over re-researching.",
    ].join("\n"),
    tools: SYNTHESIS_TOOLS,
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content: userPrompt }],
    max_iterations: 8,
  });

  let last: Anthropic.Beta.Messages.BetaMessage | undefined;
  for await (const message of runner) {
    last = message;
    toolCalls.push(...toolNamesFromMessage(message));
  }

  const final = last ?? (await runner.done());
  return { role, text: textFromMessage(final), toolCalls };
}

/** Assert no tool name appears on more than one role (scoped verify_fact is synthesis-only). */
export function assertNoCrossRoleToolOverlap(): void {
  const seen = new Map<string, AgentRole>();
  for (const role of Object.keys(AGENT_ROLES) as AgentRole[]) {
    for (const tool of AGENT_ROLES[role].tools) {
      const prior = seen.get(tool);
      if (prior) {
        throw new Error(`Tool "${tool}" appears on both ${prior} and ${role}`);
      }
      seen.set(tool, role);
    }
  }
  if (seen.has(REJECTED_GENERIC_TOOL)) {
    throw new Error(
      `${REJECTED_GENERIC_TOOL} must not be assigned to any role`,
    );
  }
}

// ---------------------------------------------------------------------------
// Offline checks + full pipeline demo
// ---------------------------------------------------------------------------

function logDistribution(): void {
  console.log("--- agent tool distribution (4–5 each) ---");
  for (const role of Object.keys(AGENT_ROLES) as AgentRole[]) {
    const cfg = AGENT_ROLES[role];
    console.log(`\n[${role}] (${cfg.tools.length} tools)`);
    console.log(`  ${cfg.tools.join(", ")}`);
    if (role === "document-analysis") {
      const doc = AGENT_ROLES["document-analysis"];
      console.log(
        `  tool_choice turn1:`,
        JSON.stringify(doc.initialToolChoice),
      );
      console.log(
        `  tool_choice later:`,
        JSON.stringify(doc.subsequentToolChoice),
      );
    } else if (role === "web-search") {
      console.log(
        `  tool_choice:`,
        JSON.stringify(AGENT_ROLES["web-search"].toolChoice),
      );
    } else {
      console.log(
        `  tool_choice:`,
        JSON.stringify(AGENT_ROLES.synthesis.toolChoice),
      );
    }
  }
  console.log(`\nrejected generic: ${REJECTED_GENERIC_TOOL}`);
}

function logLoadDocumentConstraints(): void {
  console.log("\n--- load_document vs fetch_url ---");
  const samples = [
    "https://docs.example.com/reports/q1-revenue.pdf",
    "https://news.example.com/cloud-spend-2026",
    "https://evil.example/api/secrets",
    "https://files.example.com/briefs/market-outlook.docx",
  ];
  for (const url of samples) {
    const result = loadDocument(url);
    console.log(
      result.ok
        ? `  OK  ${url} → ${result.document.title}`
        : `  REJ ${url} → ${result.error}: ${result.message.slice(0, 80)}…`,
    );
  }
}

function logVerifyFactScope(): void {
  console.log("\n--- scoped verify_fact (synthesis) ---");
  for (const claim of [
    "Q1 revenue was $4.2M",
    "Compare cloud spend across APAC and EMEA over five years",
    "Martians invented SaaS in 1999",
  ]) {
    console.log(JSON.stringify(verifyFact(claim)));
  }
}

/**
 * Offline invariants + optional live three-agent run (needs API credentials).
 */
export async function toolDistributionAndToolChoice(): Promise<void> {
  assertNoCrossRoleToolOverlap();
  logDistribution();
  logLoadDocumentConstraints();
  logVerifyFactScope();

  if (process.env.SKIP_CLAUDE === "1") {
    console.log("\n(SKIP_CLAUDE=1 — skipping live agent runs)");
    return;
  }

  const docUrl = "https://docs.example.com/reports/q1-revenue.pdf";

  console.log("\n=== document-analysis (forced extract_metadata → auto) ===");
  const doc = await runDocumentAnalysisAgent(
    `Analyse this document: ${docUrl}. Extract metadata first, then pull key data points and a short summary.`,
  );
  console.log("toolCalls:", doc.toolCalls);
  console.log("toolChoiceSequence:", doc.toolChoiceSequence);
  console.log("text:\n", doc.text);
  if (doc.toolCalls[0] !== "extract_metadata") {
    console.warn(
      `WARN: expected first tool_use to be extract_metadata, got ${doc.toolCalls[0]}`,
    );
  }

  console.log("\n=== web-search ===");
  const web = await runWebSearchAgent(
    "Find current evidence about 2026 cloud spend growth and enterprise ARR benchmarks. Save the best snippets.",
  );
  console.log("toolCalls:", web.toolCalls);
  console.log("text:\n", web.text);

  console.log("\n=== synthesis (compile_report + scoped verify_fact) ===");
  const findings = [
    {
      claim: "Q1 revenue was $4.2M",
      source_url: docUrl,
      page_number: 2,
      retrieved_by: "document-analysis",
    },
    {
      claim: "Cloud spend growth is 22% in 2026",
      source_url: "https://news.example.com/cloud-spend-2026",
      page_number: null,
      retrieved_by: "web-search",
    },
  ];
  const synth = await runSynthesisAgent(
    [
      "Synthesise a short cited brief from these findings.",
      "Use compile_report, verify_fact on each simple claim, and format_citation.",
      "Findings JSON:",
      JSON.stringify(findings),
    ].join("\n"),
  );
  console.log("toolCalls:", synth.toolCalls);
  console.log("text:\n", synth.text);

  const allAllowed = new Set<string>([
    ...AGENT_ROLES["web-search"].tools,
    ...AGENT_ROLES["document-analysis"].tools,
    ...AGENT_ROLES.synthesis.tools,
  ]);
  for (const run of [doc, web, synth]) {
    const allowed = new Set<string>(AGENT_ROLES[run.role].tools);
    for (const name of run.toolCalls) {
      if (!allowed.has(name as ToolsForRole<typeof run.role>)) {
        console.warn(
          `CROSS-ROLE MISUSE: ${run.role} called ${name} (allowed: ${[...allowed].join(", ")})`,
        );
      }
      if (!allAllowed.has(name)) {
        console.warn(`UNKNOWN TOOL: ${name}`);
      }
    }
  }
}
