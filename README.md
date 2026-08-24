# DSH-TUI

Clean-room terminal product for DeepSeek Harness `0.1.1-rc.2`.

The current checkpoint is an assembled, runnable vertical slice rather than a
terminal mock. It includes:

- an official DSH Agent/session adapter for create, resume, followup, steer,
  cancel, idle, flush, and dispose;
- one reducer for durable replay and live delivery, with append-origin human
  transcript semantics and `callId`-based tool correlation;
- exact-live-Agent Tool presentation through DSH's public `presentCall()` and
  `presentResult()` hooks; render intents travel as ephemeral delivery
  annotations and never enter the durable journal or sequence comparison;
- an internal, effect-owned Tool card registry covering `generic`, `terminal`,
  `diff`, `search`, `read`, and `web`, with bounded generic fallback, recursive
  sensitive-key redaction, and terminal-control sanitization;
- bounded question/approval snapshots with validation and exactly-once
  settlement;
- a byte-oriented input decoder, prompt and interaction editors, a pure frame
  renderer, bounded UI projections, and a coalescing frame scheduler;
- `@earendil-works/pi-tui@0.84.2` behind a narrow `TerminalDriver`, including
  raw mode, alternate screen, bracketed paste, resize, CJK-aware rendering,
  ANSI/control sanitization, and an explicit recovery sequence;
- one product Controller and lifecycle owner that maps clean, fatal, and forced
  exits without letting lower layers dispose the Cordis root;
- a merged durable/live session catalog and capability-aware local picker that
  keeps exact live switching, detached read-only inspection, and consented cold
  activation as separate capabilities;
- detached logical inspection of durable-observed cold root and delegated
  sessions through official `sessionPersistence.inspect()`, with immutable
  snapshots, bounded copy/replay yields, exact header/event identity checks,
  compatibility fail-closed behavior, refresh rollback, bounded scrolling, and
  no load, prepare, resume, commit, publication, or storage repair;
- exact `SessionBinding` objects with monotonic epochs, isolated candidate
  replay/interaction hydration, atomic current-pointer commit, cached
  background bindings, and per-session drafts;
- safe attach to an exact live ordinary root Agent: borrowed bindings release
  only TUI listeners/mailboxes, never cancel, dispose, or unregister the Agent;
  stale, cancelled, disposed, wrong-identity, and cleanup-failure paths keep the
  source binding current;
- an official per-Agent command adapter, live registry projection, bounded
  slash-command menu, Tab completion, exact dispatch rules, and durable
  `command/run`/`command/done` transcript rows;
- official DSH command-line parsing for new sessions and `--resume`, plus an
  auto-starting Cordis bundle;
- a fresh-create, pre-publication AgentPreset picker that shows official roster
  order, default, trust, broken state, and user-composition shell-trust warning;
  cancellation has zero Agent/Session open calls, while selection carries exact
  id/trust/source-path provenance into unpublished mount validation;
- one Terminal instance across startup selection and the main Controller via an
  input-callback handoff, without a second raw-mode or alternate-screen start;
- a monochrome five-layer product layout with `YOU` / `DSH` / `TOOL` / `CMD`
  hierarchy, focused interaction cards, responsive tiny-terminal degradation,
  and an empty-session ASCII Cordis Whale that yields to conversation content;
- exact ordinary-root cold resume through one shared coordinator for both the
  inspected picker flow and startup `--resume`: it restores historical
  model/reasoning/max-token/preset semantics before publication, rechecks the
  prepared Session, serializes same-ID ownership, and distinguishes owned from
  borrowed teardown;
- a two-step inspection consent flow (`a`, then Enter) that rechecks the latest
  cold-root observation before activation; the confirmation explicitly warns
  that resume may repair or append durable storage and publish an Agent;
- one shared delegated-session predicate (`origin === 'subagent'` or
  `delegationDepth > 0`) across catalog, inspection, planning, live attach, and
  external-winner classification; delegated sessions remain read-only;
- typed external-winner adoption only for a complete same-ID ordinary live root
  observed before resume or after a registry race that began with both edges
  empty; arbitrary coordinator failures are preserved;
- real Windows ConPTY gates for graceful and second-interrupt forced shutdown;
- an isolated official-profile E2E that installs the built package through the
  DSH CLI, drives the official DeepSeek adapter against the repository-local
  Mock LLM, and verifies fresh `standard`/`minimal` creation plus real startup
  cold resume: the same session ID and transcript return, historical
  `deepseek-v4-flash + minimal` beat drifted current
  `deepseek-v4-pro + standard`, the JSONL byte prefix is preserved with a
  contiguous resume suffix, and a missing ID fails before Terminal allocation;
- real Windows ConPTY lifecycle proof for each fresh/resume process, including
  one logical alternate-screen transition, exact terminal recovery, clean exit,
  and process disappearance.

Ordinary root sessions can now be attached live or resumed cold. A cold row is
first inspected without side effects; only explicit confirmation enters the
resume coordinator. Startup `--resume` uses that same coordinator and skips the
fresh preset picker. The public `ctx.dshTui.open()` contract is create-only;
callers use `activation.activateSession({ intent: 'resume-cold', ... })` for
cold resume, while the package-internal low-level runtime opener continues to
fail closed so it cannot bypass restore/ownership checks.

