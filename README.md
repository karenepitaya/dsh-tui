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
  its production `ProcessTerminal` keyboard-protocol negotiation, raw mode,
  alternate screen, sanitized bracketed paste, resize, CJK-aware rendering,
  mouse input, and an explicit recovery sequence;
- a retained `VStack` + primary `ScrollView` conversation surface with
  Markdown messages, semantic viewport anchors, follow-at-end streaming,
  per-Session transient scroll state, and full-projection search;
- product-owned text/reasoning/image/tool-call projections: reasoning streams
  independently from the final answer, remains folded by default, and can be
  toggled per Session without changing durable events;
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
  background bindings, and per-session drafts; initial startup and later
  switches share the same lease -> hydrate -> commit chain, so booting does not
  publish a half-bound Session or lose an editable draft;
- safe attach to an exact live ordinary root Agent: borrowed bindings release
  only TUI listeners/mailboxes, never cancel, dispose, or unregister the Agent;
  stale, cancelled, disposed, wrong-identity, and cleanup-failure paths keep the
  source binding current;
- an official per-Agent command adapter, live registry projection, bounded
  slash-command menu, Tab completion, exact dispatch rules, and durable
  `command/run`/`command/done` transcript rows;
- a DSH-native Model Plane backed only by `ctx.llm`,
  `ctx.agentDefaultModel`, and the exact Agent-scoped `ModelSelectionRef`;
  `/model` provides cached-first Provider/model and reasoning selection, while
  external borrowed Agents remain read-only instead of receiving a competing
  selection waterfall;
- an app-global `/connect` surface backed by DSH's live configurable-Provider
  directory, settings, credentials, and authorization services; Provider IDs
  and login methods are discovered at runtime, API-key input is masked, and
  OAuth/API-key persistence remains owned by the official Harness services;
- an optional per-Session context adapter over Harness
  `session-projection`: a responsive statusline shows the routed model and
  effort, provider-anchored context occupancy, cache-hit share, and durable token
  usage; `/context` exposes the three official `token-meter` projections. The
  TUI neither estimates tokens nor owns compaction; `/compact` remains the
  official Harness command, while its durable lifecycle repaints the command
  card, statusline, and context panel live;
- official DSH command-line parsing for new sessions and `--resume`, including
  paired `--provider`/`--model` and dependent `--reasoning-effort` overrides,
  plus an auto-starting Cordis bundle;
- a fresh-create, pre-publication AgentPreset picker that shows official roster
  order, default, trust, broken state, and user-composition shell-trust warning;
  cancellation has zero Agent/Session open calls, while selection carries exact
  id/trust/source-path provenance into unpublished mount validation;
- one Terminal instance across startup selection and the main Controller via an
  input-callback handoff, without a second raw-mode or alternate-screen start;
- a five-layer product layout with optional bounded ANSI-16 semantic color,
  `YOU` / `DSH` / `TOOL` / `CMD` hierarchy, focused interaction cards,
  responsive tiny-terminal degradation, and an empty-session ASCII Cordis
  Whale that yields to conversation content;
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
  DSH CLI, discovers the complete installed Provider directory, connects both
  DeepSeek and OpenAI through `/connect`, proves credentials stay in DSH's
  credential store, exposes the connected OpenAI model without a restart, then
  drives the official DeepSeek adapter against the repository-local Mock LLM
  and verifies the responsive statusline, live `token-meter` occupancy,
  `/context`, and official `/compact` execution. The gate proves one auxiliary
  summary request, the complete durable compaction transaction, a visible
  running-to-completed UI transition, and immediate context refresh; it also verifies default
  `deepseek-v4-flash` -> `/model`
  `deepseek-v4-pro + off` -> next `request/header` with no selection-time model
  request or durable event; fresh CLI selection chooses
  `deepseek-v4-flash-vision-exp + off`; cold resume explicit
  `deepseek-v4-flash + off` beats both historical vision and drifted current
  pro while the historical `minimal` preset returns; the JSONL byte prefix is
  preserved with a contiguous resume suffix, and a missing ID fails before
  Terminal allocation;
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
fork, detailed compaction/error diagnostics, general Provider settings editing,
post-creation blank-session preset recomposition, single-payload
byte/grapheme budgets, wrapped-line caching, full IME/modifier-protocol
coverage beyond pi-tui's negotiated protocols, and Node 22.19 runtime
verification remain future work.

## Cordis mount and public surface

DSH-TUI is a normal Host-plane Cordis plugin. Its package root deliberately
exports only `name`, `inject`, `Config`, `apply`, and the `ctx.dshTui` service
types, including the stable `DshTuiModelSelection` product type. Controllers,
reducers, cold-resume helpers, Model Hub internals, and Tool renderer registries
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

The interactive Terminal accepts an optional bounded semantic theme:

