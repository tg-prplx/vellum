# Vellium

<p align="center">
  <img src="docs/vellium-icon.png" alt="Vellium icon" width="120" />
</p>
<p align="center"><strong>Vellium</strong></p>

Desktop AI/RP chat app built with Electron, a local Express API, and SQLite.

## Important
- Use `npm run dev` for daily development.
- Use `npm run dist:mac` / `npm run dist:win` for desktop bundles.
- CI desktop builds are currently unsigned, so target OSes may require manual confirmation.
- Desktop packaging works, but still has rough edges. Expect occasional startup/build quirks.

## Stack
- Electron
- React + TypeScript + Vite
- Express
- better-sqlite3
- Tailwind CSS

## Features
- Chat with branching, edit/delete, regenerate, and multi-character auto turns.
- RP tools: prompt blocks, author note, scene state, presets.
- User personas included in generation context.
- Character cards: import, validate, edit.
- Creative Writing mode: projects, chapters, scenes, consistency check, export.
- Desktop packaging for macOS and Windows via electron-builder.

## Requirements
- Node.js + npm (LTS recommended; project uses native module `better-sqlite3`).
- Python 3 + Pillow for icon generation (`pip install pillow`).

## Quick Start (web + local API)
1. Install dependencies:
```bash
npm install
```
2. Start frontend + backend:
```bash
npm run dev
```
3. Open:
`http://localhost:1420`

## One-click bootstrap scripts
- macOS:
```bash
./setup-and-run-dev.sh
```
- Windows (CMD/PowerShell):
```bat
setup-and-run-dev.bat
```

What these scripts do:
- try to install Node.js LTS automatically (macOS: `nvm`/`brew`, Windows: `winget`);
- run `npm install`;
- start `npm run dev`.

## Electron Dev Mode
```bash
npm run dev:electron
```

## Build Desktop App
- All platforms:
```bash
npm run dist
```
- macOS only:
```bash
npm run dist:mac
```
- Windows only:
```bash
npm run dist:win
```

Build output is written to `release/`.

## GitHub Actions
Workflow:
- `.github/workflows/build-desktop.yml`

What it does:
- Builds macOS (`x64` + `arm64`) and Windows (`x64`) desktop bundles.
- Uploads build outputs as Actions artifacts.
- On tag push `v*`, publishes binaries into GitHub Releases automatically.

## App Icons
Generate icons:
```bash
npm run build:icons
```

The script creates:
- `build/icon.png`
- `build/icon.icns`
- `build/icon.ico`

These files are used by `electron-builder` in `package.json`.

## Useful Scripts
- `npm run dev` - frontend + server.
- `npm run dev:server` - backend only (`tsx watch server/index.ts`).
- `npm run dev:frontend` - Vite frontend only.
- `npm run dev:electron` - Electron + frontend + server.
- `npm run rebuild:native` - manual `better-sqlite3` rebuild.
- `npm run test` - run tests (`vitest run`).

## Data Storage
- In dev: local `data/`.
- In packaged app: `SLV_DATA_DIR` is mapped to `app.getPath("userData")/data`.

## Troubleshooting
### 1) `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION ...` (better-sqlite3)
Cause: native module was built for a different Node ABI.

Fix:
1. Run:
```bash
npm run rebuild:native
```
2. If needed, remove `node_modules` and `package-lock.json`, then run `npm install`.
3. Ensure dev/build use the same Node version.

Note: `scripts/ensure-better-sqlite3.cjs` runs automatically before `dev:server`.

### 2) `EADDRINUSE: address already in use :::3001`
Cause: port `3001` is occupied by an old server process.

Fix:
1. Restart `npm run dev` (`ensure-dev-port.cjs` tries to free the port).
2. If still occupied:
```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
kill -TERM <pid>
```

### 3) Long startup or blank window after packaging
Check:
1. You ran full desktop build (`npm run dist`), not just frontend build.
2. Package includes `dist/`, `dist-electron/`, and `server-bundle.mjs`.
3. In production, Electron waits for `GET /api/health` from bundled server.

## Project Structure
- `src/` - React frontend.
- `server/` - Express API.
- `electron/` - Electron main/preload.
- `scripts/` - utility scripts (native rebuild, ports, icons).
- `build/` - electron-builder resources.
- `release/` - built `.app`, `.dmg`, `.exe`, installers.