“Exact” here means semantic reconstruction within the pinned rc.2 contract,
not persistence revision/CAS, byte-identical plugin-graph reconstruction,
preset-content hashing, or durable rollback. Commit-time default drift fails
closed rather than retrying after downstream commit. Delegated activation,
fork, compaction/error diagnostics, model selection UI, post-creation
blank-session preset recomposition, single-payload byte/grapheme budgets,
wrapped-line caching, full IME/modifier-protocol coverage, and Node 22.19
runtime verification remain future work.

## Cordis mount and public surface

DSH-TUI is a normal Host-plane Cordis plugin. Its package root deliberately
exports only `name`, `inject`, `Config`, `apply`, and the `ctx.dshTui` service
types. Controllers, reducers, cold-resume helpers, and Tool renderer registries
are product internals rather than a second Harness API.

The shipped `cordis.patch.yml` mounts interactive product mode into `dsh-base`:

```yaml
- id: dsh-tui
  name: dsh-tui
  config:
    autoStart: true
```

For an embedding that only needs the service contract, mount with
`autoStart: false` (the default). That mode provides `ctx.dshTui` without
allocating a Terminal or taking process interaction ownership. `autoStart:
true` first requires launcher-provided `ctx.cmdlineArgs` and `ctx.appExit`, then
allocates the Terminal. Cordis disposal removes the service and every
effect-owned registration; the same root can mount the plugin again without a
stale provider, listener, renderer, keymap, or raw-mode owner.

`ctx.dshTui` retains the existing product contract:

- `catalog` lists the authoritative live/durable Session view;
- `inspection` performs detached read-only inspection;
- `activation` attaches or safely resumes an exact Session;
- `presets` exposes the official AgentPreset catalog;
- `open()` creates a fresh composed Session.

## Ownership and Tool presentation

Lifecycle ownership follows Cordis fibers and DSH Agent leases:

- the plugin fiber owns the service, product runner, Terminal, interaction hub,
  and built-in Tool renderer registrations;
- each Session binding owns its subscriptions, command session, and pending
  approval/question adapters;
- an owned `AgentHandle` may be disposed by the binding that created it, while a
  borrowed Agent is only unbound when the visible Session changes.

For every live or replayed Tool event, the runtime adapter keeps a bounded
`callId` table and asks `ctx.tools.get(name, exactAgent)` for presentation. The
durable event is reduced first; the optional presentation annotation is then
projected onto its `ToolRow`. Replaying the same durable sequence with a changed
presentation therefore cannot manufacture a sequence conflict.

Presentation degrades in a fixed order:

1. a valid current DSH render intent selects the matching internal renderer;
2. a missing renderer, malformed view, empty return, or renderer exception uses
   the generic Tool card;
3. invalid JSON, a missing call/result pairing, an absent presenter, or a
   presenter exception also uses the generic Tool card without dropping the
   durable event.

Detached cold inspection intentionally has no live Agent scope and therefore
uses raw generic cards. Once activated, replay through the exact live Agent
restores rich cards. Card bodies are capped at eight lines with head/tail
retention; unknown presentation cards are degradable, while unknown required
durable events retain the reducer's fail-closed behavior.

## Terminal layout and non-goals

The normal Session view has one visible Session and five layers:

```text
DSH-TUI · <session> · <idle/running>
────────────────────────────────────
conversation timeline and Tool cards
focused approval/question card
────────────────────────────────────
> composer
contextual shortcuts / status
```

The design is monochrome and uses spacing, borders, labels, and responsive
degradation rather than an ANSI theme ABI. The full Cordis Whale appears only
for a sufficiently large empty Session, a compact wordmark appears at medium
sizes, and both disappear below 40 columns or 8 rows. Header, composer, and
footer remain bounded in 1/2/3-line terminals according to the available rows.

This MVP intentionally does not add a Remote/API-proxy TUI, React slots, a
general TUI slot ABI, untrusted external plugins, model/job/goal/subagent panels,
a new persistent store, or new Harness public interfaces. The internal Tool
renderer registry will remain private until a second real external contributor
demonstrates the shape of a narrower public contract.

## Requirements

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- PowerShell 7+ and Windows ConPTY for the Windows release gates
- a matching DeepSeek Harness checkout at `..\deepseek-harness` for the
  official-profile E2E, or an explicit `-HarnessRoot` passed to
  `scripts\official-dsh-e2e.ps1`

The verified local baseline is Node.js `v24.19.0`, pnpm `11.19.0`, and DeepSeek
Harness commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. The declared Node.js
`22.19.0` minimum has not yet been run locally.

## Verify

```powershell
pnpm install --frozen-lockfile
pnpm run verify
pnpm pack --dry-run
```

On the verified Windows baseline, `pnpm run verify` covers 47 test files and
464 tests. V8 coverage is 100% for statements (4091/4091), branches
(2905/2905), functions (826/826), and lines (3641/3641). The same command also
runs the deterministic Controller-to-ConPTY
graceful/forced scenarios, the official DSH profile + Mock LLM fresh/resume/
missing-ID E2E, TypeScript type checking, the production build, built-package
imports, and a real Cordis Loader smoke.

The official E2E uses an isolated OS-temporary `DSH_HOME`, `DSH_AGENTS_HOME`,
and workspace. It uses a dummy credential accepted only by the repository-local
Mock LLM; no provider credential or public model endpoint is required. Its first
run may still access the package registry when the pnpm store lacks a dependency.

The wider architecture research and source-audit notes belong to the parent DSH
workspace and are intentionally not part of this standalone source repository.
The public contracts, ownership rules, fallback hierarchy, verification gates,
and current non-goals are documented above.
