# Prompt Builder Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the two prompt assembly functions from `app/main.js` into a pure, dependency-injected module without changing any generated prompt or runtime behavior.

**Architecture:** Add a CommonJS `createPromptBuilder(deps)` factory under `app/src/`. `main.js` keeps ownership of Electron, filesystem, persona, memory, permissions, and diagnostics, injects narrow adapters into the factory, and continues exporting the two builder functions for compatibility. Diagnostic scripts consume the same factory rather than parsing source text.

**Tech Stack:** Node.js CommonJS, Electron 33, built-in `assert` and `crypto`, existing script-based tests.

**Spec:** `docs/superpowers/specs/2026-10-02-prompt-builder-boundary-design.md`

## Global Constraints

- Generated system and continuation prompts must remain byte-for-byte identical for the same dependencies and configuration.
- Preserve the `off`, `read`, `normal`, `web`, and `full` permission-tier behavior.
- Keep `app/main.js` exports `buildSystemPrompt` and `buildContinuePrompt` compatible.
- Do not modify user data, data schemas, permission semantics, renderer behavior, agent-loop behavior, or tool execution.
- Do not add runtime dependencies.
- Keep `contextIsolation: true` and `nodeIntegration: false` unchanged.
- Optional tone, vocabulary, and override failures remain fail-soft; required memory, behavior-state, and skill dependencies keep exposing failures.

## Review Focus

- Empty or missing optional sections must preserve the legacy blank lines and section ordering exactly; Task 1 covers this with full-output hashes and explicit omission assertions.
- Unknown `vocabLevel` must still fall back to `high_school`; Task 1 covers this with a literal fallback assertion.
- `read` and `normal` currently share prompt-visible tools even where execution policy differs; Task 1 pins all five tiers separately so extraction cannot accidentally “correct” behavior.
- Override text containing leading/trailing whitespace must retain current trim-and-append behavior through the injected adapter; Task 1 covers exact terminal placement.
- Runtime wiring must not read Electron or application data when the pure module is imported; Task 1 covers the plain-Node import and Task 2 runs the existing Electron probes.

---

### Task 1: Pure Prompt Builder Contract

**Files:**
- Create: `app/src/prompt-builder.js`
- Create: `app/scripts/test-prompt-builder.js`

**Interfaces:**
- Consumes: injected functions `loadPersona()`, `loadMood()`, `getTone(persona)`, `getBehaviorSpec()`, `buildMemoryContext()`, `getPracticeWords(limit)`, `getSkillCatalog()`, `isToolAllowed(tier, tool)`, `readPromptOverride()`, and `log(message)`.
- Produces: `createPromptBuilder(deps) -> { buildSystemPrompt(cfg), buildContinuePrompt(cfg) }`.

- [ ] **Step 1: Record legacy golden hashes before moving production code**

Use fixed literal fixtures for persona, mood, behavior text, memory, vocabulary entries, skill catalog, project permission, and override text. Evaluate the current builders against those fixtures for all five tiers and record the SHA-256 values as literals in `test-prompt-builder.js`; do not compute expected values through the new builder.

- [ ] **Step 2: Write the failing pure-module tests**

Add tests that import `../src/prompt-builder`, construct the factory with fixed dependencies, and assert:

- all ten complete outputs (system and continuation × five tiers) match the recorded literal SHA-256 hashes;
- section indices preserve tone → hidden setting → vocabulary → relationship → behavior → memory → skills → project → actions → output format → override;
- `off` omits skills, project, and computer actions;
- empty practice words and empty skill catalog omit their sections;
- thrown tone, vocabulary, and override adapters omit only their optional sections;
- thrown memory, behavior-state, and skill adapters propagate;
- unknown vocabulary level uses the exact high-school fallback sentence;
- missing required dependency throws an error naming that dependency;
- importing the module in plain Node does not load Electron.

- [ ] **Step 3: Run the test and verify RED**

Run: `node app/scripts/test-prompt-builder.js`

Expected: FAIL because `../src/prompt-builder` does not exist.

- [ ] **Step 4: Implement the minimal factory**

