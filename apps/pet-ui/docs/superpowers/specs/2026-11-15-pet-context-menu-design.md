# Pet Window Context Menu

## Intent

Give the floating pet a useful right-click menu after removing click-through controls.

## Scope

- Right-click offers opening chat, hiding the pet, and quitting the app.
- Double-click continues to open chat; tray behavior stays available.
- Click-through stays removed. No petd methods, protocol changes, or dependencies.

## Approach

Use Electron's native `Menu` through a narrow preload IPC method, matching the existing native tray menu. A renderer-built menu would duplicate platform menu behavior and add more UI code for the same three actions.

## Constraints

Only edit `apps/pet-ui/**`. Keep `contextIsolation` enabled and expose only the menu action through preload.
