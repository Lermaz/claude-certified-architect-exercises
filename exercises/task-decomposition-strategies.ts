import Anthropic from "@anthropic-ai/sdk";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * task-decomposition-strategies.ts
 *
 * Fixed sequential pipeline (prompt chaining) for multi-file code review:
 *   1. Single-pass baseline — all files in one prompt (attention dilution demo)
 *   2. Per-file local analysis — one dedicated pass per file
 *   3. Cross-file integration — data flow / API / pattern consistency
 *   4. Compare single-pass vs multi-pass; flag dilution artefacts
 *
 * Why per-file + integration: attention dilution is architectural, not a
 * "bigger model / better prompt" problem. Batching without an integration
 * pass still misses cross-cutting issues.
 */

const MODEL = "claude-opus-4-8";
const MIN_SOURCE_FILES = 10;
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

const client = new Anthropic();

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MOCK_DIR = path.join(here, "fixtures", "code-review-mock");

// ---------------------------------------------------------------------------
// Advanced types — brands, literals, mapped/conditional helpers
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Opaque path brands — stops mixing relative / absolute / directory strings. */
export type RelativePath = Brand<string, "RelativePath">;
export type AbsolutePath = Brand<string, "AbsolutePath">;
export type DirectoryPath = Brand<string, "DirectoryPath">;

export const asRelativePath = (p: string): RelativePath => p as RelativePath;
export const asAbsolutePath = (p: string): AbsolutePath => p as AbsolutePath;
export const asDirectoryPath = (p: string): DirectoryPath => p as DirectoryPath;

/** Non-empty tuple — encodes the ≥1 file invariant after load. */
export type NonEmptyArray<T> = readonly [T, ...T[]];

export function assertNonEmpty<T>(items: readonly T[], label: string): NonEmptyArray<T> {
  if (items.length === 0) throw new Error(`${label}: expected non-empty array`);
  return items as NonEmptyArray<T>;
}

/** Source extension union → template-literal file names. */
export type SourceExt = "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs";
export type SourceFileName = `${string}.${SourceExt}`;

export type SourceFile = {
  relativePath: RelativePath;
  absolutePath: AbsolutePath;
  content: string;
};

/** Const-asserted severity ladder — union derives from values. */
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CROSS_FILE_CATEGORIES = [
  "data_flow",
  "api_consistency",
  "pattern_consistency",
  "other",
] as const;
export type CrossFileCategory = (typeof CROSS_FILE_CATEGORIES)[number];

export type Finding = {
  file: RelativePath | string;
  line: number | null;
  severity: Severity;
  category: string;
  summary: string;
};

/** Raw LLM finding before normalisation — all fields optional/unknown. */
export type RawFinding = Partial<{
  [K in keyof Finding]: unknown;
}>;

/** Mapped: every severity → count (exhaustive scoreboard). */
export type SeverityCounts = { [S in Severity]: number };

/** Mapped: every severity → findings of that severity. */
export type FindingsBySeverity = { [S in Severity]: Finding[] };

/** Pick findings matching a severity (conditional filter). */
export type FindingsOfSeverity<S extends Severity> = Extract<
  Finding,
  { severity: S }
>;

/** Remap SourceFile keys → getters (skill: key remapping). */
export type SourceFileGetters = {
  [K in keyof SourceFile as `get${Capitalize<K>}`]: () => SourceFile[K];
};

/** Prompt fence marker — template literal keeps the delimiter typed. */
export type FileFence = `===== FILE: ${RelativePath} =====`;

export function fileFence(path: RelativePath): FileFence {
  return `===== FILE: ${path} =====`;
}

export type FileReview = {
  file: RelativePath;
  bugCount: number;
  findings: Finding[];
  raw?: string;
};

export type CrossFileIssue = {
  files: RelativePath[] | string[];
  severity: Severity;
  category: CrossFileCategory;
  summary: string;
};

/** Discriminated union — narrow on `mode`. */
export type SinglePassResult = {
  mode: "single_pass";
  fileReviews: FileReview[];
  findings: Finding[];
  raw: string;
};

export type MultiPassResult = {
  mode: "multi_pass";
  localReviews: FileReview[];
  crossFileIssues: CrossFileIssue[];
  findings: Finding[];
};

export type ReviewResult = SinglePassResult | MultiPassResult;

export type ReviewMode = ReviewResult["mode"];

