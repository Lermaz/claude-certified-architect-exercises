import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * codebase-exploration.ts
 *
 * Hub-and-spoke coordinator for multi-phase codebase exploration.
 *
 * Pipeline:
 *   Phase 1 (breadth)  → find_test_files ∥ identify_external_integrations
 *   Summary injection  → compress scratchpad → inject into Phase 2 briefs
 *   Phase 2 (depth)    → trace_dependency_chains (summary-aware)
 *
 * Persistence:
 *   - Scratchpad: agents read/write key findings before each step
 *   - Manifest:   structured crash-recovery state loaded on resume
 */

const client = new Anthropic();
const MODEL = "claude-opus-4-8";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_STATE_DIR = path.join(here, ".exploration");
export const DEFAULT_SCRATCHPAD = path.join(DEFAULT_STATE_DIR, "scratchpad.json");
export const DEFAULT_MANIFEST = path.join(DEFAULT_STATE_DIR, "manifest.json");

// ---------------------------------------------------------------------------
// Advanced types — brands, literals, mapped/conditional helpers
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type AbsolutePath = Brand<string, "AbsolutePath">;
export type RelativePath = Brand<string, "RelativePath">;

export const asAbsolutePath = (p: string): AbsolutePath => p as AbsolutePath;
export const asRelativePath = (p: string): RelativePath => p as RelativePath;

