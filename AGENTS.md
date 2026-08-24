# DSH-TUI repository instructions

This repository is a clean-room implementation.

- Do not copy or adapt source from `ccch1mneyyy/dsh-TUI`. Its own origin
  audit reports code derived from leaked proprietary sources.
- Treat `dsh-tui/dsh-tui` only as historical architecture evidence unless
  the license of a specific upstream DeepSeek file has been resolved first.
- Public behavior, protocol facts, performance invariants, and independently
  written test scenarios may be studied and reimplemented.
- Keep DeepSeek Harness integration behind `src/dsh/`; terminal/render code
  must not import Harness packages.
- Pin every direct `@deepseek-ai/*` prerelease to one exact version. The M0
  contract kernel intentionally has no Harness runtime dependency.
- Session events are the durable source of truth. Live and replay paths must
  use the same reducer.
- Windows ConPTY, graceful shutdown, interaction settlement, and terminal
  restoration are release gates, not optional smoke tests.
- Use pnpm and PowerShell 7+. Add the narrowest failing test before a fix.