/** Conditional: extract the result shape for a given mode. */
export type ReviewResultOf<M extends ReviewMode> = Extract<ReviewResult, { mode: M }>;

export type DepthRow = {
  file: RelativePath;
  findingCount: number;
};

export type DilutionArtefact = {
  pattern: string;
  flaggedIn: RelativePath[];
  approvedIn: RelativePath[];
  note: string;
};

export type ComparisonReport = {
  singlePassIssueCount: number;
  multiPassIssueCount: number;
  multiPassLocalIssueCount: number;
  crossFileOnlyCount: number;
  singlePassDepthByFile: DepthRow[];
  multiPassDepthByFile: DepthRow[];
  /** Exhaustive severity tallies for both strategies. */
  singlePassBySeverity: SeverityCounts;
  multiPassBySeverity: SeverityCounts;
  dilutionArtefacts: DilutionArtefact[];
  summary: string;
};

export type CodeReviewRun = {
  directory: AbsolutePath;
  files: NonEmptyArray<SourceFile>;
  singlePass: ReviewResultOf<"single_pass">;
  multiPass: ReviewResultOf<"multi_pass">;
  comparison: ComparisonReport;
};

/** Pattern detector config — `satisfies` locks shape without widening literals. */
const DILUTION_PATTERNS = [
  {
    pattern: "forEach push-accumulate",
    matcher: /\.forEach\s*\([^)]*=>\s*\{[^}]*\.push\(/s,
    note: "Identical inefficient forEach accumulate flagged in some files, ignored in others",
  },
  {
    pattern: "unchecked optional member access",
    matcher: /\b\w+\.\w+\b(?!\?)/,
    note: "Null-unsafe property access treated inconsistently across files",
  },
] as const satisfies readonly {
  pattern: string;
  matcher: RegExp;
  note: string;
}[];

type DilutionPatternName = (typeof DILUTION_PATTERNS)[number]["pattern"];

function isSeverity(value: unknown): value is Severity {
  return (
    typeof value === "string" &&
    (SEVERITIES as readonly string[]).includes(value)
  );
}

function isCrossFileCategory(value: unknown): value is CrossFileCategory {
  return (
    typeof value === "string" &&
    (CROSS_FILE_CATEGORIES as readonly string[]).includes(value)
  );
}

function emptySeverityCounts(): SeverityCounts {
  return { critical: 0, high: 0, medium: 0, low: 0 };
}

export function tallyBySeverity(findings: readonly Finding[]): SeverityCounts {
  return findings.reduce<SeverityCounts>((acc, f) => {
    if (isSeverity(f.severity)) acc[f.severity] += 1;
    return acc;
  }, emptySeverityCounts());
}

export function groupFindingsBySeverity(
  findings: readonly Finding[],
): FindingsBySeverity {
  const out: FindingsBySeverity = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };
  for (const f of findings) {
    if (isSeverity(f.severity)) out[f.severity].push(f);
  }
  return out;
}

/** Type-safe mode switch — exhaustiveness checked via `never`. */
export function describeReview(result: ReviewResult): string {
  switch (result.mode) {
    case "single_pass":
      return `single_pass (${result.findings.length} findings, ${result.fileReviews.length} files)`;
    case "multi_pass":
      return `multi_pass (${result.findings.length} local + ${result.crossFileIssues.length} cross-file)`;
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

/**
 * Load source files from a directory. Requires ≥ MIN_SOURCE_FILES — the
 * threshold where attention dilution becomes observable in the exam scenario.
 */
export async function loadSourceFiles(
  directoryPath: string | DirectoryPath,
): Promise<NonEmptyArray<SourceFile>> {
  const absDir = asAbsolutePath(path.resolve(directoryPath));
  const entries = await readdir(absDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && SOURCE_EXT.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  if (files.length < MIN_SOURCE_FILES) {
    throw new Error(
      `Expected ≥${MIN_SOURCE_FILES} source files in ${absDir}, found ${files.length}`,
    );
  }

  const loaded: SourceFile[] = [];
  for (const name of files) {
    const absolutePath = asAbsolutePath(path.join(absDir, name));
    loaded.push({
      relativePath: asRelativePath(name),
      absolutePath,
      content: await readFile(absolutePath, "utf8"),
    });
  }
  return assertNonEmpty(loaded, "loadSourceFiles");
}

// ---------------------------------------------------------------------------
// Claude helpers
// ---------------------------------------------------------------------------

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function parseJsonBlock<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced?.[1] ?? text).trim();
  const objStart = raw.indexOf("{");
  const objEnd = raw.lastIndexOf("}");
  const arrStart = raw.indexOf("[");
  const arrEnd = raw.lastIndexOf("]");

  let candidate = raw;
  if (objStart !== -1 && objEnd !== -1 && (arrStart === -1 || objStart < arrStart)) {
    candidate = raw.slice(objStart, objEnd + 1);
  } else if (arrStart !== -1 && arrEnd !== -1) {
    candidate = raw.slice(arrStart, arrEnd + 1);
  }
  return JSON.parse(candidate) as T;
}

async function askClaude(system: string, user: string): Promise<string> {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system,
    messages: [{ role: "user", content: user }],
  });
  const message = await stream.finalMessage();
  return extractText(message);
}