Create `app/src/prompt-builder.js` with `createPromptBuilder(deps)`. Move the current prompt strings and ordering without editorial changes. Store the existing `VOCAB` mapping inside the module. Validate required dependency names at factory creation and retain current fail-soft boundaries only for tone, practice words, and override reads.

- [ ] **Step 5: Run the prompt-builder contract test**

Run: `node app/scripts/test-prompt-builder.js`

Expected: PASS with all prompt hashes, ordering, omission, fallback, error, and plain-Node import assertions passing.

- [ ] **Step 6: Commit Task 1**

```powershell
git add app/src/prompt-builder.js app/scripts/test-prompt-builder.js
git commit -m "refactor: extract pure prompt builder"
```

### Task 2: Main-Process Wiring and Diagnostic Migration

**Files:**
- Modify: `app/main.js`
- Modify: `app/scripts/probe-prompt.js`
- Modify: `app/scripts/measure-tokens.js`
- Modify: `模块说明.md`
- Test: `app/scripts/test-prompt-builder.js`

**Interfaces:**
- Consumes: `createPromptBuilder(deps)` from Task 1.
- Produces: compatibility exports `buildSystemPrompt(cfg)` and `buildContinuePrompt(cfg)` backed by one injected factory instance; diagnostics consume the official factory/export rather than source extraction.

- [ ] **Step 1: Wire the factory in `main.js` under the green characterization contract**

Instantiate one builder with adapters around the existing modules. Keep override path resolution, file reading, and logging in `main.js`. Replace the two local implementations with wrappers/delegated functions while keeping their export names and all call sites unchanged.

- [ ] **Step 2: Run the prompt-builder contract immediately after wiring**

Run: `node app/scripts/test-prompt-builder.js`

Expected: PASS with the same ten legacy hashes. This is the refactor phase of Task 1's RED→GREEN contract: no new behavior is introduced, and the previously failing characterization test remains the guard.

- [ ] **Step 3: Migrate diagnostics and documentation**

Update `measure-tokens.js` to create the factory with explicit existing-module adapters instead of slicing `main.js` and invoking `new Function`. Keep `probe-prompt.js` on the compatibility exports or the official factory path, and update `模块说明.md` to list `src/prompt-builder.js` as the prompt assembly boundary and remove the claim that `main.js` assembles prompts itself.

- [ ] **Step 4: Run focused verification**

Run: `node app/scripts/test-prompt-builder.js`

Expected: PASS.

Run: `node app/scripts/test-parsereply.js`

Expected: PASS.

- [ ] **Step 5: Run Electron diagnostics**

With `ELECTRON_RUN_AS_NODE` unset, run:

```powershell
app\node_modules\electron\dist\electron.exe app\scripts\test-context.js
app\node_modules\electron\dist\electron.exe app\scripts\test-vocab.js
app\node_modules\electron\dist\electron.exe app\scripts\probe-prompt.js
app\node_modules\electron\dist\electron.exe app\scripts\measure-tokens.js
```

Expected: each exits successfully; context/vocabulary tests pass; probe emits prompt coordinate lines; token report has `error: null` and entries for all five system and continuation tiers.

- [ ] **Step 6: Verify repository-wide available script tests**

Enumerate `app/scripts/test-*.js`. Run every plain-Node test directly and every Electron-dependent test with the bundled Electron, excluding only tests documented as destructive, interactive, external-network, or requiring a live game/application. Record every exclusion and reason; no observed failure may be omitted.

- [ ] **Step 7: Commit Task 2**

```powershell
git add app/main.js app/scripts/probe-prompt.js app/scripts/measure-tokens.js 模块说明.md app/scripts/test-prompt-builder.js
git commit -m "refactor: wire prompt builder into main process"
```

## Completion Contract

- The new pure builder test was observed failing before implementation and passing afterward.
- All five permission tiers match recorded legacy hashes for both prompt types.
- Existing main-process exports remain callable.
- Diagnostics no longer parse `main.js` source or use `new Function` for prompt builders.
- Focused and applicable repository tests pass, with exclusions disclosed.
- `git diff` contains no renderer, permission, user-data, or tool-execution behavior changes.