/** Const-asserted agent catalogue — union derives from values. */
export const AGENT_IDS = [
  "find_test_files",
  "identify_external_integrations",
  "trace_dependency_chains",
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const PHASES = ["phase1", "phase2", "complete"] as const;
export type Phase = (typeof PHASES)[number];

export const FINDING_KINDS = [
  "class_name",
  "file_path",
  "dependency_chain",
  "external_integration",
  "test_file",
  "note",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export type Finding = {
  kind: FindingKind;
  value: string;
  path?: RelativePath;
  agentId: AgentId;
  ts: string;
};

/** Mapped: every agent → optional completion record. */
export type AgentCompletions = {
  [A in AgentId]?: AgentCompletion;
};

export type AgentCompletion = {
  agentId: AgentId;
  status: "completed" | "failed";
  exploredPaths: RelativePath[];
  keyFindings: Finding[];
  nextSteps: string[];
  finishedAt: string;
  error?: string;
};

/** Crash-recovery manifest — coordinator loads this on resume. */
export type ExplorationManifest = {
  rootDir: AbsolutePath;
  goal: string;
  phase: Phase;
  exploredPaths: RelativePath[];
  keyFindings: Finding[];
  nextSteps: string[];
  completions: AgentCompletions;
  phase1Summary: string | null;
  updatedAt: string;
};

/** Scratchpad payload agents share across steps. */
export type Scratchpad = {
  findings: Finding[];
  notes: string[];
  updatedAt: string;
};

/** Phase membership — conditional filter over AgentId. */
export type Phase1Agent = Extract<
  AgentId,
  "find_test_files" | "identify_external_integrations"
>;
export type Phase2Agent = Extract<AgentId, "trace_dependency_chains">;

const PHASE1_AGENTS: readonly Phase1Agent[] = [
  "find_test_files",
  "identify_external_integrations",
];
const PHASE2_AGENTS: readonly Phase2Agent[] = ["trace_dependency_chains"];

/** Remap AgentId → `run${Capitalize<Id>}` method names (skill: key remapping). */
export type AgentRunnerName<A extends AgentId> = `run${Capitalize<A>}`;

type SubagentDefinition = {
  id: AgentId;
  phase: "phase1" | "phase2";
  description: string;
  systemPrompt: string;
  /** Brief template; `{summary}` placeholder filled for Phase 2. */
  brief: (ctx: { rootDir: string; goal: string; summary?: string }) => string;
};

// ---------------------------------------------------------------------------
// Subagent catalogue
// ---------------------------------------------------------------------------

export const SUBAGENTS: Record<AgentId, SubagentDefinition> = {
  find_test_files: {
    id: "find_test_files",
    phase: "phase1",
    description: "Locate test files, fixtures, and test helpers.",
    systemPrompt: [
      "You are a test-discovery subagent.",
      "GOAL: Find test files (*test*, *spec*, __tests__, fixtures) and note frameworks.",
      "WORKFLOW: read_scratchpad → glob_files / grep_code / read_file → append_scratchpad with findings → stop.",
      "Each finding must include kind, value, and relative path when applicable.",
      "Do not invent files. Stay within the assigned root.",
    ].join(" "),
    brief: ({ rootDir, goal }) =>
      [
        `Explore the codebase at ${rootDir}.`,
        `Overall goal: ${goal}`,
        "Task: find all test files, fixtures, and testing utilities.",
        "Write class names, file paths, and framework notes to the scratchpad.",
        "Read the scratchpad first so you do not duplicate prior findings.",
      ].join("\n"),
  },
  identify_external_integrations: {
    id: "identify_external_integrations",
    phase: "phase1",
    description: "Identify external APIs, SDKs, and third-party integrations.",
    systemPrompt: [
      "You are an integrations-discovery subagent.",
      "GOAL: Identify external integrations (HTTP clients, SDKs, cloud services, MCP, DB drivers).",
      "WORKFLOW: read_scratchpad → glob_files / grep_code / read_file → append_scratchpad → stop.",
      "Prefer package.json, import graphs, and env/config references as evidence.",
      "Do not invent integrations. Stay within the assigned root.",
    ].join(" "),
    brief: ({ rootDir, goal }) =>
      [
        `Explore the codebase at ${rootDir}.`,
        `Overall goal: ${goal}`,
        "Task: identify external integrations and third-party dependencies that matter architecturally.",
        "Write integration names, entry-point file paths, and notes to the scratchpad.",
        "Read the scratchpad first so you do not duplicate prior findings.",
      ].join("\n"),
  },
  trace_dependency_chains: {
    id: "trace_dependency_chains",
    phase: "phase2",
    description: "Trace import/dependency chains for key modules from Phase 1.",
    systemPrompt: [
      "You are a dependency-tracing subagent.",
      "GOAL: Trace dependency chains for important modules identified in Phase 1.",
      "WORKFLOW: read_scratchpad → use the injected Phase 1 summary → glob/grep/read → append_scratchpad → stop.",
      "Output dependency chains as A → B → C style findings (kind: dependency_chain).",
      "Do not invent edges. Stay within the assigned root.",
    ].join(" "),
    brief: ({ rootDir, goal, summary }) =>
      [
        `Explore the codebase at ${rootDir}.`,
        `Overall goal: ${goal}`,
        "Task: trace dependency chains for the most important modules from Phase 1.",
        "",
        "=== PHASE 1 SUMMARY (injected) ===",
        summary?.trim() || "(no summary available)",
        "=== END SUMMARY ===",
        "",
        "Read the scratchpad before exploring. Prefer modules named in the summary.",
        "Write dependency chains and related class/file findings to the scratchpad.",
      ].join("\n"),
  },
};

// ---------------------------------------------------------------------------
// Scratchpad + Manifest I/O
// ---------------------------------------------------------------------------

function emptyScratchpad(): Scratchpad {
  return { findings: [], notes: [], updatedAt: new Date().toISOString() };
}

function emptyManifest(rootDir: AbsolutePath, goal: string): ExplorationManifest {
  return {
    rootDir,
    goal,
    phase: "phase1",
    exploredPaths: [],
    keyFindings: [],
    nextSteps: PHASE1_AGENTS.map((a) => `run:${a}`),
    completions: {},
    phase1Summary: null,
    updatedAt: new Date().toISOString(),
  };
}

async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
}

export async function readScratchpad(filePath: string): Promise<Scratchpad> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Scratchpad;
    return {
      findings: parsed.findings ?? [],
      notes: parsed.notes ?? [],
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return emptyScratchpad();
  }
}

