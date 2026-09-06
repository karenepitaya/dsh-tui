# Product

<!-- impeccable:product-schema 1 -->

## Platform

Terminal TUI (Windows ConPTY and ANSI-compatible terminals).

## Users

Developers using DeepSeek Harness from a terminal, especially during long-running coding-agent sessions where immediate feedback, compact transcripts, keyboard navigation, and inspectable execution details matter.

## Product Purpose

DSH-TUI is the interactive terminal surface for DeepSeek Harness. It must keep ordinary conversation quiet and readable while making execution, diffs, sessions, capabilities, permissions, and workbench state available on demand.

## Positioning

The product combines a Claude Code-style compact conversation flow with OpenCode-style secondary workspaces, while remaining a minimally invasive Cordis plugin over DSH durable events and capabilities.

## Operating Context

Users work in PowerShell or other ANSI terminals, often with CJK text, narrow and wide viewports, Windows paths, long tool output, streaming responses, and multiple DSH sessions. The primary interaction is keyboard-first; secondary surfaces support arrow keys and `hjkl` where text insertion is not active.

## Capabilities and Constraints

- TypeScript, pi-tui, pi-tui-orbs, Vitest, xterm-headless, and Windows ConPTY remain the implementation stack.
- DSH `0.1.1-rc.2` is pinned exactly; compatibility logic is isolated from the UI and feature kernel.
- Durable DSH events remain the source of truth for transcript, tools, goal, plan, and todo state.
- The experimental Feature API must support lazy, scoped features without central Controller, Frame, input-router, or layout edits.
- Chat, Composer, permissions, and other safety interactions are required product capabilities; optional secondary features fail independently.
- Desktop and an OpenTUI migration are outside the current product scope.

## Brand Commitments

- Keep the DSH-TUI name.
- Normal chat follows Claude Code's restrained, frameless reading rhythm: no `YOU`/`DSH` speaker labels, a low-contrast user strip, compact assistant prose, and one-row separation between turns.
- Secondary pages follow OpenCode's structured navigator/content/inspector composition and focused overlays.
- Color is semantic and quiet; status, selection, diff, error, and focus carry meaning rather than decorative variety.

## Evidence on Hand

The repository contains the existing TUI implementation, ConPTY and xterm-headless visual tests, DSH integration tests, and user-supplied Claude Code/OpenCode reference screenshots in the task history. No external product claims or benchmark data should be invented.

## Product Principles

- Conversation first; operational detail on demand.
- Immediate request feedback with bounded motion.
- Feature, resource, layout, and DSH adaptation lifecycles remain independent.
- Keyboard-first interaction must never interfere with text entry.
- Every milestone is packaged and exercised through the real DSH profile.
