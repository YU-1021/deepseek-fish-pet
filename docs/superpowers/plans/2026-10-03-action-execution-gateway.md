# Action Execution Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce assistant permissions, verified pointer targets, explicit confirmation, user takeover, and structured auditing in the main process before any chat-driven computer action runs.

**Architecture:** Add four focused CommonJS modules: a pure policy classifier, an in-memory one-use authority store, a redacting JSONL audit writer, and an injected execution gateway. Keep existing tool implementations in `assistant.js`; adapt main-process IPC and the chat renderer to inspect, approve, and execute through the gateway.

**Tech Stack:** Electron 33, Node.js CommonJS, browser JavaScript, JSONL, existing native `input.exe` and current script-based test harness.

**Spec:** `docs/superpowers/specs/2026-10-03-action-execution-gateway-design.md`

## Global Constraints

- Keep `contextIsolation: true` and `nodeIntegration: false`.
- Do not expose Node.js or filesystem primitives to renderers; all capabilities stay behind explicit IPC methods.
- Do not modify or migrate existing user configuration and memory files.
- Store the new audit stream at `%APPDATA%/dayu-pet/assistant-audit.v1.jsonl` with `version: 1` on every row.
- Never persist API keys, passwords, approval tokens, full typed text, or file contents in the audit stream.
- Preserve existing tool result text, prompt protocol, desktop-pet behavior, game agent behavior, and current tests.
- Implement one boundary at a time with red-green-refactor and a commit after every task.
- Continue work only in the workspace copy on `refactor/assistant-core`; do not modify `C:\deepseek\desktop-pet`.

## Review Focus

- Malformed actions (`null`, unknown tool, non-string argument) must be denied without calling the tool; Task 1 and Task 4 tests cover this.
- Coordinate variants (`100,200`, whitespace, Chinese comma, decimals, extra parameters) must normalize consistently and never broaden a grant; Task 2 tests cover this.
- A user movement racing between policy inspection and execution must invalidate the target before the tool runs; Task 2 and Task 4 tests cover this.
- Audit write/rotation failure must not crash the app or silently turn a deny/confirm into allow; Task 3 and Task 4 tests cover this.
- Double-clicking the Allow button or replaying an IPC payload must execute at most once; Task 2 and Task 6 tests cover this.

---

### Task 1: Pure permission policy

**Files:**
- Create: `app/src/permission-policy.js`
- Create: `app/scripts/test-permission-policy.js`

**Interfaces:**
- Consumes: `{ tier, tool, arg, facts }`, where `facts` contains `toolAllowed`, `destinationExists`, `hasTargetGrant`, `focusVerified`, and `userActive` booleans.
- Produces: `normalizeAction(action)` and `classifyAction(input) -> { decision, reason, risk, requirements }`.

- [ ] **Step 1: Write the failing policy matrix test**

Add named cases for malformed/unknown actions, insufficient tier, read-only tools, delete tools, existing-file overwrite, local execution, web mutation, verified and unverified pointer actions, keyboard focus, and user-active state. Assert that destructive/web mutation cases still return `confirm` under `full`, while unknown or insufficient-permission cases return `deny`.

- [ ] **Step 2: Run the policy test and verify RED**

Run: `node app/scripts/test-permission-policy.js`

Expected: FAIL because `../src/permission-policy` does not exist.

- [ ] **Step 3: Implement the policy API**

Implement strict action normalization and deterministic rule ordering from the spec. Export frozen sets for `POINTER_TOOLS`, `KEYBOARD_TOOLS`, `DELETE_TOOLS`, `EXECUTE_TOOLS`, and `WEB_MUTATION_TOOLS` so later modules use the same classification names.

- [ ] **Step 4: Run the policy test and existing permission registry test**

Run: `node app/scripts/test-permission-policy.js; node app/scripts/test-registry.js`

Expected: both pass with no warnings.

- [ ] **Step 5: Commit**

```bash
git add app/src/permission-policy.js app/scripts/test-permission-policy.js
git commit -m "feat: add pure assistant permission policy"
```

### Task 2: One-use target and approval authority