export async function writeScratchpad(
  filePath: string,
  pad: Scratchpad,
): Promise<void> {
  await ensureStateDir(path.dirname(filePath));
  const next: Scratchpad = { ...pad, updatedAt: new Date().toISOString() };
  await writeFile(filePath, JSON.stringify(next, null, 2), "utf8");
}

export async function appendScratchpadFindings(
  filePath: string,
  findings: Finding[],
  notes: string[] = [],
): Promise<Scratchpad> {
  const pad = await readScratchpad(filePath);
  const existing = new Set(
    pad.findings.map((f) => `${f.kind}|${f.value}|${f.path ?? ""}`),
  );
  for (const f of findings) {
    const key = `${f.kind}|${f.value}|${f.path ?? ""}`;
    if (!existing.has(key)) {
      pad.findings.push(f);
      existing.add(key);
    }
  }
  pad.notes.push(...notes);
  await writeScratchpad(filePath, pad);
  return pad;
}

export async function loadManifest(
  filePath: string,
): Promise<ExplorationManifest | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as ExplorationManifest;
  } catch {
    return null;
  }
}

export async function saveManifest(
  filePath: string,
  manifest: ExplorationManifest,
): Promise<void> {
  await ensureStateDir(path.dirname(filePath));
  const next: ExplorationManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(filePath, JSON.stringify(next, null, 2), "utf8");
}

/** Merge an agent completion into the coordinator manifest (crash checkpoint). */
export function applyAgentCompletion(
  manifest: ExplorationManifest,
  completion: AgentCompletion,
): ExplorationManifest {
  const explored = new Set(manifest.exploredPaths);
  for (const p of completion.exploredPaths) explored.add(p);

  const findingKeys = new Set(
    manifest.keyFindings.map((f) => `${f.kind}|${f.value}|${f.path ?? ""}`),
  );
  const keyFindings = [...manifest.keyFindings];
  for (const f of completion.keyFindings) {
    const key = `${f.kind}|${f.value}|${f.path ?? ""}`;
    if (!findingKeys.has(key)) {
      keyFindings.push(f);
      findingKeys.add(key);
    }
  }

  const nextSteps = completion.nextSteps.length
    ? completion.nextSteps
    : manifest.nextSteps.filter((s) => s !== `run:${completion.agentId}`);

  return {
    ...manifest,
    exploredPaths: [...explored],
    keyFindings,
    nextSteps,
    completions: {
      ...manifest.completions,
      [completion.agentId]: completion,
    },
    updatedAt: new Date().toISOString(),
  };
}

export function isAgentComplete(
  manifest: ExplorationManifest,
  agentId: AgentId,
): boolean {
  return manifest.completions[agentId]?.status === "completed";
}

// ---------------------------------------------------------------------------
// Filesystem helpers (scoped to rootDir)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".exploration",
  "coverage",
]);

