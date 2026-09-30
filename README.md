# ZHarness

[English](#english) | [中文](README.zh-CN.md)

---

## English

ZHarness is an **event-driven** coding agent: every conversation turn, tool call, and file edit is recorded as an event in an immutable log. The LLM context, the session tree, the timeline, and every UI are live projections of that log — like database views over their underlying tables: they hold no independent state and can be rebuilt, audited, and replayed at any time.

## Core Design

- **Reactor-driven turn loop** — every turn is a state machine driven by an event–handler table: an event arrives, the table is consulted, work is dispatched to the matching handler, and state transitions. Unlike the usual `while True` loop, every step's input and output is reliably handled and traceable.
- **The log is the single source of truth** — every message, model call, tool result, and file change is written to an immutable EventStore (one SQLite database per workspace). State can be rebuilt, audited, and replayed.
- **A CLI-based tool registry** — the model gets exactly one tool, the `cli` tool, through which read/write/edit and other commands are routed — a progressive-disclosure-friendly alternative to flat JSON tool calling.
- **One runtime, many shapes** — CLI, interactive TUI, and desktop GUI all consume the same event stream; underneath it is always the same agent.
- **Git-log-like branch tree memory** — a session can fork from any historical message, with read-only views and timeline rewind.

## Features

- Terminal CLI (`zharness --help`) + interactive TUI
- Desktop app (Tauri 2): workspace management, file explorer, event timeline, replay view, SOP market, skills/extensions/model configuration
- Session branch trees and replay summaries (replay-summary built-in extension)
- SOP market and dynamic workflow engine (builtin sops: code-review, deep-research, dynamic-task, weekly-report)
- Built-in skills (api-map, self-optimization) and extensions (codegen pipeline, proactive assistant, persistent main agent)
- RPC integration surface (`--mode rpc`, JSONL over stdin/stdout) for embedding
- Scheduled tasks with a cross-workspace dispatcher

## Install & Quick Start

> Requirements: Node.js ≥ 22.5. Building the desktop app additionally needs Rust (Tauri 2) and Bun.

```bash
# Install the CLI from source
git clone https://github.com/wuzhuangzhishengji2026/zharness.git
cd zharness
npm install
npm run build
npm link            # or: node dist/src/cli.js

# Start the interactive TUI
zharness

# Start the desktop app (dev mode)
npm run dev:desktop

# Run tests (offline)
npm test
```

On first use, configure a model provider in "Settings → Provider" of the TUI/desktop app; configuration lives under `~/.zharness/`.

## Documentation

| Doc | Contents |
|---|---|
| [User Guide](USER-GUIDE.zh-CN.md) (Chinese) | CLI / slash commands / desktop / model tools cheat sheet |
| [Deep Dive](docs/DEEP_DIVE.zh-CN.md) (Chinese) | Architecture, event sourcing, tool system, memory — explained from scratch |
| [Architecture Wiki](wiki/) (Chinese) | Overview, Reactor loop, session tree & timeline, RPC & desktop, SOP market, knowledge library spec |
| [Design Rationale](docs/DESIGN-RATIONALE.zh-CN.md) (Chinese) | Why an event-driven harness: trade-offs vs. Pi / DSH |
| [Persistent Agent Design](docs/PERSISTENT-AGENT.zh-CN.md) (Chinese) | Design doc for the resident persona agent at `~/.zharness/main` |

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

## License

[MIT](LICENSE)

## Acknowledgments

ZHarness grew out of an open-source lineage of event-driven agents: upstream [Pizza / Rango](https://github.com/tomsun28/pizza) and Mario Zechner's [Pizza](https://github.com/badlogic/pizza); the interactive shell and model layer build on the Pi ecosystem packages `@earendil-works/pi-tui` and `@earendil-works/pi-ai`. Thanks to the authors and communities behind these projects.
