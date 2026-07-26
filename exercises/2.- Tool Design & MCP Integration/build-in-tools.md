#### Trace and Refactor a Deprecated Function Using Built-in Tools



**What you'll learn**



- Apply Grep for content search and Glob for path matching in the correct sequence

- Use incremental codebase discovery instead of reading all files upfront

- Select Edit as the primary modification tool and widen the anchor (or use `replace_all`) when Edit reports a non-unique match

- Trace function usage across wrapper modules and barrel files

- Follow the Grep-then-Glob pattern for finding callers and their test files



### 1. Use Grep to search for all callers of a target function (e.g. `processLegacyOrder`) across the codebase



**Why:** Grep searches file contents — it is the correct tool for finding function callers. Using Glob here would fail because Glob matches file paths, not contents. The exam tests this distinction directly and penalises candidates who confuse the two.



**You should see:** A list of file paths containing calls to `processLegacyOrder`, with line numbers and matching lines showing the exact call sites. For example: `src/OrderProcessor.ts:42: await processLegacyOrder(orderId)`.



```

Use the Grep tool with pattern "processLegacyOrder" and no path restriction to search the entire codebase. The results show every file and line that references this function.

```



### 2. Use Glob to find test files matching the caller filenames (e.g. `**/*.test.tsx`)



**Why:** Glob matches file paths by naming pattern — it is the correct tool for finding test files by extension or naming convention. This completes the Grep-then-Glob pattern: content search to find callers, then path matching to find their tests.



**You should see:** A list of test file paths matching the pattern, such as `src/OrderProcessor.test.tsx` and `src/RefundHandler.test.tsx`. These correspond to the caller files found by Grep in the previous step.



```

Use the Glob tool with pattern "**/*.test.tsx" to find all test files. For targeted results, use patterns like "**/OrderProcessor.test.*" for each caller file identified in step 1.

```



### 3. Use Read to examine each caller file and understand the usage pattern and context



**Why:** Reading files incrementally — only after Grep identifies which files matter — is the correct approach. Reading all source files upfront is a context-budget killer that the exam explicitly penalises. Each Read should be justified by what you discovered in the previous step.



**You should see:** The full contents of each caller file, showing how `processLegacyOrder` is called, what parameters are passed, how the return value is used, and whether the function is imported directly or through a wrapper module.



```

Use the Read tool on each file path from the Grep results. Check the import statement to see if the function is imported directly (from "./legacyOrders") or through a barrel file (from "./utils"). If it is re-exported, Grep for the barrel file module name to find indirect consumers.

```



### 4. Use Edit to replace the deprecated function call with the new API in each caller file



**Why:** Edit is the preferred modification tool because it targets specific text and uses less context than Read + Write. The exam penalises defaulting to Read + Write for every modification. Always try Edit first — it is faster and more precise.



**You should see:** Each caller file updated with the new API call replacing the deprecated one. For example, `processLegacyOrder(orderId)` replaced with `processOrder(orderId, { validate: true })`. The Edit tool confirms the replacement was made successfully.



```

Use the Edit tool with:

  old_string: "await processLegacyOrder(orderId)"

  new_string: "await processOrder(orderId, { validate: true })"

If the function call appears with different arguments in different places, include surrounding code to make old_string unique.

```



### 5. When Edit fails with a non-unique match, widen `old_string` with more surrounding lines until it pins down one location (or set `replace_all: true` if you actually want every occurrence updated). Only fall back to Read + Write if neither option can disambiguate the target



**Why:** Edit fails when the target text appears multiple times in the file — this is a safety mechanism, not a bug. Per the Edit tool documentation, the documented recovery is to expand the anchor with more surrounding context until it matches one place, or to use `replace_all` for global replacements. Both keep you on Edit and cost almost nothing in context. Read + Write loads the entire file for what is usually a single-line change — keep it as a last resort.



**You should see:** On the first try, Edit fails with an error like: `old_string matches 3 locations`. On the retry with a wider `old_string` that includes the surrounding function name or unique adjacent line, Edit succeeds and changes exactly one occurrence. If `replace_all: true` was the right call, every occurrence is updated atomically.



```

Widen old_string with surrounding context until it matches one location, or set replace_all: true for a global change. Escalate to Read + Write only when neither option can disambiguate the target.

```