function formatFilesBundle(files: readonly SourceFile[]): string {
  return files
    .map(
      (f) => `${fileFence(f.relativePath)}\n\`\`\`typescript\n${f.content}\n\`\`\``,
    )
    .join("\n\n");
}

function normalizeFinding(raw: RawFinding, fallbackFile: RelativePath): Finding {
  const line =
    typeof raw.line === "number" && Number.isFinite(raw.line) ? raw.line : null;
  return {
    file:
      typeof raw.file === "string" && raw.file.length > 0
        ? raw.file
        : fallbackFile,
    line,
    severity: isSeverity(raw.severity) ? raw.severity : "medium",
    category: typeof raw.category === "string" ? raw.category : "other",
    summary: typeof raw.summary === "string" ? raw.summary : "",
  };
}

function normalizeFindings(
  findings: readonly RawFinding[] | undefined,
  fallbackFile: RelativePath,
): Finding[] {
  return (findings ?? []).map((f) => normalizeFinding(f, fallbackFile));
}

function groupByFile(
  findings: readonly Finding[],
  files: readonly SourceFile[],
): FileReview[] {
  return files.map((file) => {
    const fileFindings = findings.filter(
      (f) =>
        f.file === file.relativePath ||
        (typeof f.file === "string" && f.file.endsWith(file.relativePath)),
    );
    return {
      file: file.relativePath,
      bugCount: fileFindings.length,
      findings: fileFindings,
    };
  });
}

function normalizeCrossFileIssues(
  issues: readonly Partial<CrossFileIssue>[] | undefined,
): CrossFileIssue[] {
  return (issues ?? []).map((issue) => ({
    files: (issue.files ?? []).map((f) =>
      typeof f === "string" ? f : String(f),
    ),
    severity: isSeverity(issue.severity) ? issue.severity : "medium",
    category: isCrossFileCategory(issue.category) ? issue.category : "other",
    summary: typeof issue.summary === "string" ? issue.summary : "",
  }));
}

// ---------------------------------------------------------------------------
// Phase 1 — Single-pass baseline (attention dilution)
// ---------------------------------------------------------------------------

const SINGLE_PASS_SYSTEM =
  "You are a senior code reviewer. Review every file thoroughly for bugs, security issues, and quality problems. Return ONLY JSON.";

/**
 * Baseline: dump all files into one prompt. Expect uneven depth —
 * early files get line-level detail; later files get skimmed.
 */