**Files:**
- Create: `app/src/action-authority.js`
- Create: `app/scripts/test-action-authority.js`
- Modify: `app/src/userinput.js:28-145`
- Modify: `app/scripts/test-useryield.js`

**Interfaces:**
- Consumes: normalized `{ tool, arg }`, `userEpoch`, injected `now()` and `randomBytes()`.
- Produces: `createActionAuthority(options)` with `issueTarget`, `matchAndConsumeTarget`, `invalidateTargets`, `issueApproval`, `consumeApproval`, and `stats`; `userinput.state().userEpoch`.

- [ ] **Step 1: Write failing authority tests**

Assert source allowlisting, two-pixel click tolerance, no tolerance beyond two pixels, Chinese-comma normalization, two-target drag requirements, 120-second expiry, one-use consumption, epoch invalidation, approval action binding, approval expiry, and approval replay rejection.

- [ ] **Step 2: Run the authority test and verify RED**

Run: `node app/scripts/test-action-authority.js`

Expected: FAIL because `../src/action-authority` does not exist.

- [ ] **Step 3: Implement `createActionAuthority(options)`**

Keep all grants in memory. Store hashes of normalized approval actions, never raw approval tokens in diagnostic output. Return structured `{ ok, reason, grant }` results rather than throwing for expected mismatches.

- [ ] **Step 4: Run the authority test and verify GREEN**

Run: `node app/scripts/test-action-authority.js`

Expected: all authority cases pass.

- [ ] **Step 5: Add a failing user epoch assertion**

Extend `test-useryield.js` to assert that a detected non-pet cursor move increments `state().userEpoch`, while an expected pet move does not.

- [ ] **Step 6: Run the user-yield test and verify RED**

Run with the test's existing Electron invocation.

Expected: FAIL because `userEpoch` is absent or remains unchanged.

- [ ] **Step 7: Implement the monotonic user epoch**

Increment only in the branch that records a genuine user move and expose the integer from `state()` without changing existing fields.

- [ ] **Step 8: Run authority and user-yield tests**

Run: `node app/scripts/test-action-authority.js` and the existing Electron `test-useryield.js` command.

Expected: both pass.

- [ ] **Step 9: Commit**

```bash
git add app/src/action-authority.js app/src/userinput.js app/scripts/test-action-authority.js app/scripts/test-useryield.js
git commit -m "feat: add one-use action authority grants"
```

### Task 3: Redacting structured action audit

**Files:**
- Create: `app/src/action-audit.js`
- Create: `app/scripts/test-action-audit.js`

**Interfaces:**
- Consumes: `createActionAudit({ dir, now, randomId, maxBytes })` and event objects from the executor.
- Produces: `{ append(event), summarizeAction(action), file(), readRecent(limit) }`; all methods fail closed for data exposure and fail-soft for filesystem availability.

- [ ] **Step 1: Write failing audit tests**

Use a temporary directory. Assert versioned JSONL rows, stable action IDs, six lifecycle phases, 10 MiB default rotation, safe recovery from malformed old lines, and write failures that return `{ ok: false }` without throwing.

- [ ] **Step 2: Add secret-redaction assertions**

Assert that API-key-shaped strings, `password`, `token`, approval tokens, typed text, web input, and write-file contents never occur in the file. Assert that safe metadata retains tool, tier, risk, reason, source, argument length, SHA-256 digest, duration, and outcome.

- [ ] **Step 3: Run the audit test and verify RED**

Run: `node app/scripts/test-action-audit.js`

Expected: FAIL because `../src/action-audit` does not exist.

- [ ] **Step 4: Implement the audit writer**

Use synchronous append for ordered lifecycle records, line-level JSON parsing for `readRecent`, `.1` single-generation rotation, and dependency injection so the module remains a pure Node test target without Electron.

- [ ] **Step 5: Run the audit test and verify GREEN**

Run: `node app/scripts/test-action-audit.js`

