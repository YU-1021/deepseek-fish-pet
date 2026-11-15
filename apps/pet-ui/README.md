# @petd/pet-ui

Electron + React renderer for petd. UI/business state stays with petd; the renderer uses the loopback WebSocket gateway.

## Development

```powershell
pnpm install
pnpm --filter @petd/pet-ui dev
pnpm --filter @petd/pet-ui build
pnpm --filter @petd/pet-ui typecheck
pnpm --filter @petd/pet-ui test
```

The desktop shell includes a Vite renderer, Electron main entry and preload, a floating draggable pet window, tray controls, and a gateway status strip with reconnect delays (1s/2s/5s). Electron reads `gateway.json` and `token.json` from `%APPDATA%/dayu-pet/petd` (or `PETD_HOME`) in the main process and exposes only the connection bootstrap over narrow IPC methods. Double-click the floating pet to show chat; drag the pet to reposition it; right-click for chat, hide, and quit actions. The Windows pet window uses a compact native hit region around the character and hint, so transparent margins pass mouse input to the app behind it. The pet uses the transparent idle animation from the local `dsh-pet` package with its 1/255 alpha fringe correction; source and artwork credit are recorded in `src/assets/README.md`.

Chat uses `session.list/get`, `session.create`, `chat.send`, and event-backed messages. The settings view reads only non-secret data from `config.get`. The persona view supports section edits through `persona.patch` with `expectedVersion`, AI edit locks, revision history, rollback, and `persona.changed` refresh handling. `E_CONFLICT` displays a refresh message and reloads the latest persona before further edits.

## Screenshots and build evidence

Build: `pnpm --filter @petd/pet-ui build` — passing.
Tests: `pnpm --filter @petd/pet-ui test` — 2 component checks passing.

The chat-window UI and Electron main-process wiring are implemented. A local smoke run confirmed petd starts and authenticates the Electron client; chat generation was not called. The fish-maid image is a static thumbnail with a CSS float animation; Coopanion's full layered model and richer movement remain future polish.
