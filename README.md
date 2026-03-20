# Codex Mobile

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A cross-platform client for [OpenAI Codex CLI](https://github.com/openai/codex) — connecting to a running Codex app-server via WebSocket JSON-RPC. Includes a **React Native / Expo** mobile app and a **Tauri** desktop app, sharing a common TypeScript library.

## Project Structure

```
codex-mobile/
├── apps/
│   ├── mobile/          # React Native (Expo) app for iOS & Android
│   └── desktop/         # Tauri desktop app (Windows / macOS / Linux)
├── packages/
│   └── shared/          # Shared TypeScript types, WebSocket client, theme
├── scripts/
│   ├── live-debug/      # CDP-based live debug utilities
│   └── ensure-desktop-dev-server.mjs
├── turbo.json           # Turborepo task configuration
├── pnpm-workspace.yaml  # pnpm monorepo workspace
└── package.json
```

## Requirements

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 9
- [Rust + Cargo](https://rustup.rs/) — for the desktop app
- [Tauri CLI v2](https://tauri.app/) — for the desktop app
- [Expo CLI](https://docs.expo.dev/more/expo-cli/) — for the mobile app

## Getting Started

### Install dependencies

```bash
pnpm install
```

### Run the mobile app

```bash
pnpm dev:mobile
```

This starts the Expo development server. Use the Expo Go app or an emulator to open it.

### Run the desktop app

```bash
pnpm dev:desktop
```

This starts the Tauri + Vite development server.

## Build

### Build all packages

```bash
pnpm build
```

### Build desktop app (release)

```bash
pnpm build:desktop
```

## How It Works

The apps connect to a locally running [Codex CLI app-server](https://github.com/openai/codex) via WebSocket using a custom JSON-RPC 2.0 protocol. The `@codex-mobile/shared` package provides:

- **`CodexClient`** — WebSocket client with automatic reconnection and request/response tracking
- **Types** — Full TypeScript type definitions for all protocol messages
- **Theme** — Shared design tokens used across apps

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## License

[MIT](./LICENSE)
