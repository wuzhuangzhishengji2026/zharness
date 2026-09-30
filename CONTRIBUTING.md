# Contributing to ZHarness

Thanks for your interest in contributing!

## Development setup

```bash
git clone https://github.com/wuzhuangzhishengji2026/zharness.git
cd zharness
npm install
npm run dev          # tsc watch build of the agent core
npm test             # offline test suite
```

- Node.js ≥ 22.5 is required; the desktop app additionally needs Rust (Tauri 2) and Bun.
- `npm run dev:web` runs the web frontend; `npm run dev:desktop` runs the Tauri desktop app.

### Windows notes

- Building the desktop app from Git Bash needs the MSVC environment; use the bundled
  wrapper: `scripts/with-msvc.bat npm run build:desktop`.
- If linking fails because rustc picks up Git's `/usr/bin/link.exe` (error: `extra operand`),
  pin the MSVC linker for this machine in `apps/desktop/.cargo/config.toml`:

  ```toml
  [target.x86_64-pc-windows-msvc]
  linker = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\<version>\\bin\\Hostx64\\x64\\link.exe"
  ```

## Submitting changes

1. Fork the repo and create a feature branch.
2. Make your change, with tests where it makes sense.
3. Run `npm test` and make sure it passes.
4. Open a Pull Request using the template.

## Commit messages

Please follow the [Conventional Commits](https://www.conventionalcommits.org/) specification
(`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, …). PR titles follow the same convention and
are linted in CI.

## Code style

- TypeScript for the agent core and web frontend; Rust for the Tauri desktop shell.
- Match the style of the surrounding code; don't reformat unrelated lines.
- Keep PRs focused: one logical change per PR.

## Reporting issues

When reporting a bug, include: what you did, what you expected, what happened, and the
relevant output of `zharness --version` plus your OS. Redact any secrets or personal data
from logs before pasting.
