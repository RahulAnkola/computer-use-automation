# Design Report

## 1. Architecture

**One process, two execution paths sharing everything except the
decision-maker.** Discovery (`src/agent/discover.ts`) and replay
(`src/replay/executor.ts`) both drive the same `core/` primitives —
perception, locator resolution, guardrails, checkpoints, escalation. The
only difference is *who decides the next action*: an LLM during discovery,
a fixed step list during replay. That symmetry is the point: replay isn't a
second implementation to keep in sync with the agent, it's the same
action-execution machinery minus the decision loop.

**Stack:** TypeScript/Node, Playwright, Gemini (`gemini-flash-lite-latest`
via `@google/genai`) for the LLM, Zod for the artifact schema, Express for
the mock target app, Vitest for tests. Gemini because the provider is
explicitly "my call" and I wanted my own key rather than route through this
environment's model access; the agent loop is provider-agnostic behind one
`LlmClient` class.

**Perception:** not screenshots+coordinates, not raw DOM. Each turn,
`core/perception.ts` walks the live page and returns interactive elements
*and* labeled read-only data cells (balances, ids), each with a role,
accessible name, and locator — closer to an accessibility tree than to
markup. This is deliberate: the brief flags "no clean DOM" as the common
case, and an accessibility-tree-shaped view generalizes to that (and to
desktop, which exposes a real accessibility tree) in a way CSS selectors
and pixel coordinates don't.

**Target app:** a small Express app, "BankOps Console" (member search →
record → open-sub-account → review → confirm), deliberately legacy: nested
tables, no test ids, no `<label for>`, a session interstitial, a
restricted-account wall, deposit validation, a manager-approval gate above
$10,000. I needed these specific conditions to exist on demand to exercise
locator robustness and the error taxonomy — a public demo site would have
fought me for that control.

**Trade-off:** the agent loop is stateless per turn — no growing
multi-turn `Content[]` history, just system prompt + current observation +
a short text recap of prior actions each call. Simpler and cheaper than
threading tool-call/response parts through Gemini's API, at the cost of the
model not literally remembering earlier turns beyond the recap. Fine for
flows this short; a longer task would need real conversational memory.

## 2. Artifact schema

The schema (`src/core/artifact.ts`) treats an artifact as **a callable's
contract, not a macro**: `inputs`/`outputs` are typed and named (with a
`pattern` for validation, a `sensitive` flag for redaction); `steps` are
ordered actions with locators and checkpoints; `knownOutcomes` declares the
non-happy-path taxonomy; `successCheckpoint`, `riskLevel`,
`approvalStatus` (`draft`/`approved`), and `provenance` round out what a
reviewer or calling agent needs to know without reading the engine.

The single most important choice: locator `name`/`text`/`label` fields and
step `value`/`url` fields are **template strings** (`{{memberId}}`), not
literals. Discovery runs against one concrete member id; building the
artifact (`templatizeString`) replaces literal occurrences of a known
param's value with its placeholder, so a step recorded against `10023`
replays correctly for `10045`. Checkpoints are template strings too — I
missed this initially (see §3) and a checkpoint compared the literal text
`{{memberId}}` against a real URL, always failing.

**Locators are a discriminated union of five strategies** (`role`,
`label`/`cell`, `text`, `css`, `testid`), each with ordered fallbacks. I
split `role` from `label`/`cell` after a real bug: `perception.ts` derives
an element's name several ways (`aria-label`, a real `<label>`,
placeholder, own text, or — for this legacy table layout — the *preceding
table cell's* text). That last one isn't part of the accessibility tree, so
a naive `getByRole(role, {name})` silently fails and a `getByText(name)`
fallback matches the *label cell itself*, not the control next to it.
Perception now tracks *how* a name was derived and only emits a `role`
locator for names the browser's own accessibility computation would agree
with; a table-derived name gets a structural locator instead (`cell` for
read-only data, `label` for form controls — "the value/control in the row
containing this text"). Every resolution also records which strategy
actually worked: a step that only succeeds via its last fallback is a
signal to re-record, not just a debug detail.

**Outputs are grounded, not asserted.** They only ever come from an
explicit `extract` step's DOM read, never from the LLM's own claim about
what happened — the discovery prompt requires calling `extract` with the
capability's exact declared output name for anything the goal asks it to
report.

## 3. Determinism & error handling

Replay never calls an LLM. It resolves each step's locator (same resolver
discovery uses), verifies its checkpoint, and classifies the outcome into
one of four buckets: **success** (all checkpoints held, declared outputs
returned typed); **business outcome** (an action/checkpoint failed, but the
current page matches one of the artifact's `knownOutcomes` — "no such
member" returned as data, not an exception); **recoverable** (every step
gets one bounded retry, absorbing transient slowness); **hard failure**
(nothing matched — returned as `{step, expected, observed, message}`,
enough to debug without a debugger attached).