```yaml
- id: dsh-tui
  name: dsh-tui
  config:
    autoStart: true
    theme:
      preset: auto
      colors:
        accent: cyanBright
        reasoning: magenta
        error: redBright
```

`auto` selects the Cordis palette only when the process supports color;
`cordis` explicitly requests it and `mono` emits no color SGR. `NO_COLOR`
forces monochrome colors while retaining safe emphasis such as bold and
underline; `TERM=dumb` disables every SGR style. Overrides are limited to the
documented semantic roles and ANSI-16 names (`default`, the standard eight
colors, `gray`, and their bright variants); arbitrary escape sequences, hex
colors, formatter functions, and unknown roles are rejected before Terminal
allocation. The resolved theme is immutable for one Terminal lifetime and a
Cordis remount is required to apply a changed configuration.

`ctx.dshTui` retains the existing product contract:

- `catalog` lists the authoritative live/durable Session view;
- `inspection` performs detached read-only inspection;
- `activation` attaches or safely resumes an exact Session;
- `presets` exposes the official AgentPreset catalog;
- `open()` creates a fresh composed Session.

### Startup model overrides

Interactive hosts pass these arguments through DSH's official command-line
adapter:

```text
--provider <route> --model <opaque-model-id>
--provider <route> --model <opaque-model-id> --reasoning-effort <opaque-effort-id>
--resume <session-id> --provider <route> --model <opaque-model-id>
```

`--provider` and `--model` are an inseparable pair;
`--reasoning-effort` requires both. Model and effort IDs are adapter-owned
opaque strings, so a model ID may contain `/`. Resume remains mutually
exclusive with `--session-id`, `--cwd`, and `--agent-preset`, but accepts the
model override. Fresh startup uses explicit selection before the current DSH
default. Resume uses explicit selection, then the latest durable
`request/header`, then the current DSH default.

## Ownership, Model Plane, and Tool presentation

Lifecycle ownership follows Cordis fibers and DSH Agent leases:

- the plugin fiber owns the service, product runner, Terminal, interaction hub,
  and built-in Tool renderer registrations;
- each Session binding owns its subscriptions, command session, and pending
  approval/question adapters;
- an owned `AgentHandle` may be disposed by the binding that created it, while a
  borrowed Agent is only unbound when the visible Session changes.

Each Agent created or cold-resumed by DSH-TUI receives exactly one retained
selection ref during unpublished setup. The internal Model Hub associates that
ref with the exact Agent and removes it with the Agent scope. Reattaching the
same TUI-origin Agent reuses the ref; an Agent created by another Host is shown
from its latest `request/header` and marked read-only.

`/model` is a local command only when DSH has not registered an official command
of the same name. It is available while the Agent is idle and no interaction or
other full-screen state has focus. The picker shows its cached snapshot first,
then refreshes Provider groups independently. Enter changes only the visible
Session, Ctrl+S also attempts to save the future-Session default, `R` refreshes,
and Esc closes or returns from reasoning selection. A default-save failure does
not roll back a validated Session change.

Selection is validated with `ctx.llm.resolveCallConfig()` before the retained
ref changes. The composer remains editable while validation is pending, but
prompt, slash-command, and Session-switch submission stays blocked so the next
request cannot silently use the previous route. A switch does not cancel an
already running request and takes effect at the next prompt assembly step. The
click itself is not a durable event; the next real request writes the
authoritative `request/header`. Endpoint, API key, OAuth,
settings, credentials, and authorization remain owned by DSH rather than this
TUI.

`/connect` is app-global rather than Session-owned. It is offered locally only
when DSH has not registered an official command with the same name, and only
while the current Agent is idle. Its rows come directly from
`ctx.llm.listConfigurableProviders()`; no Provider allowlist is compiled into
DSH-TUI. Each row joins the current route, redacted settings, credential state,
and the matching official authorization flow. Selecting a method delegates the
conversation to `ctx.authorization.begin()` when available, including OAuth
URLs/device codes and Provider-native API-key prompts. The narrow fallback is
for a DSH route that declares an API-key reference but no authorization flow.

Secrets are masked while typed and are never copied into the transcript,
settings document, or TUI-owned state. `D` removes only writable local
credentials and a connection-only profile; it preserves custom endpoint/model
configuration and does not claim to revoke a remote OAuth grant. `R` re-reads
the live directory, and Provider/settings/credential/authorization events also
refresh it automatically.

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

## Conversation surface and controls

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

Messages use Markdown for headings, lists, tables, quotes, inline/fenced code,
links, CJK, and incomplete streaming fences. `YOU` and `DSH` use an unboxed role
gutter; Tool, command, approval, and question output remains in bounded cards.
Only the current 512-row product projection is searchable and scrollable. If
older rows or draft chunks have left that bounded projection, an explicit
omission marker is rendered instead of pretending that the visible document is
complete.