export async function singlePassReview(
  files: NonEmptyArray<SourceFile> | SourceFile[],
): Promise<ReviewResultOf<"single_pass">> {
  const bundle = assertNonEmpty(files, "singlePassReview");
  const user = [
    `Review ALL ${bundle.length} source files below in a SINGLE pass.`,
    `For each issue include file, line (or null), severity (${SEVERITIES.join("|")}), category, summary.`,
    `Be thorough for every file. Prefer specific line references.`,
    ``,
    `Return ONLY JSON:`,
    `{ "findings": Finding[] }`,
    ``,
    formatFilesBundle(bundle),
  ].join("\n");

  console.log(`[single-pass] reviewing ${bundle.length} files in one prompt…`);
  const raw = await askClaude(SINGLE_PASS_SYSTEM, user);
  const parsed = parseJsonBlock<{ findings?: RawFinding[] }>(raw);
  const findings = normalizeFindings(parsed.findings, bundle[0].relativePath);

  return {
    mode: "single_pass",
    fileReviews: groupByFile(findings, bundle),
    findings,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — Per-file local analysis (fixed pipeline step 1)
// ---------------------------------------------------------------------------

const LOCAL_PASS_SYSTEM = [
  "You are a senior code reviewer doing a LOCAL analysis of ONE file.",
  "Focus only on this file: bugs, null safety, security, complexity, style.",
  "Do not invent cross-file issues. Return ONLY JSON.",
].join(" ");

/**
 * One dedicated pass per file — full attention budget, structured feedback.
 */
export async function reviewFileLocally(file: SourceFile): Promise<FileReview> {
  const user = [
    `Review this single file thoroughly.`,
    `Return ONLY JSON:`,
    `{`,
    `  "bugCount": number,`,
    `  "findings": [ { "file": string, "line": number|null, "severity": "${SEVERITIES.join('"|"')}", "category": string, "summary": string } ]`,
    `}`,
    `Every finding.file MUST be "${file.relativePath}". Include line numbers when possible.`,
    ``,
    fileFence(file.relativePath),
    `\`\`\`typescript`,
    file.content,
    `\`\`\``,
  ].join("\n");

  console.log(`[local] ${file.relativePath}`);
  const raw = await askClaude(LOCAL_PASS_SYSTEM, user);
  const parsed = parseJsonBlock<{ bugCount?: number; findings?: RawFinding[] }>(
    raw,
  );
  const findings = normalizeFindings(parsed.findings, file.relativePath).map(
    (f): Finding => ({ ...f, file: file.relativePath }),
  );

  return {
    file: file.relativePath,
    bugCount: parsed.bugCount ?? findings.length,
    findings,
    raw,
  };
}

export async function perFileLocalReviews(
  files: readonly SourceFile[],
): Promise<FileReview[]> {
  // Sequential passes keep the pipeline deterministic / easy to attribute.
  // (Parallel fan-out is fine too — still fixed structure, not dynamic planning.)
  const reviews: FileReview[] = [];
  for (const file of files) {
    reviews.push(await reviewFileLocally(file));
  }
  return reviews;
}

// ---------------------------------------------------------------------------
// Phase 3 — Cross-file integration (fixed pipeline step 2)
// ---------------------------------------------------------------------------

const INTEGRATION_SYSTEM = [
  "You are a senior code reviewer doing a CROSS-FILE integration pass.",
  "You receive per-file summaries (not full sources). Focus ONLY on relationships:",
  "data flow, API consistency, pattern usage consistency, import/dependency issues.",
  "Return ONLY JSON.",
].join(" ");

/**
 * Integration pass over local summaries — catches what batching alone misses.
 */
export async function crossFileIntegrationPass(
  files: readonly SourceFile[],
  localReviews: readonly FileReview[],
): Promise<CrossFileIssue[]> {
  const summaries = localReviews.map((r) => ({
    file: r.file,
    bugCount: r.bugCount,
    findings: r.findings.map(
      (f): Pick<Finding, "line" | "severity" | "category" | "summary"> => ({
        line: f.line,
        severity: f.severity,
        category: f.category,
        summary: f.summary,
      }),
    ),
  }));

  // Compact source map (signatures / exports) so integration can reason about
  // APIs without reloading full file bodies into one diluted pass.
  const stubs = files.map((f) => ({
    file: f.relativePath,
    preview: f.content
      .split("\n")
      .filter((l) => /^\s*(export|import)\b/.test(l))
      .slice(0, 40)
      .join("\n"),
  }));

  const user = [
    `Given per-file review summaries and export/import stubs, find CROSS-FILE issues only.`,
    `Look for: data flow bugs between modules, inconsistent auth/API headers,`,
    `identical patterns treated differently, dependency / call-order problems.`,
    ``,
    `Return ONLY JSON:`,
    `{ "crossFileIssues": [ { "files": string[], "severity": "${SEVERITIES.join('"|"')}", "category": "${CROSS_FILE_CATEGORIES.join('"|"')}", "summary": string } ] }`,
    ``,
    `PER-FILE SUMMARIES:`,
    JSON.stringify(summaries, null, 2),
    ``,
    `EXPORT/IMPORT STUBS:`,
    JSON.stringify(stubs, null, 2),
  ].join("\n");

  console.log(`[integration] cross-file pass over ${localReviews.length} summaries…`);
  const raw = await askClaude(INTEGRATION_SYSTEM, user);
  const parsed = parseJsonBlock<{
    crossFileIssues?: Partial<CrossFileIssue>[];
  }>(raw);
  return normalizeCrossFileIssues(parsed.crossFileIssues);
}

export async function multiPassReview(
  files: NonEmptyArray<SourceFile> | SourceFile[],
): Promise<ReviewResultOf<"multi_pass">> {
  const bundle = assertNonEmpty(files, "multiPassReview");
  const localReviews = await perFileLocalReviews(bundle);
  const crossFileIssues = await crossFileIntegrationPass(bundle, localReviews);
  const findings = localReviews.flatMap((r) => r.findings);

  return {
    mode: "multi_pass",
    localReviews,
    crossFileIssues,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Phase 4 — Comparison + attention-dilution artefacts
// ---------------------------------------------------------------------------

/**
 * Heuristic: same distinctive code pattern appears in multiple files, but
 * single-pass only flagged a subset — classic dilution artefact (forEach exam case).
 */
export function detectDilutionArtefacts(
  files: readonly SourceFile[],
  singlePass: ReviewResultOf<"single_pass">,
): DilutionArtefact[] {
  const forEachPattern = DILUTION_PATTERNS[0] satisfies {
    pattern: DilutionPatternName;
    matcher: RegExp;
    note: string;
  };

  // Narrow to the planted forEach pattern — most reliable artefact signal.
  const forEachFiles = files
    .filter((f) => /\.forEach\s*\(/.test(f.content) && /\.push\(/.test(f.content))
    .map((f) => f.relativePath);

  const artefacts: DilutionArtefact[] = [];
  if (forEachFiles.length >= 2) {
    const flaggedIn = forEachFiles.filter((file) =>
      singlePass.findings.some(
        (f) =>
          (f.file === file ||
            (typeof f.file === "string" && f.file.endsWith(file))) &&
          /foreach|forEach|inefficient|map\b|push/i.test(
            `${f.category} ${f.summary}`,
          ),
      ),
    );
    const approvedIn = forEachFiles.filter((f) => !flaggedIn.includes(f));
    if (flaggedIn.length > 0 && approvedIn.length > 0) {
      artefacts.push({
        pattern: forEachPattern.pattern,
        flaggedIn,
        approvedIn,
        note: forEachPattern.note,
      });
    } else {
      // Still record asymmetry in finding *counts* as a soft artefact signal.
      const depth = singlePass.fileReviews.map((r) => ({
        file: r.file,
        count: r.bugCount,
      }));
      const early = depth.slice(0, 5);
      const late = depth.slice(-5);
      const earlyAvg =
        early.reduce((s, d) => s + d.count, 0) / Math.max(early.length, 1);
      const lateAvg =
        late.reduce((s, d) => s + d.count, 0) / Math.max(late.length, 1);
      if (earlyAvg > lateAvg + 0.5) {
        artefacts.push({
          pattern: "depth drop-off (early vs late files)",
          flaggedIn: early.filter((d) => d.count > 0).map((d) => d.file),
          approvedIn: late.filter((d) => d.count === 0).map((d) => d.file),
          note: `Single-pass avg findings early=${earlyAvg.toFixed(1)} vs late=${lateAvg.toFixed(1)} — attention dilution symptom`,
        });
      }
    }
  }

  return artefacts;
}

export function compareReviews(
  files: readonly SourceFile[],
  singlePass: ReviewResultOf<"single_pass">,
  multiPass: ReviewResultOf<"multi_pass">,
): ComparisonReport {
  const dilutionArtefacts = detectDilutionArtefacts(files, singlePass);
  const multiPassLocalIssueCount = multiPass.findings.length;
  const crossFileOnlyCount = multiPass.crossFileIssues.length;
  const multiPassIssueCount = multiPassLocalIssueCount + crossFileOnlyCount;

  const singlePassDepthByFile: DepthRow[] = singlePass.fileReviews.map((r) => ({
    file: r.file,
    findingCount: r.bugCount,
  }));
  const multiPassDepthByFile: DepthRow[] = multiPass.localReviews.map((r) => ({
    file: r.file,
    findingCount: r.bugCount,
  }));

  const singlePassBySeverity = tallyBySeverity(singlePass.findings);
  const multiPassBySeverity = tallyBySeverity(multiPass.findings);

  const summary = [
    `Single-pass findings: ${singlePass.findings.length} ${describeReview(singlePass)}`,
    `Multi-pass local findings: ${multiPassLocalIssueCount}`,
    `Cross-file-only issues: ${crossFileOnlyCount}`,
    `Multi-pass total: ${multiPassIssueCount}`,
    `Severity (single): ${JSON.stringify(singlePassBySeverity)}`,
    `Severity (multi local): ${JSON.stringify(multiPassBySeverity)}`,
    `Dilution artefacts: ${dilutionArtefacts.length}`,
    dilutionArtefacts.length
      ? `Artefacts prove inconsistent treatment under single-pass (structural, not model-power).`
      : `No clear forEach-style artefact this run — still compare per-file depth drop-off.`,
  ].join("\n");

  return {
    singlePassIssueCount: singlePass.findings.length,
    multiPassIssueCount,
    multiPassLocalIssueCount,
    crossFileOnlyCount,
    singlePassDepthByFile,
    multiPassDepthByFile,
    singlePassBySeverity,
    multiPassBySeverity,
    dilutionArtefacts,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — fixed sequential pipeline
// ---------------------------------------------------------------------------

/**
 * Code review agent entry: directory path → load ≥10 files → single-pass
 * baseline → per-file locals → cross-file integration → comparison.
 */
export async function runCodeReviewAgent(
  directoryPath: string | DirectoryPath = asDirectoryPath(DEFAULT_MOCK_DIR),
): Promise<CodeReviewRun> {
  const files = await loadSourceFiles(directoryPath);
  const directory = asAbsolutePath(path.resolve(directoryPath));
  console.log(`[load] ${files.length} source files from ${directory}`);

  // Fixed pipeline — steps known up front (prompt chaining, not dynamic plan).
  const singlePass = await singlePassReview(files);
  const multiPass = await multiPassReview(files);
  const comparison = compareReviews(files, singlePass, multiPass);

  return {
    directory,
    files,
    singlePass,
    multiPass,
    comparison,
  };
}

function printComparison(comparison: ComparisonReport): void {
  console.log("\n========== COMPARISON ==========");
  console.log(comparison.summary);
  console.log("\nDepth by file (single-pass):");
  for (const row of comparison.singlePassDepthByFile) {
    console.log(`  ${row.file.padEnd(22)} ${row.findingCount}`);
  }
  console.log("\nDepth by file (multi-pass local):");
  for (const row of comparison.multiPassDepthByFile) {
    console.log(`  ${row.file.padEnd(22)} ${row.findingCount}`);
  }
  if (comparison.dilutionArtefacts.length) {
    console.log("\nAttention dilution artefacts:");
    for (const a of comparison.dilutionArtefacts) {
      console.log(`  pattern: ${a.pattern}`);
      console.log(`    flagged:  ${a.flaggedIn.join(", ") || "(none)"}`);
      console.log(`    approved: ${a.approvedIn.join(", ") || "(none)"}`);
      console.log(`    note: ${a.note}`);
    }
  }
  console.log("================================\n");
}

/**
 * CLI entry for the task-decomposition / attention-dilution exercise.
 *
 * Runs {@link runCodeReviewAgent} over `directoryPath` (branded
 * {@link DirectoryPath} or plain string; defaults to {@link DEFAULT_MOCK_DIR}):
 * single-pass baseline vs per-file + cross-file multi-pass, then prints the
 * comparison report, cross-file issues, and mode-discriminated review summaries.
 *
 * @param directoryPath - Source directory (≥10 source files). Accepts
 *   `string | DirectoryPath` so callers can pass a branded path from
 *   {@link asDirectoryPath} without widening back to `string`.
 * @returns Full {@link CodeReviewRun} (files, both review modes, comparison)
 *
 * @example
 * ```ts
 * const run = await taskDecompositionStrategies();
 * // or: await taskDecompositionStrategies(asDirectoryPath("/path/to/src"));
 * ```
 */
export async function taskDecompositionStrategies(
  directoryPath: string | DirectoryPath = asDirectoryPath(DEFAULT_MOCK_DIR),
): Promise<CodeReviewRun> {
  const result = await runCodeReviewAgent(directoryPath);
  printComparison(result.comparison);

  console.log(
    `[cross-file] ${result.multiPass.crossFileIssues.length} integration issues`,
  );
  for (const issue of result.multiPass.crossFileIssues) {
    console.log(
      `  [${issue.severity}/${issue.category}] ${issue.files.join(", ")} — ${issue.summary}`,
    );
  }

  // Exhaustive mode logging (discriminated union).
  console.log(`[review] ${describeReview(result.singlePass)}`);
  console.log(`[review] ${describeReview(result.multiPass)}`);

  return result;
}