Two bugs surfaced by actually running this against real discovery+replay
pairs, both fixed and now covered by tests/evidence:

- **Checkpoint templates weren't rendered.** `checkpointHolds` compared
  `page.url()` against the literal string `"/members/{{memberId}}"`
  instead of the substituted value — every post-navigation checkpoint
  silently failed. Fixed by threading `params` through `checkpointHolds`
  the same way locators get them.
- **A known-outcome detector assumed the wrong page.** `PERMISSION_DENIED`
  was written to match the dedicated 403 page's text, but the recorded flow
  never reaches that page for a restricted member — the "Open Sub-Account"
  link simply isn't rendered on the member page, so the *previous* step's
  locator fails to resolve. Fixed by detecting the restriction from
  whichever page actually shows it first.

A session interstitial (a "confirm you're still here" page that renders
*at the same URL*, which is exactly why the first bug above was easy to
miss) is handled generically: both discovery and replay check for it and
dismiss it before every step (`core/interstitials.ts`), rather than baking
a "click Continue" into every capability that happens to pass through that
route. This is infrastructure, not business flow, and it also saves an LLM
call per run.

`knownOutcomes` are hand-authored on top of two real discovery runs (golden
path + escalation path), not mined by deliberately steering the agent into
every failure mode. In practice this matches how I'd expect it to work: a
recorded flow is a draft; a human adds the known failure modes they
understand about the app before approving it for unattended replay — which
is exactly what `approvalStatus` (§6) makes structural.

## 4. Heterogeneity & multi-tenant

The seam is `perception.ts`/`actions.ts` on one side ("produce {role,
name, kind} facts about the UI, however you get them" / "act on a
`Locator`") and the artifact's `Locator` union on the other. Nothing above
that seam knows whether the facts came from a DOM walk, a native
accessibility API, or an OS-level UI Automation tree.

**Desktop** extends directly: Windows UI Automation and macOS Accessibility
both expose role+name+value for native controls — the same shape as
`PerceivedElement`. A new locator variant plus a UIA/AX-backed
`resolveLocator` would be the only additions; the schema, replay engine,
guardrails, and escalation mechanism are unchanged. Not built (out of
scope), but the legacy-web "the accessible name isn't reliable, target
structurally instead" problem I already solved is the same category of
problem a poorly-labeled desktop app presents.

**Multi-tenant reuse** is the harder half, and today's schema handles
*parameterization* (same artifact, different data) but not yet *tenant
variation* (same artifact, different UI). Direction: separate an artifact's
identity (`vendorApp`, `flow`) from a thin per-tenant **override layer** —
a patch to specific steps' locators/routes/labels, resolved as
"tenant override if present, else base" at replay time. This keeps the
common case (one recording, many tenants) cheap and confines tenant
knowledge to a diff. **Drift detection** reuses the same "which locator
strategy resolved" signal from §2: a tenant build that's drifted starts
failing its primary locator, a fallback catches it, and that's the signal
to flag the artifact for review rather than degrade silently forever — the
natural home for the "multi-run stability" stretch goal (not built).

## 5. Escalation & handoff

**Detecting "stuck"** has two triggers: the agent calling `request_human`
when it doesn't know how to proceed, and — more importantly for safety —
the guardrail layer intercepting any click on a control whose accessible
name matches a risky pattern (`"approve as manager"`, `"delete"`, ...)
*before* it happens, regardless of what the model wanted. Replay has the
identical seam via a first-class `escalate` step type, so a capability
inherently gated on a human decision (`bankops.open_sub_account_large_deposit`)
escalates on every replay by design, not just when something breaks —
demonstrated in evidence for both discovery and replay.

