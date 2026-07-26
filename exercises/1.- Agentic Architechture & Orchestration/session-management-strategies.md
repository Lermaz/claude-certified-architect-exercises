# Implement Session Management Strategies

**Domain:** Agentic Architecture & Orchestration · Task 1.7  
**Difficulty:** ~45 minutes  
**Guide:** [1.7 — Session State and Resumption](https://claudecertificationguide.com/learn/1-agentic-architecture/1-7-session-state-resumption)  
**SDK sessions:** [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

Session management decides how an agent keeps continuity across work sessions. In long-running tasks the context accumulates tool results, file analyses, and reasoning. This exercise trains when to **continue** that state, when to **branch** it, and when to **start fresh**.

---

## What you'll learn

- The three session management options: **resume**, **fork_session**, and **fresh start with summary injection**
- Why resuming after file changes leads to the **stale context problem**
- How structured summary injection preserves knowledge without stale tool results
- When **targeted re-analysis** is more efficient than full re-exploration
- The difference between **fork_session** (divergent exploration) and **resume** (continuation)

---

## Three options (cheat sheet)

| Option | Job | Use when | Avoid when |
| --- | --- | --- | --- |
| `--resume` / `resume` | Continue the same conversation; full history restored (tool results included) | Prior context still valid; files unchanged | Files or deps changed since last session |
| `fork_session` / `forkSession` | Independent branch from a shared baseline | Explore divergent approaches from the same analysis | You only want to continue one line of work, or fix stale context |
| Fresh start + summary injection | New session; inject curated prior findings only | Tool results are stale; history is cluttered | Prior context is still valid and you want the full transcript |

**Key concept:** resume = continuation · fork = divergence · fresh + summary = escape hatch for stale / degraded context.

---

## The stale context problem

Resuming after code edits restores **old tool results** (e.g. prior `Read` of `auth.ts`). The model may:

- recommend fixes that were already applied
- reference code that no longer exists
- contradict itself when a fresh read and a stale tool result both sit in history

**Naive fix (insufficient):** resume and ask it to re-read the changed files — stale results remain in the transcript and can still bias reasoning.

**Correct fix:** fresh session + structured summary of prior findings + name the changed files for **targeted** re-analysis. No stale tool results; knowledge preserved without raw dumps.

**Exam trap:** `fork_session` after file changes still **inherits** the stale transcript. Fork is not a stale-context remedy.

---

## Decision matrix

| Scenario | Best option |
| --- | --- |
| Continuing work from yesterday, no files changed | `--resume` |
| Comparing two refactoring approaches | `fork_session` |
| Resuming after modifying 3 of 50 files | Fresh start + summary |
| Long session with cluttered history | Fresh start + summary |
| Testing strategy vs documentation strategy from same analysis | `fork_session` |
| Resuming after dependency updates | Fresh start + summary |

---

## Build exercise — six steps

Work against a small multi-file codebase (≈10 source files). In this repo, use `exercises/fixtures/code-review-mock/` (or a sandbox copy under `exercises/fixtures/session-mgmt-sandbox/`).

### 1. Named baseline analysis session

Create a Claude Code / Agent SDK session that reads and analyses ~10 source files. Name it so you can resume later (CLI: memorable `--resume` name; SDK: capture `session_id` and optionally `renameSession`).

**Why:** Named sessions enable continuation across breaks. The exam tests when resume is appropriate (no file drift) vs when it creates stale context (files changed).

**You should see:** A named session that produces per-file findings.

### 2. Record a structured summary

Capture key findings as a compact document: file name → issues → severity → recommendations. Conclusions only — **not** raw tool output.

**Why:** This is the knowledge you inject into a fresh session later. Exam cares that you preserve findings without carrying stale tool results.

**You should see:** A concise structured summary suitable for prompt injection.

### 3. Modify three files

Fix some of the issues from step 2 in three concrete files (changes must be substantive enough that old vs new analysis would disagree).

**Why:** This creates the stale-context setup: history still holds pre-fix file contents as tool results while disk has post-fix code.

**You should see:** Three modified files with real fixes.

### 4. Resume and observe stale context

Resume the named session (`--resume` / `options.resume`). Ask about the modified files and watch for contradictions: already-fixed issues, missing code, inconsistent guidance.

**Why:** Live demo of the stale context problem. Old tool results still sit in the transcript.

**You should see:** Contradictory or outdated advice about the three changed files.

### 5. Fresh start + summary + targeted re-analysis

Start a **new** session. Inject the step-2 summary. Explicitly list the three changed files and instruct the agent to re-read **only those**, trusting the summary for everything else.

**Why:** Correct approach when files changed: no stale tool results, preserved knowledge, no wasteful full re-exploration of all ~10 files.

**You should see:** Consistent advice based on current file contents for the three targets.

### 6. Compare quality

Side-by-side: stale resume (step 4) vs fresh + targeted re-analysis (step 5).

**Why:** Shows why the exam prefers fresh start + summary injection over naive resume after edits.

**You should see:** Resume contradictory/outdated; fresh session accurate and consistent.

---

## Practice scenario (exam shape)

A developer resumes a Claude Code session after modifying 3 files in a 50-file codebase. The agent gives contradictory advice about those files. Most appropriate approach?

- **A.** Resume and ask it to re-read only the 3 modified files  
- **B.** New session and re-analyse all 50 files from scratch  
- **C.** Fresh session + injected prior summary + inform it of the 3 changes for targeted re-analysis  
- **D.** `fork_session` so a new branch can incorporate the file changes  

**Answer: C.** A leaves stale results in history. B wastes work. D inherits stale history. C drops stale tool results, keeps knowledge, and re-analyses only what changed.

---

## Implementation notes (this repo)

| Concern | Approach |
| --- | --- |
| Codebase under test | Seed 10 files from `fixtures/code-review-mock` into `fixtures/session-mgmt-sandbox` |
| Example changed files | `02-logger.ts`, `04-auth.ts`, `07-payments.ts` |
| CLI resume | `claude --resume <session-name>` |
| Agent SDK resume | `query({ options: { resume: sessionId } })` |
| Agent SDK fork | `forkSession(id)` or `query({ options: { resume, forkSession: true } })` |
| Fresh + summary | New `query()` (no `resume`) whose prompt embeds the structured summary + changed-file list |

Optional env knobs if you wire a runner later:

- `DEMO_FORK=1` — also branch the baseline (divergent exploration demo; not a stale-context fix)
- `RESTORE_SANDBOX=1` — revert the three file patches after the run

---

## Sources

- [Claude Certification Guide — 1.7 Session State and Resumption](https://claudecertificationguide.com/learn/1-agentic-architecture/1-7-session-state-resumption)
- Claude Code documentation — Anthropic
- [Claude Agent SDK — sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