Reasoning is never concatenated into the final answer. While streaming it is
summarized as `THINKING · streaming`; completed replies prefer the durable
reasoning-token count and otherwise show a line count. `Ctrl+T` expands or
folds all reasoning in the current Session. This preference and viewport state
are transient, isolated by Session/binding epoch, and retained in a 32-Session
LRU only for the current Terminal lifetime.

The viewport follows streaming only while it is at the bottom. PageUp,
PageDown, mouse-wheel scrolling, or scrollbar dragging freezes the reading
position; later output adds `New output · Ctrl+End follow` without stealing the
viewport. `Ctrl+Home` and `Ctrl+End` jump to the projected top and bottom,
`Ctrl+Shift+Up/Down` moves between user turns, and `Ctrl+F` opens transcript
search. Enter/Shift+Enter selects the next/previous match; Esc or the first
Ctrl+C closes search. Home/End remain composer-local. A successfully accepted
local prompt always resumes follow-at-end.

The full Cordis Whale appears only for a sufficiently large empty Session, a
compact wordmark appears at medium sizes, and both disappear below 40 columns
or 8 rows. One row shows only the Header, two add the Composer, and three add the
Footer; transcript and dock receive space only above that. From five rows, the
quiet statusline receives one stable row between the interaction dock and the
composer. It drops token, cache, and model detail in that order as width shrinks,
while an active compaction and context pressure retain priority. Semantic
ANSI-16 colors are optional and bounded by the theme configuration rather than
a public theme/plugin ABI.

External message text is stripped of CSI/OSC/APC and unsafe controls before
Markdown parsing. Clickable links are restricted to `http`, `https`, and
`mailto` destinations of at most 2048 characters, with an OSC8 output-side
allowlist as a second boundary; unsupported URLs remain visible but inert. No
external URL opener is installed.

## Non-goals

This MVP intentionally does not add a Remote/API-proxy TUI, React slots, a
general TUI slot ABI, untrusted external plugins, a general Provider settings
form, job/goal/subagent panels, a new persistent store, or new Harness public
interfaces. The internal Tool renderer registry will remain private until a
second real external contributor demonstrates the shape of a narrower public
contract.

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

### Install the current checkout into a local profile

Do not repeatedly install this checkout with the same `file:` spec. pnpm may
correctly consider the unchanged package name/version up to date while the
profile still contains an older copied `lib` tree. Use the checked-in installer
instead:

```powershell
pnpm install --frozen-lockfile
.\scripts\install-local.ps1 -Profile tui
```

The script builds a content-addressed tarball, installs that exact artifact
through the sibling Harness CLI, and compares every installed `lib` file plus
`cordis.patch.yml` against this checkout. Success ends with
`DSH_TUI_INSTALL_OK` and prints the exact command that starts the profile. A
stale or partially installed package is a hard failure rather than a warning.

For the shortest edit-to-terminal acceptance loop, run:

```powershell
pnpm run dev:profile
```

This is one command for **build -> content-addressed pack -> forced profile
replacement -> byte-for-byte install verification -> launch**. Expect
`DSH_TUI_INSTALL_OK`, then `DSH_TUI_LAUNCH profile=tui`, followed by the real
DSH-TUI startup preset picker. Exit the TUI and rerun the command after the next
source change.

For a manual Provider acceptance, select a startup preset, enter `/connect`,
choose any Provider and one of the methods DSH advertises, then close the panel
and enter `/model`. A newly configured route/model must appear without
reinstalling or restarting the TUI. Repeat `/connect` for another Provider to
verify that the directory is not a DeepSeek-only special case.

For context acceptance, send one prompt through a connected Provider. The
statusline should show `provider/model/effort`, `ctx [gauge] ~used/window
percent`, cache hit, and cumulative input/output tokens when those official
facts are available. Enter `/context`: it must say `[DSH/token-meter]`, show
provider prompt usage and the official projection sequence, and must not label a
local estimate as authoritative. Enter `/comp` to confirm `/compact` is
`[DSH/official]`. On a long enough Session, execute it: the command card and
statusline should first show `running` / `compact …`, then settle to success.
Reopen `/context`; it should show `Last compaction · completed`, and the
projected next-request occupancy should already reflect the replacement.

This is deliberately restart-based development loading, not in-process HMR.
`cordis.patch.yml` disables HMR because module replacement and terminal raw-mode
ownership cannot safely overlap yet. The restart keeps each manual acceptance
on a fresh, verified plugin generation without introducing another runtime
lifecycle.

`-HarnessRoot` may point at another built DeepSeek Harness checkout. The script
does not require a global `dsh` executable.

### Repository gates

```powershell
pnpm install --frozen-lockfile
pnpm run verify
pnpm pack --dry-run
```

On the verified Windows baseline, `pnpm run verify` covers 58 test files and
667 tests. V8 coverage is 100% for statements (6289/6289), branches
(4645/4645), functions (1298/1298), and lines (5605/5605). The same command also
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

## License

DSH-TUI is available under the [MIT License](./LICENSE).