**Taking control of the live session, not a fresh one** is where I spent
the most effort, because it's easy to fake — I initially faked it by
accident. First attempt: `chromium.launchServer()` + the operator process
`chromium.connect()`-ing to its WebSocket endpoint. That runs, but
Playwright's client multiplexing gives each `connect()` an *isolated*
session that can't see another connection's contexts (it's built for
spreading test workers over one browser, not sharing a page) — the
operator reliably saw zero contexts. Fix: launch with a real
`--remote-debugging-port` and have the operator attach via
`chromium.connectOverCDP()` — raw CDP is a single global namespace on the
actual browser process, so a second process really does see the same
tab. `core/session.ts` persists that port; on escalation the automation
writes an `InterventionRequest` (goal, step, URL, screenshot, reason) to a
file-backed queue (`core/escalation.ts`) and blocks — the browser stays
open, the page stays put. The separate `operator` CLI reads the queue,
connects over CDP, and performs the actual manual step (clicking "Approve
as Manager") against that live page, standing in for a human, then writes
the resolution back. I mocked the operator *UI* (a CLI, not a co-browsing
console — allowed by the brief's scope note) but not the *control-transfer
mechanism*: the cross-process CDP handoff onto one shared session is real.

**Limits:** "who's in control" is a status file, not an enforced lock —
nothing stops the automation from touching the page mid-escalation besides
the fact that it's blocked on `waitForResolution`. A production version
needs a real mutex/lease and an abandonment policy for unclaimed
interventions.

## 6. Safety

**Allowlist enforcement** (`core/guardrails.ts`): every navigation is
checked against `allowedDomains`/`allowedRoutePatterns` before it happens,
for both discovery and replay, from one shared code path.

**Risky vs. safe:** structurally, a risky step makes its whole capability
`riskLevel: "risky"`, and risky capabilities replay headful, not headless —
a person needs to be able to see the session the moment it needs them.
Behaviorally, `riskyControlPatterns` block a specific control regardless of
which step it's part of — this is what stops the agent from clicking
"Approve as Manager" even if its own reasoning decided that seemed fine. I
chose block-and-escalate over "require inline confirmation" because inline
confirmation still trusts the same agent to correctly ask permission;
routing to a human on the real session removes it from the decision.

**Data handling:** `redactText`/`redactValue` mask SSN/card/token-shaped
strings and anything under a sensitive-looking key, applied on every log
write. This caught a real false positive during development: the pattern
for "token-shaped string" (24+ word characters) was also matching ordinary
identifiers like the capability name `open_sub_account_large_deposit`,
silently mangling the logs. Fixed by requiring a digit and excluding
underscore-separated shapes — a good reminder that an over-eager redaction
rule is its own bug, not just a safe default.

**Approval gate:** `approvalStatus: "draft"|"approved"` — unattended
replay of a draft artifact is refused unless the caller passes `--force`.
The structural version of "someone should look at this before it runs
unattended against production data."

**Where this runs out:** guardrails are pattern-based today. A renamed
control or an innocuously-labeled risky action would slip through. A
better version classifies risk from the action's *effect* (does it hit a
state-changing route?) rather than its label — noted as next work rather
than built, since it needs real usage data to calibrate.

## 7. Cuts

- **Co-browsing console** — out of scope per the brief; built the real
  control-transfer mechanism (§5) instead of UI polish.
- **Desktop surface** — argued the seam (§4) rather than build a stub.
- **Multi-tenant override layer** — designed (§4), not built; no second
  tenant to test it against, and the brief warns against premature scaling
  infrastructure.
- **LLM-discovered failure taxonomy** — `knownOutcomes` are hand-authored
  on top of two genuine discovery runs (golden path + escalation), not
  mined across every failure path.
- **Confidence scoring / multi-run stability** (stretch) — designed as the
  natural extension of the per-step locator-confidence signal, not built.
- **Assisted LLM recovery on replay failure** (stretch) — skipped in favor
  of escalation: routing a failure to a human is more conservative than
  letting an LLM improvise against a live financial session.
- **Enforced session lock during escalation** — a real gap, noted in §5.

**Next, in order:** (1) an effect-based risk classifier instead of label
regexes, (2) the multi-tenant override layer once a second real tenant
surface exists, (3) per-artifact stability scoring from repeated replay,
feeding the `draft`→`approved` decision.
