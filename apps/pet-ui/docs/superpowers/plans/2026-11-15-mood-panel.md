# M7 Mood Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a petd-backed mood/status panel and subtle pet-window feedback.

**Architecture:** A reusable mood hook reads snapshots on connection and subscribes to `mood.changed`. The settings renderer presents details and evaluation controls; the pet renderer presents tier-based face/rings and poke feedback without exact numbers by default.

**Tech Stack:** React 19, TypeScript 5.9, Vitest, Testing Library, Electron 44.

**Spec:** `apps/pet-ui/docs/superpowers/specs/2026-11-15-mood-panel-design.md`; taskbook §8.8.

## Global Constraints

- Modify only `apps/pet-ui/**`.
- Use the live methods listed by `health.status`; consume `mood.status/history/adjust/poke/evaluate` and `mood.changed`.
- Do not calculate chat mood changes in pet-ui.
- Default to hiding exact values; show them only when the local debug toggle is enabled.
- Make no more than one real `chat.send` and one real `mood.evaluate` call.
- Do not expose API keys or mutate petd config from the UI.

## Review Focus

- Reconnect reloads current mood once without starting a polling loop.
- Disabled mood hides controls and does not accidentally call mutating methods.
- Double-click to open chat does not also count as a poke.
- Evaluation can time out or fail without leaving the button stuck.
- State updates from `mood.changed` do not interrupt the chat view.

---

### Task 1: Mood state hook and mock protocol

**Files:**
- Create: `src/mood.ts`
- Modify: `scripts/mock-gateway.mjs`
- Test: `src/mood.test.ts`

**Interfaces:**
- Consumes: `usePetdStatus`, `request`, `subscribeEvents` from `src/petd.ts`.
- Produces: `useMoodState()` returning `{enabled,state,history,refresh,error}` and state/action types.

- [x] Add tests for initial status, `mood.changed` subscription update, history retrieval, and disabled status.
- [x] Extend mock gateway with all five `mood.*` methods and one event emission for poke/adjust/evaluate.
- [x] Implement refresh-on-connected and event-driven updates; no timers/polling.
- [x] Run `pnpm --filter @petd/pet-ui test -- src/mood.test.ts`.

### Task 2: Settings panel and evaluation flow

**Files:**
- Modify: `src/ui.tsx`
- Modify: `src/detail.css`
- Modify: `src/ui.test.tsx`

**Interfaces:** consumes `useMoodState()`; settings config is from `config.get`.

- [x] Add tests for tier labels, local exact-value toggle, disabled mood, evaluation loading/result/error.
- [x] Add read-only mood config and history in Settings; `mood.evaluate` timeout 90s and disable repeated calls.
- [x] Map `E_INTERNAL` to the taskbook wording; map `applied[]` to small result notices.
- [x] Run the focused tests and then the full pet-ui suite.

### Task 3: Pet window face, rings, and poke response

**Files:**
- Modify: `src/ui.tsx`
- Modify: `src/pet.css`
- Modify: `src/pet-interaction.css`
- Modify: `src/ui.test.tsx`

**Interfaces:** consumes mood hook and local show-values preference.

- [x] Add tests proving poke calls once, triggers feedback, and double-click only opens chat.
- [x] Show face/tier caption and three circular indicators; exact numbers only when debug preference is enabled.
- [x] Keep the pet window artwork-only; `mood.poke` remains silent and chat mood changes do not add a visual overlay.
- [x] Run focused tests and full suite.

### Task 4: Integration evidence and handoff

**Files:**
- Modify: `README.md`
- Create: `docs/evidence/m7-settings.png`, `docs/evidence/m7-pet.png`

- [x] Run build and test suite.
- [x] Start petd with `%TEMP%\petd-ui-dev`; perform no more than one chat send and one mood evaluation.
- [x] Capture settings and pet-window evidence; record method connectivity and limits in README.
- [x] `git diff --check`; commit only `apps/pet-ui/**` in small Chinese commits.