function resolveUnderRoot(rootDir: string, relative: string): string {
  const abs = path.resolve(rootDir, relative);
  const root = path.resolve(rootDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes rootDir: ${relative}`);
  }
  return abs;
}

async function walkFiles(
  rootDir: string,
  pattern: RegExp,
  maxFiles = 200,
): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (pattern.test(entry.name)) {
        out.push(path.relative(rootDir, full).split(path.sep).join("/"));
      }
    }
  }

  await walk(rootDir);
  return out;
}

async function grepFiles(
  rootDir: string,
  regexSource: string,
  globHint: string,
  maxHits = 40,
): Promise<Array<{ path: string; line: number; text: string }>> {
  const fileRe = globHintToRegex(globHint);
  const contentRe = new RegExp(regexSource, "i");
  const files = await walkFiles(rootDir, fileRe, 300);
  const hits: Array<{ path: string; line: number; text: string }> = [];

  for (const rel of files) {
    if (hits.length >= maxHits) break;
    let text: string;
    try {
      text = await readFile(resolveUnderRoot(rootDir, rel), "utf8");
    } catch {
      continue;
    }
    if (text.length > 200_000) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= maxHits) break;
      if (contentRe.test(lines[i]!)) {
        hits.push({ path: rel, line: i + 1, text: lines[i]!.trim().slice(0, 240) });
      }
    }
  }
  return hits;
}

/** Convert simple globs like "*test*" or "*.ts" into a filename regex. */
function globHintToRegex(globHint: string): RegExp {
  const base = globHint.split("/").pop() ?? "*";
  const escaped = base
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

// ---------------------------------------------------------------------------
// Exploration tools (shared by all subagents)
// ---------------------------------------------------------------------------

type ToolContext = {
  rootDir: AbsolutePath;
  scratchpadPath: string;
  agentId: AgentId;
  exploredPaths: Set<string>;
};

function buildExplorationTools(ctx: ToolContext) {
  const globFiles = betaZodTool({
    name: "glob_files",
    description:
      "List files under rootDir whose basename matches a glob (e.g. '*test*', '*.ts', '*spec*').",
    inputSchema: z.object({
      glob: z.string().describe("Filename glob, e.g. '*test*' or '*.ts'"),
      max_files: z.number().int().min(1).max(300).optional(),
    }),
    run: async (input) => {
      const files = await walkFiles(
        ctx.rootDir,
        globHintToRegex(input.glob),
        input.max_files ?? 200,
      );
      for (const f of files) ctx.exploredPaths.add(f);
      return JSON.stringify({ count: files.length, files }, null, 2);
    },
  });

  const grepCode = betaZodTool({
    name: "grep_code",
    description:
      "Search file contents with a JS regex. Restrict by filename glob hint.",
    inputSchema: z.object({
      pattern: z.string().describe("JS regex source (no flags)"),
      file_glob: z
        .string()
        .describe("Filename glob to limit search, e.g. '*.ts'"),
      max_hits: z.number().int().min(1).max(80).optional(),
    }),
    run: async (input) => {
      const hits = await grepFiles(
        ctx.rootDir,
        input.pattern,
        input.file_glob,
        input.max_hits ?? 40,
      );
      for (const h of hits) ctx.exploredPaths.add(h.path);
      return JSON.stringify({ count: hits.length, hits }, null, 2);
    },
  });

  const readSourceFile = betaZodTool({
    name: "read_file",
    description: "Read a UTF-8 source file relative to rootDir (truncated if large).",
    inputSchema: z.object({
      path: z.string().describe("Relative path under rootDir"),
      max_chars: z.number().int().min(500).max(40_000).optional(),
    }),
    run: async (input) => {
      const abs = resolveUnderRoot(ctx.rootDir, input.path);
      const st = await stat(abs);
      if (!st.isFile()) return JSON.stringify({ error: "not a file" });
      const max = input.max_chars ?? 12_000;
      let text = await readFile(abs, "utf8");
      const truncated = text.length > max;
      if (truncated) text = text.slice(0, max);
      ctx.exploredPaths.add(input.path.split(path.sep).join("/"));
      return JSON.stringify({
        path: input.path,
        truncated,
        content: text,
      });
    },
  });

  const readScratch = betaZodTool({
    name: "read_scratchpad",
    description:
      "Read the shared scratchpad of key findings (class names, paths, chains). Call before exploring.",
    inputSchema: z.object({}),
    run: async () => {
      const pad = await readScratchpad(ctx.scratchpadPath);
      return JSON.stringify(pad, null, 2);
    },
  });

  const appendScratch = betaZodTool({
    name: "append_scratchpad",
    description:
      "Append key findings to the shared scratchpad. Deduplicates identical findings.",
    inputSchema: z.object({
      findings: z.array(
        z.object({
          kind: z.enum(FINDING_KINDS),
          value: z.string(),
          path: z.string().optional(),
        }),
      ),
      notes: z.array(z.string()).optional(),
    }),
    run: async (input) => {
      const findings: Finding[] = input.findings.map((f) => ({
        kind: f.kind,
        value: f.value,
        path: f.path ? asRelativePath(f.path) : undefined,
        agentId: ctx.agentId,
        ts: new Date().toISOString(),
      }));
      const pad = await appendScratchpadFindings(
        ctx.scratchpadPath,
        findings,
        input.notes ?? [],
      );
      return JSON.stringify({
        ok: true,
        totalFindings: pad.findings.length,
        added: findings.length,
      });
    },
  });

  return [globFiles, grepCode, readSourceFile, readScratch, appendScratch];
}

// ---------------------------------------------------------------------------
// Subagent runner
// ---------------------------------------------------------------------------

function textFromMessage(
  message: Anthropic.Beta.Messages.BetaMessage | Anthropic.Message,
): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock | Anthropic.Beta.Messages.BetaTextBlock =>
      b.type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

const AgentExportSchema = z.object({
  explored_paths: z.array(z.string()),
  key_findings: z.array(
    z.object({
      kind: z.enum(FINDING_KINDS),
      value: z.string(),
      path: z.string().optional(),
    }),
  ),
  next_steps: z.array(z.string()),
  summary: z.string(),
});

export type AgentRunResult = {
  agentId: AgentId;
  text: string;
  completion: AgentCompletion;
};

/**
 * Run one specialist subagent with exploration + scratchpad tools.
 * Exports structured state for the coordinator manifest.
 */
export async function runSubagent(opts: {
  agentId: AgentId;
  rootDir: AbsolutePath;
  goal: string;
  scratchpadPath: string;
  /** Injected Phase 1 summary for Phase 2 agents. */
  phase1Summary?: string;
}): Promise<AgentRunResult> {
  const def = SUBAGENTS[opts.agentId];
  const exploredPaths = new Set<string>();
  const tools = buildExplorationTools({
    rootDir: opts.rootDir,
    scratchpadPath: opts.scratchpadPath,
    agentId: opts.agentId,
    exploredPaths,
  });

  // Scratchpad-first: surface existing findings in the user brief too.
  const pad = await readScratchpad(opts.scratchpadPath);
  const scratchPreview =
    pad.findings.length === 0
      ? "(scratchpad empty)"
      : pad.findings
          .slice(-30)
          .map((f) => `- [${f.kind}] ${f.value}${f.path ? ` @ ${f.path}` : ""}`)
          .join("\n");

  const brief = [
    def.brief({
      rootDir: opts.rootDir,
      goal: opts.goal,
      summary: opts.phase1Summary,
    }),
    "",
    "Current scratchpad preview (also available via read_scratchpad):",
    scratchPreview,
    "",
    "When finished, leave a short textual summary of what you found.",
  ].join("\n");

  console.log(`[subagent] starting ${opts.agentId}`);

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 64000,
    stream: true,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: def.systemPrompt,
    tools,
    messages: [{ role: "user", content: brief }],
    max_iterations: 12,
  });

  let last: Anthropic.Beta.Messages.BetaMessage | undefined;
  try {
    for await (const stream of runner) {
      const message = await stream.finalMessage();
      last = message;
      if (message.stop_reason === "pause_turn") {
        runner.pushMessages({ role: "assistant", content: message.content });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const completion: AgentCompletion = {
      agentId: opts.agentId,
      status: "failed",
      exploredPaths: [...exploredPaths].map(asRelativePath),
      keyFindings: [],
      nextSteps: [`retry:${opts.agentId}`],
      finishedAt: new Date().toISOString(),
      error: message,
    };
    return { agentId: opts.agentId, text: "", completion };
  }

  const final = last ?? (await runner.done());
  const text = textFromMessage(final);

  // Structured export for crash recovery (plus whatever landed in scratchpad).
  const structured = await exportAgentState({
    agentId: opts.agentId,
    narrative: text,
    exploredPaths: [...exploredPaths],
    scratchpadPath: opts.scratchpadPath,
  });

  const completion: AgentCompletion = {
    agentId: opts.agentId,
    status: "completed",
    exploredPaths: structured.explored_paths.map(asRelativePath),
    keyFindings: structured.key_findings.map((f) => ({
      kind: f.kind,
      value: f.value,
      path: f.path ? asRelativePath(f.path) : undefined,
      agentId: opts.agentId,
      ts: new Date().toISOString(),
    })),
    nextSteps: structured.next_steps,
    finishedAt: new Date().toISOString(),
  };

  // Ensure findings are on the scratchpad even if the model forgot append.
  if (completion.keyFindings.length > 0) {
    await appendScratchpadFindings(opts.scratchpadPath, completion.keyFindings);
  }

  console.log(
    `[subagent] finished ${opts.agentId} — ${completion.keyFindings.length} findings, ${completion.exploredPaths.length} paths`,
  );

  return { agentId: opts.agentId, text: structured.summary || text, completion };
}

/** Ask Claude to emit structured agent state from narrative + scratchpad. */
async function exportAgentState(opts: {
  agentId: AgentId;
  narrative: string;
  exploredPaths: string[];
  scratchpadPath: string;
}): Promise<z.infer<typeof AgentExportSchema>> {
  const pad = await readScratchpad(opts.scratchpadPath);
  const agentFindings = pad.findings.filter((f) => f.agentId === opts.agentId);

  const parsed = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      format: zodOutputFormat(AgentExportSchema),
      effort: "medium",
    },
    messages: [
      {
        role: "user",
        content: [
          `Agent: ${opts.agentId}`,
          "Export structured exploration state for crash recovery.",
          "",
          "Narrative:",
          opts.narrative.slice(0, 8000),
          "",
          "Explored paths (runtime):",
          JSON.stringify(opts.exploredPaths.slice(0, 200)),
          "",
          "Scratchpad findings from this agent:",
          JSON.stringify(agentFindings, null, 2),
          "",
          "Return explored_paths, key_findings, next_steps, and a short summary.",
        ].join("\n"),
      },
    ],
  });

  if (parsed.parsed_output) return parsed.parsed_output;

  // Fallback if parse failed — still persist runtime paths + scratchpad.
  return {
    explored_paths: opts.exploredPaths,
    key_findings: agentFindings.map((f) => ({
      kind: f.kind,
      value: f.value,
      path: f.path,
    })),
    next_steps: [],
    summary: opts.narrative.slice(0, 2000),
  };
}

// ---------------------------------------------------------------------------
// Phase 1 → summary → Phase 2 injection
// ---------------------------------------------------------------------------

const Phase1SummarySchema = z.object({
  summary: z
    .string()
    .describe("Dense paragraph + bullets covering Phase 1 discoveries"),
  priority_modules: z
    .array(z.string())
    .describe("Relative paths or symbols Phase 2 should trace first"),
  open_questions: z.array(z.string()),
});

/**
 * Compress Phase 1 scratchpad findings into a summary injected into Phase 2 prompts.
 */
export async function summarisePhase1(
  scratchpadPath: string,
): Promise<{ summary: string; priorityModules: string[]; openQuestions: string[] }> {
  const pad = await readScratchpad(scratchpadPath);
  const msg = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      format: zodOutputFormat(Phase1SummarySchema),
      effort: "high",
    },
    system:
      "You summarise codebase exploration findings for a Phase 2 dependency tracer. Be concrete: name files, classes, integrations.",
    messages: [
      {
        role: "user",
        content: [
          "Summarise these Phase 1 findings for injection into a Phase 2 subagent prompt.",
          "Focus on: test layout, external integrations, and modules worth tracing.",
          "",
          JSON.stringify(pad, null, 2),
        ].join("\n"),
      },
    ],
  });

  const out = msg.parsed_output;
  if (!out) {
    const fallback = pad.findings
      .map((f) => `- [${f.kind}] ${f.value}${f.path ? ` @ ${f.path}` : ""}`)
      .join("\n");
    return {
      summary: fallback || "No Phase 1 findings.",
      priorityModules: [],
      openQuestions: [],
    };
  }
  return {
    summary: [
      out.summary,
      "",
      "Priority modules:",
      ...out.priority_modules.map((m) => `- ${m}`),
      "",
      "Open questions:",
      ...out.open_questions.map((q) => `- ${q}`),
    ].join("\n"),
    priorityModules: out.priority_modules,
    openQuestions: out.open_questions,
  };
}

/**
 * Build a Phase 2 brief with the Phase 1 summary injected.
 * Exported for tests / inspection of the injection contract.
 */
export function buildPhase2Prompt(opts: {
  agentId: Phase2Agent;
  rootDir: string;
  goal: string;
  phase1Summary: string;
}): string {
  return SUBAGENTS[opts.agentId].brief({
    rootDir: opts.rootDir,
    goal: opts.goal,
    summary: opts.phase1Summary,
  });
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export type CoordinatorOptions = {
  rootDir?: string;
  goal?: string;
  stateDir?: string;
  scratchpadPath?: string;
  manifestPath?: string;
  /** Force a fresh run (ignore existing manifest). */
  fresh?: boolean;
};

export type CoordinatorResult = {
  manifest: ExplorationManifest;
  scratchpad: Scratchpad;
  resumed: boolean;
  phase1Summary: string | null;
};

/**
 * Coordinator entrypoint.
 *
 * - Loads manifest for crash recovery when present
 * - Skips completed agents
 * - After Phase 1: summarises scratchpad and injects into Phase 2 briefs
 * - Checkpoints manifest after every agent
 */
export async function runCoordinator(
  options: CoordinatorOptions = {},
): Promise<CoordinatorResult> {
  const rootDir = asAbsolutePath(
    path.resolve(options.rootDir ?? path.join(here, "..", "..")),
  );
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const scratchpadPath = options.scratchpadPath ?? path.join(stateDir, "scratchpad.json");
  const manifestPath = options.manifestPath ?? path.join(stateDir, "manifest.json");
  const goal =
    options.goal ??
    "Map tests, external integrations, and key dependency chains in this repository.";

  await ensureStateDir(stateDir);

  let resumed = false;
  let manifest =
    options.fresh ? null : await loadManifest(manifestPath);

  if (manifest && path.resolve(manifest.rootDir) === rootDir) {
    resumed = true;
    console.log(
      `[coordinator] resuming from manifest (phase=${manifest.phase}, completed=${Object.keys(manifest.completions).join(", ") || "none"})`,
    );
  } else {
    manifest = emptyManifest(rootDir, goal);
    await writeScratchpad(scratchpadPath, emptyScratchpad());
    await saveManifest(manifestPath, manifest);
    console.log(`[coordinator] starting fresh exploration of ${rootDir}`);
  }

  // ---- Phase 1 ----
  if (manifest.phase === "phase1") {
    for (const agentId of PHASE1_AGENTS) {
      if (isAgentComplete(manifest, agentId)) {
        console.log(`[coordinator] skip completed agent ${agentId}`);
        continue;
      }

      // Scratchpad read happens inside the subagent; coordinator also preloads.
      const before = await readScratchpad(scratchpadPath);
      console.log(
        `[coordinator] scratchpad has ${before.findings.length} findings before ${agentId}`,
      );

      const { completion } = await runSubagent({
        agentId,
        rootDir,
        goal: manifest.goal,
        scratchpadPath,
      });

      manifest = applyAgentCompletion(manifest, completion);
      manifest.nextSteps = remainingSteps(manifest);
      await saveManifest(manifestPath, manifest);
      console.log(`[coordinator] checkpointed after ${agentId}`);
    }

    const phase1Done = PHASE1_AGENTS.every((a) => isAgentComplete(manifest!, a));
    if (phase1Done) {
      console.log("[coordinator] Phase 1 complete — summarising for injection");
      const { summary } = await summarisePhase1(scratchpadPath);
      manifest.phase1Summary = summary;
      manifest.phase = "phase2";
      manifest.nextSteps = PHASE2_AGENTS.map((a) => `run:${a}`);
      await saveManifest(manifestPath, manifest);
    }
  }

  // ---- Phase 2 (summary injected into briefs) ----
  if (manifest.phase === "phase2") {
    const summary = manifest.phase1Summary ?? (await summarisePhase1(scratchpadPath)).summary;
    manifest.phase1Summary = summary;

    for (const agentId of PHASE2_AGENTS) {
      if (isAgentComplete(manifest, agentId)) {
        console.log(`[coordinator] skip completed agent ${agentId}`);
        continue;
      }

      // Demonstrate injection contract in logs.
      const injectedBrief = buildPhase2Prompt({
        agentId,
        rootDir,
        goal: manifest.goal,
        phase1Summary: summary,
      });
      console.log(
        `[coordinator] Phase 2 brief for ${agentId} includes summary (${summary.length} chars)`,
      );
      console.log(`[brief-preview]\n${injectedBrief.slice(0, 500)}…\n`);

      const before = await readScratchpad(scratchpadPath);
      console.log(
        `[coordinator] scratchpad has ${before.findings.length} findings before ${agentId}`,
      );

      const { completion } = await runSubagent({
        agentId,
        rootDir,
        goal: manifest.goal,
        scratchpadPath,
        phase1Summary: summary,
      });

      manifest = applyAgentCompletion(manifest, completion);
      manifest.nextSteps = remainingSteps(manifest);
      await saveManifest(manifestPath, manifest);
      console.log(`[coordinator] checkpointed after ${agentId}`);
    }

    const phase2Done = PHASE2_AGENTS.every((a) => isAgentComplete(manifest!, a));
    if (phase2Done) {
      manifest.phase = "complete";
      manifest.nextSteps = [];
      await saveManifest(manifestPath, manifest);
      console.log("[coordinator] exploration complete");
    }
  }

  const scratchpad = await readScratchpad(scratchpadPath);
  return {
    manifest,
    scratchpad,
    resumed,
    phase1Summary: manifest.phase1Summary,
  };
}

function remainingSteps(manifest: ExplorationManifest): string[] {
  const steps: string[] = [];
  if (manifest.phase === "phase1" || manifest.phase === "phase2") {
    const agents =
      manifest.phase === "phase1" ? PHASE1_AGENTS : PHASE2_AGENTS;
    for (const a of agents) {
      if (!isAgentComplete(manifest, a)) steps.push(`run:${a}`);
    }
  }
  if (
    manifest.phase === "phase1" &&
    PHASE1_AGENTS.every((a) => isAgentComplete(manifest, a))
  ) {
    steps.push("summarise_phase1", ...PHASE2_AGENTS.map((a) => `run:${a}`));
  }
  return steps;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  const fresh = process.argv.includes("--fresh");
  const resume = process.argv.includes("--resume");
  void runCoordinator({ fresh: fresh && !resume })
    .then((result) => {
      console.log("\n=== Coordinator result ===");
      console.log(`resumed: ${result.resumed}`);
      console.log(`phase: ${result.manifest.phase}`);
      console.log(`findings: ${result.scratchpad.findings.length}`);
      console.log(`explored: ${result.manifest.exploredPaths.length}`);
      if (result.phase1Summary) {
        console.log("\n--- Phase 1 summary ---\n");
        console.log(result.phase1Summary);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
