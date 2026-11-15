# Pet Window Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-click menu to the floating pet with chat, hide, and quit actions.

**Architecture:** The renderer prevents the browser context menu and calls a narrow preload API. Electron main displays a native `Menu` anchored to the pet window.

**Tech Stack:** Electron 44, React 19, TypeScript 5.9.

**Spec:** `apps/pet-ui/docs/superpowers/specs/2026-11-15-pet-context-menu-design.md`

## Global Constraints

- Modify only `apps/pet-ui/**`.
- Do not restore click-through behavior or add petd protocol methods.
- Keep context isolation enabled.

## Review Focus

- Right-click must suppress the Chromium browser menu and show native actions.
- Invoking the menu while the pet window is closed must not throw.
- Existing double-click chat and tray actions must remain available.

---

### Task 1: Pet window native menu

**Files:**
- Modify: `apps/pet-ui/electron/main.mjs`
- Modify: `apps/pet-ui/electron/preload.cjs`
- Modify: `apps/pet-ui/src/petd.ts`
- Modify: `apps/pet-ui/src/ui.tsx`
- Modify: `apps/pet-ui/README.md`

**Interface:** expose `petdBootstrap.showPetMenu(): Promise<void>`; main handles `pet:show-menu` and opens the native menu with chat, hide, and quit actions.

- [x] Add the main-process IPC handler, safely returning if `petWindow` is absent or destroyed.
- [x] Expose `showPetMenu` through preload and type it in `Window`.
- [x] Bind the pet overlay `contextmenu` event to prevent the default menu and invoke `showPetMenu`.
- [x] Update README interaction notes.
- [x] Run `pnpm --filter @petd/pet-ui build` and inspect the final diff.
- [x] Commit only `apps/pet-ui/**` with a Chinese `feat(pet-ui)` message.
