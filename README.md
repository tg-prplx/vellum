# Vellum

<p align="center">
  <img src="docs/vellum-icon.png" alt="Vellum icon" width="120" />
</p>
<p align="center"><strong>Vellum</strong></p>

Desktop AI/RP chat-приложение на Electron с локальным Express API и SQLite.

## Важно
- Для разработки используйте `npm run dev`.
- Для desktop-артефактов используйте `npm run dist:mac` и `npm run dist:win`.
- Сборки в CI сейчас создаются без code signing (unsigned), поэтому на целевых ОС может потребоваться ручное подтверждение запуска.

## Текущий стек
- Electron
- React + TypeScript + Vite
- Express
- better-sqlite3
- Tailwind CSS

## Что уже есть
- Чат с ветками, редактированием, удалением, регенерацией, автодиалогом персонажей.
- RP-инструменты: prompt blocks, author note, scene state, пресеты.
- Персоны пользователя (user persona) и передача в генерацию.
- Characters: импорт/валидация/редактирование карточек.
- Writer mode: проекты, главы, сцены, consistency check, экспорт.
- Десктоп-сборка под macOS/Windows через electron-builder.

## Требования
- Node.js и npm (желательно LTS; в проекте используется нативный модуль `better-sqlite3`).
- Для генерации иконок: Python 3 + Pillow (`pip install pillow`).

## Быстрый старт (web + local API)
1. Установить зависимости:
```bash
npm install
```
2. Запустить frontend + backend:
```bash
npm run dev
```
3. Открыть:
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

Что делают скрипты:
- пытаются установить Node.js LTS автоматически (macOS: `nvm`/`brew`, Windows: `winget`);
- выполняют `npm install`;
- запускают `npm run dev`.

## Запуск Electron в dev
```bash
npm run dev:electron
```

## Сборка приложения
- Все платформы:
```bash
npm run dist
```
- Только macOS:
```bash
npm run dist:mac
```
- Только Windows:
```bash
npm run dist:win
```

Артефакты сборки попадают в `release/`.

## GitHub Actions
Настроен workflow:
- `.github/workflows/build-desktop.yml`

Что делает:
- macOS job (x64 + arm64): собирает `dmg` и `.app` (`dir` target);
- Windows job (x64): собирает `.exe` (NSIS installer);
- загружает все артефакты из `release/` в Actions artifacts.

## Иконки приложения
Генерация иконок:
```bash
npm run build:icons
```

Скрипт создает:
- `build/icon.png`
- `build/icon.icns`
- `build/icon.ico`

Именно эти файлы используются `electron-builder` в `package.json`.

## Полезные скрипты
- `npm run dev` - frontend + server.
- `npm run dev:server` - только backend (`tsx watch server/index.ts`).
- `npm run dev:frontend` - только Vite frontend.
- `npm run dev:electron` - Electron + frontend + server.
- `npm run rebuild:native` - ручной rebuild `better-sqlite3`.
- `npm run test` - запуск тестов (`vitest run`).

## Где хранятся данные
- В dev: локально в `data/`.
- В packaged app: `SLV_DATA_DIR` автоматически переводится в `app.getPath("userData")/data`.

## Troubleshooting
### 1) `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION ...` (better-sqlite3)
Причина: модуль собран под другую версию Node ABI.

Что делать:
1. Запустить:
```bash
npm run rebuild:native
```
2. Если не помогло: удалить `node_modules` и `package-lock.json`, затем `npm install`.
3. Убедиться, что dev и сборка запускаются одной и той же версией Node.

Примечание: перед `dev:server` автоматически выполняется `scripts/ensure-better-sqlite3.cjs`.

### 2) `EADDRINUSE: address already in use :::3001`
Причина: порт 3001 уже занят старым процессом сервера.

Что делать:
1. Просто перезапустить `npm run dev` (скрипт `ensure-dev-port.cjs` пытается освободить порт автоматически).
2. Если процесс не снялся:
```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
kill -TERM <pid>
```

### 3) После сборки долго грузится и показывается пустое окно
Проверь:
1. Что запускалась полная сборка (`npm run dist`), а не только frontend.
2. Что в сборку попали `dist/`, `dist-electron/` и `server-bundle.mjs`.
3. Логи Electron main-процесса: в production окно ждет `GET /api/health` от серверного бандла.

## Структура проекта
- `src/` - React frontend.
- `server/` - Express API.
- `electron/` - main/preload для Electron.
- `scripts/` - сервисные скрипты (native rebuild, порт, иконки).
- `build/` - build resources для electron-builder.
- `release/` - итоговые `.app`, `.dmg`, `.exe` и установщики.