Expected: all audit and redaction cases pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/action-audit.js app/scripts/test-action-audit.js
git commit -m "feat: add redacted assistant action audit"
```

### Task 4: Injected action execution gateway

**Files:**
- Create: `app/src/action-executor.js`
- Create: `app/scripts/test-action-executor.js`

**Interfaces:**
- Consumes: `createActionExecutor({ allowed, classifyAction, authority, audit, getFacts, waitUntilFree, runTool, now })`.
- Produces: `inspect(action, context)`, `approve(action, context)`, `execute(request, context)`, and `recordTarget(tool, result, context)`.
- Uses Task 1 decisions, Task 2 grants, and Task 3 audit lifecycle events without importing Electron.

- [ ] **Step 1: Write failing executor decision tests**

Assert: deny never calls `runTool`; confirm without a token never calls it; valid approval calls it exactly once; replay fails; verified pointer target auto-runs exactly once; changed epoch blocks execution; and malformed input returns an explicit denial.

- [ ] **Step 2: Write failing execution lifecycle tests**

Assert audit order for success and failure, locator results issuing target grants, non-locator results never issuing grants, user-active timeout cancellation, and audit append failures never changing the policy decision.

- [ ] **Step 3: Run the executor test and verify RED**

Run: `node app/scripts/test-action-executor.js`

Expected: FAIL because `../src/action-executor` does not exist.

- [ ] **Step 4: Implement the executor API**

Accept the existing action shape and the new `{ action, approvalToken }` envelope. Normalize once, re-evaluate facts immediately before execution, consume capability immediately before `runTool`, and convert expected policy failures to structured results rather than tool exceptions.

- [ ] **Step 5: Run all four new pure Node tests**

Run: `node app/scripts/test-permission-policy.js; node app/scripts/test-action-authority.js; node app/scripts/test-action-audit.js; node app/scripts/test-action-executor.js`

Expected: all pass with no warnings.

- [ ] **Step 6: Commit**

```bash
git add app/src/action-executor.js app/scripts/test-action-executor.js
git commit -m "feat: add assistant action execution gateway"
```

### Task 5: Structured locator targets and main-process IPC integration

**Files:**
- Modify: `app/src/assistant.js:982-1178`
- Modify: `app/main.js:24-183,1359-1460`
- Modify: `app/preload.js:80-86`
- Create: `app/scripts/test-action-ipc.js`
- Modify: `app/scripts/test-findtext.js`
- Modify: `app/scripts/test-locator.js`
- Modify: `app/scripts/test-uia.js`

**Interfaces:**
- Consumes: Tasks 1-4 modules and existing locator coordinates.
- Produces: locator result `{ text, target: { x, y, source, label } }`; preload methods `assistantInspect(action)`, `assistantApprove(action)`, and `assistantRun({ action, approvalToken })`.

- [ ] **Step 1: Add failing structured locator assertions**

Extend the existing locator tests so successful `find_text`, template matching, template scrolling, and `uia_find` retain their current human-readable `text` and also expose the exact structured target. Assert failed searches expose no target.

- [ ] **Step 2: Run the affected locator tests and verify RED**

Run the existing commands for `test-findtext.js`, `test-locator.js`, and `test-uia.js`.

Expected: fail because successful results lack `target`.

- [ ] **Step 3: Add minimal structured target results**

Change only successful locator return values. Preserve all existing text verbatim and keep `assistant.run` callers compatible with string-or-object results.

- [ ] **Step 4: Write the failing IPC integration test**

Start Electron with isolated `userData`. Assert inspect/approve/run channels exist, full-tier unverified click returns `confirm`, a locator-issued target allows the matching click, mismatched coordinates remain confirm, approval tokens execute once, and the BrowserWindow security preferences remain unchanged.

- [ ] **Step 5: Run the IPC test and verify RED**

Run with Electron: `electron.exe app/scripts/test-action-ipc.js`

Expected: FAIL because inspect/approve IPC methods do not exist.

- [ ] **Step 6: Wire the gateway into `main.js`**

Move the body that hides/yields windows and calls `assistant.run` into a private `runToolWithWindows(action)` adapter. Create the authority, audit, and executor once in the main process. Register inspect, approve, and run handlers; support the old direct action payload only by routing it through the same policy with no implicit approval.

- [ ] **Step 7: Expose the three narrow preload methods**

Keep `assistantRun` but change its documented payload to the envelope; add `assistantInspect` and `assistantApprove`. Do not expose audit paths, tokens, or generic IPC invocation.

- [ ] **Step 8: Run locator, IPC, prompt, parser, and loop tests**

Run the three locator tests, `test-action-ipc.js`, `test-prompt-builder.js`, `test-parsereply.js`, and `test-loop.js`.

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add app/src/assistant.js app/main.js app/preload.js app/scripts/test-action-ipc.js app/scripts/test-findtext.js app/scripts/test-locator.js app/scripts/test-uia.js
git commit -m "feat: enforce action gateway in main process"
```

### Task 6: Renderer confirmation flow and replay protection

**Files:**
- Modify: `app/renderer/chat.js:745-890`
- Modify: `app/scripts/stub-preload.js`
- Create: `app/scripts/test-action-confirmation-ui.js`

**Interfaces:**
- Consumes: `assistantInspect`, `assistantApprove`, and enveloped `assistantRun` from Task 5.
- Produces: an async `renderAction` flow where allow executes directly, confirm displays user controls, and deny becomes a normal task result.

- [ ] **Step 1: Write the failing offscreen UI test**

Stub inspect responses for allow/confirm/deny. Assert full permission no longer skips `confirm`, deny never calls approve/run, user Allow obtains a token before run, user Reject records a rejection, and a double click calls run once.

- [ ] **Step 2: Run the UI test and verify RED**

Run with Electron: `electron.exe app/scripts/test-action-confirmation-ui.js`

Expected: FAIL because `renderAction` still auto-runs every full-tier action.

- [ ] **Step 3: Implement the async confirmation flow**

Disable buttons immediately on the first click, display the policy reason in the action bar, pass the approval token only in the execution envelope, and feed deny/confirm failures back through the existing Agent Loop error path.

- [ ] **Step 4: Run UI and real-input tests**

Run `test-action-confirmation-ui.js`, `test-chatui.js`, `test-type-target.js`, and `test-input-safety.js` with their existing Electron commands.

Expected: confirmation behavior and all existing input/security assertions pass.

- [ ] **Step 5: Commit**

```bash
git add app/renderer/chat.js app/scripts/stub-preload.js app/scripts/test-action-confirmation-ui.js
git commit -m "feat: require runtime confirmation for risky actions"
```

### Task 7: Documentation, full regression, and PR update

**Files:**
- Modify: `模块说明.md`
- Modify: `docs/PROGRESS-2026-10-03.md`

**Interfaces:**
- Consumes: completed gateway behavior and test evidence.
- Produces: updated architecture/data-flow documentation and an evidence-backed PR update.

- [ ] **Step 1: Update architecture documentation**

Document the three IPC phases, policy matrix, one-use grants, audit file schema/version, user takeover cancellation, and the explicit limitation that the game agent remains on its existing guarded loop in this phase.

- [ ] **Step 2: Run syntax and whitespace verification**

Run `node --check` on every changed JavaScript file and `git diff --check`.

Expected: zero failures and zero whitespace errors.

- [ ] **Step 3: Run the complete relevant Node suite**

Run the four new module tests plus `test-registry.js`, `test-prompt-builder.js`, `test-parsereply.js`, `test-loop.js`, and `test-vocab.js`.

Expected: all pass; report each pass count.

- [ ] **Step 4: Run the complete relevant Electron suite serially**

Run locator/UI/IPC tests plus `test-type-target.js`, `test-input-safety.js`, `test-useryield.js`, and `test-vocab-loop.js`; verify each result JSON and confirm no test Electron process remains.

Expected: all pass with no leaked Electron processes.

- [ ] **Step 5: Inspect audit output**

Read the isolated test audit file and assert every row parses, has `version: 1`, contains no fixture secrets or approval tokens, and includes both permitted and denied lifecycles.

- [ ] **Step 6: Commit documentation and push**

```bash
git add 模块说明.md docs/PROGRESS-2026-10-03.md
git commit -m "docs: document assistant action gateway"
git push github refactor/assistant-core
```

- [ ] **Step 7: Update PR evidence**

Verify PR #3 points at the final branch SHA and report the exact test commands, pass counts, remaining game-agent limitation, and rollback boundaries without merging `main`.
