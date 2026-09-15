# Design Report

## 1. Architecture

**Single process, two execution paths that share almost everything except
the decision-maker.** Discovery (`src/agent/discover.ts`) and replay
(`src/replay/executor.ts`) both drive the same `core/` primitives —
perception, locator resolution, guardrails, checkpoints, escalation. The
only real difference is *who decides the next action*: an LLM during
discovery, a fixed list of recorded steps during replay. That symmetry is
deliberate — it's what makes "record once, replay many" credible instead of
aspirational: the replay engine isn't a second implementation that has to
be kept in sync with the agent, it's the same action-execution machinery
minus the decision loop.

**Stack:** TypeScript/Node, Playwright for the browser surface, Gemini
(`gemini-2.5-flash`, via `@google/genai`) for the LLM, Zod for the artifact
schema, Express for the mock target app, Vitest for tests. Gemini rather
than an Anthropic model because the assignment explicitly leaves the
provider as "your call" and I wanted to use my own key rather than route
through this environment's model access — the agent loop is provider-
agnostic behind `LlmClient` (one class, one method: turn a system prompt +
observation into a tool call).

**Perception mechanism:** not screenshots-plus-coordinates, not raw DOM.
Each turn, `core/perception.ts` walks the live page and produces a compact
list of *interactive elements* (buttons, links, form controls) plus
*labeled read-only data cells* (balances, ids, statuses), each with a role,
an accessible name, and a locator strategy — closer to an accessibility
tree than to markup. I chose this deliberately over screenshot+pixel-
coordinate control because the brief calls out "no clean DOM" as the common
case, and an accessibility-tree-shaped view generalizes to that case (and
to desktop apps, which expose a real accessibility tree) in a way that CSS
selectors and pixel coordinates don't. The agent never sees raw HTML.

**Why a legacy mock app instead of a public site:** the interesting problems
here — no test ids, table-based layout, a label that's just text in a
sibling `<td>`, an interstitial that renders in place without changing the
URL — needed to exist on purpose so I could exercise and test locator
robustness and error handling. A public demo site would have fought me for
control over exactly those conditions, and I'd have been unable to inject
the specific business-outcome/validation-error/escalation scenarios the
evaluation cares about. "BankOps Console" (`src/mock-app/`) is a small
Express app: member search → member record → open-sub-account →
review → confirm, with a session interstitial, a restricted-account
permission wall, deposit validation, and a manager-approval gate above
$10,000.

**Key trade-off:** stateless-per-turn agent loop. Rather than threading a
growing multi-turn `Content[]` history through Gemini's function-calling
API (with all the bookkeeping that requires for tool-call/tool-response
round-tripping), each discovery step is a fresh call: system prompt +
current observation + a short text recap of prior actions. This is simpler
and cheaper (smaller prompts, no accumulating context), at the cost of the
model not literally "remembering" earlier turns beyond the recap I hand it.
For flows this short (a dozen-ish steps) that trade was worth it; a longer
or more exploratory task would need real conversational memory.

## 2. Artifact schema

The schema (`src/core/artifact.ts`, `CapabilityArtifactSchema`) is built
around one idea: **an artifact is a callable's contract, not a macro.**
A macro is "the clicks I happened to make." A contract is "here's what you
give me, here's what you get back, here's how I recognize each outcome."
Concretely:

- **`inputs` / `outputs`** (`ParamSpec[]` / `OutputSpec[]`): typed,
  named, with a `pattern` for input validation and a `sensitive` flag so
  the redaction layer knows what never to log in the clear. This is what
  makes the artifact *invokable* by an agent rather than just *readable* by
  a human — see the `catalog` CLI, which lists exactly this contract.
- **`steps`**: each has a `locator` (see below), an `action`, an optional
  `checkpoint`, and a `riskLevel`. Crucially, locator `name`/`text`/`label`
  fields are **template strings** (`{{memberId}}`), not literals. A
  discovery run happens against one concrete member id; the artifact-
  building step (`templatizeString` in `core/templating.ts`) replaces every
  literal occurrence of a known parameter's value with its placeholder, so
  the exact same recorded click on "Open Record" for member `10023` works
  for any member id at replay time. This is the single most important
  design choice in the schema — without it, "record once" would still mean
  "replay for that one input."
- **`locator` is a discriminated union with five strategies** — `role`
  (accessible role + name, matches what Playwright's own accessibility
  computation would find), `label`/`cell` (structural: "the control/value
  in the row containing this label text" — for legacy table-layout forms
  with no real `<label for>`), `text`, `css`, and `testid`. Each recorded
  locator also carries an ordered list of **fallbacks**. I split `role`
  from `label`/`cell` on purpose after hitting a real bug during
  development: a name derived by *reading a sibling table cell* is not
  part of the accessibility tree, so a naive `getByRole(role, {name})` or
  `getByText(name)` fallback would silently resolve to the *label* cell
  instead of the control next to it. `perception.ts` tracks *how* a name
  was derived (`aria` / `label` / `placeholder` / `own-text` / `row-label`)
  and only emits a `role` locator when the name came from a real
  accessible-name mechanism; a `row-label`-sourced name gets a structural
  `label`/`cell` locator instead. That distinction is exactly the kind of
  robustness reasoning the brief asks for, and it's encoded in the schema,
  not left as a comment.
- **`knownOutcomes`**: a declared taxonomy of non-happy-path results
  (`MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, `VALIDATION_ERROR`, ...), each
  with a `detect` checkpoint and a `resultType`. This is what lets replay
  return "no such member" as data, not throw. See §3.
- **`successCheckpoint`**, **`riskLevel`**, **`approvalStatus`**
  (`draft`/`approved`), and **`provenance`** (which discovery run, which
  model, when) round out the review surface: a human approving a capability
  for unattended replay can see all of this without reading the replay
  engine's source.

**What I deliberately kept out of the schema:** raw model transcripts,
screenshots, chain-of-thought. The artifact is decoupled from the discovery
run that produced it — provenance links back to the run id for audit, but
the artifact itself is small, diffable, and reviewable on its own.

## 3. Determinism & error handling

Replay never calls an LLM. Given an artifact and inputs, `replayArtifact`
resolves every locator via the same `resolveLocator` (primary strategy,
then each fallback in order, first one that matches wins) that discovery
uses, verifies a `checkpoint` after each step, and classifies the outcome
into exactly one of four buckets:

1. **Success** — every step's checkpoint held and the artifact's
   `successCheckpoint` holds at the end. Declared outputs are returned,
   coerced to their declared type.
2. **Business outcome** — a step's action or checkpoint failed, but the
   *current page state* matches one of the artifact's `knownOutcomes`
   (checked via the same checkpoint mechanism, e.g. "page contains 'No
   members found matching'"). Returned as structured data (`code`,
   `message`), not an exception. This is the "no such member is a legitimate
   answer" principle from the brief, applied literally: not-found,
   permission-denied, and validation-error are all `knownOutcomes` on
   `bankops.open_sub_account`, authored by hand (see below) rather than
   discovered by the LLM.
3. **Recoverable** — handled at two levels. First, generically: every step
   gets one retry after a short wait, which absorbs transient slowness
   without any outcome-specific configuration. Second, specifically:
   `core/interstitials.ts` defines known interstitials (right now, the
   mock app's session-liveness check) that both the replay engine and the
   discovery loop check for *before* every step/observation and dismiss
   automatically. This one exists because I hit it as a real bug: the
   interstitial re-renders at the *same URL*, so a `urlContains` checkpoint
   on the surrounding step would report false success while the page was
   actually stuck on the interstitial. Handling it at the engine level
   (rather than baking a "click Continue" step into every capability that
   happens to pass through `/members/:id`) also means it doesn't cost a
   recorded step or an LLM call during discovery — it's infrastructure, not
   business flow.
4. **Hard failure** — nothing above matched. Returned as `{step, expected,
   observed, message}`: which step, what we expected (its description /
   checkpoint), and what we actually saw (a fresh page summary). Enough to
   debug without re-running with a debugger attached.

**Why the known-outcome taxonomy is hand-authored, not LLM-discovered:** the
assignment requires one genuine discovery run at minimum; I did two (the
golden path, and the escalation path — both real Gemini-driven runs, logged
in `evidence/`). Discovering *every* failure mode would require deliberately
steering the agent into each one, which is possible but is really a
different exercise from "discover the happy path, then harden it." In
practice this is also how I'd expect it to work at a company like
interface.ai: a recorded flow is a draft; a human reviewer adds the known
failure modes they understand about the underlying app before flipping
`approvalStatus` to `approved`. The schema and the `draft`/`approved` gate
exist specifically to make that workflow explicit rather than implicit.

**Locator robustness in one sentence:** prefer the strategy the browser's
own accessibility computation would agree with (`role`), fall back to
visible text, fall back to structural table-row targeting for legacy forms,
fall back to a positional CSS path last. Every resolution records *which*
strategy actually worked, which is a confidence signal for free — a step
that only succeeds via its last fallback is a candidate for re-recording
before the next tenant's traffic hits it.

## 4. Heterogeneity & multi-tenant

**The seam is `core/perception.ts` + `core/actions.ts` on one side, and the
artifact's `Locator` union on the other.** Perception's job is "produce a
list of {role, name, kind} facts about the current UI state, however you
have to get them." Actions' job is "given a `Locator`, act on the matching
control." Nothing above that seam — the discovery loop, the replay engine,
the artifact schema — knows or cares whether those facts came from a
browser DOM walk, a native accessibility API, or an OS-level UI Automation
tree.

- **Legacy web** is what's actually implemented here (no test ids, table
  layout, no `<label for>`) — the `label`/`cell` locator strategies exist
  specifically for this case.
- **Desktop**: the same shape extends directly. Windows UI Automation and
  macOS Accessibility both expose role + name + value for native controls,
  which is exactly the `PerceivedElement` shape. A `WinLocator` variant
  (automation id, or role+name within a window) would join the existing
  discriminated union; `resolveLocator` would dispatch to a UIA/AX backend
  instead of Playwright. The artifact schema, the replay engine, the
  guardrail model, and the escalation mechanism would all be unchanged —
  only the perception/action backend and the locator variant are new. I did
  not build this (out of scope per the brief), but the reason I'm confident
  the abstraction holds is that I already had to solve the "the accessible
  name isn't reliable, target structurally instead" problem once, for
  legacy web — that's the same category of problem a desktop app with
  poorly-labeled controls presents.

- **Multi-tenant reuse**: hundreds of tenants running the same vendor
  product, differently configured/branded/versioned, is the harder half of
  this question, and the honest answer is that today's schema handles
  *parameterization* (the same artifact working across data, e.g. member
  ids) but not yet *tenant variation* (the same artifact working across UI
  differences between tenants). The direction I'd take it, without
  building infrastructure prematurely (per the brief's explicit guidance
  not to reward that): give an artifact a base identity
  (`vendorApp: "core-banking-x"`, `flow: "open_sub_account"`) separate from
  its `id`, and let a tenant have a thin **override layer** — a small patch
  applied to specific steps' locators/URLs (e.g. tenant A's build routes
  through `/accounts/open` where the base app uses `/members/:id/open-
  account`, or a rebrand changes visible button text so the `role` locator
  needs a tenant-specific `name` override while every other step is
  untouched). Replay would resolve a step's locator as "tenant override, if
  present, else base." This keeps the common case — one recording, N
  tenants — cheap, and confines tenant-specific knowledge to a diff instead
  of a fork.
- **Drift detection**: the same "which locator strategy actually resolved"
  confidence signal from §3 is the detector. If a tenant's build has
  drifted (a version bump changed a label), the primary locator starts
  failing and a fallback catches it — that's a signal to flag the artifact
  for re-review, not silently keep degrading forever. A `stability` score
  per artifact (replay N times, track which strategy resolved each step) is
  exactly the "multi-run stability" stretch goal, and is the natural home
  for this signal; I did not build it this round (see §7).

## 5. Escalation & handoff

**Detecting "stuck":** two triggers, one automatic and one policy-driven.
The agent itself can call `request_human` when it doesn't know how to
proceed (a real "I'm stuck" signal from the model). Separately, and more
importantly for safety, the *guardrail layer* intercepts any click on a
control whose accessible name matches a risky pattern (`"approve as
manager"`, `"delete"`, `"close account"`, ...) **before** it happens,
regardless of whether the model wanted to click it — the agent doesn't get
to decide its own risk tolerance for irreversible actions. Both paths call
the same escalation mechanism. Replay has the identical seam: a capability
can contain a recorded `escalate` step (not a fallback-on-failure — a
first-class step type), so a capability that's inherently gated on a human
decision (`bankops.open_sub_account_large_deposit`, deposit over the
self-service limit) escalates on *every* replay, by design, not just when
something goes wrong.

**Taking control of the live session, not a fresh one:** this is the part
of the brief I spent the most design effort on, because it's easy to fake.
`core/session.ts` launches the browser via `chromium.launchServer()` (a
real OS-level browser process) and persists its WebSocket endpoint to disk.
The automation process holds a connected client to it; when it escalates,
it writes an `InterventionRequest` (goal, current step, current URL, a
screenshot, the reason) to a small file-backed queue
(`core/escalation.ts`) and blocks, polling for resolution — **the browser
stays open, the page stays exactly where it was.** A *separate* process —
the `operator` CLI, run from a different terminal — reads the same queue,
connects to the *same* WebSocket endpoint, and gets a handle to the *same*
live page. In the demo scenario, it then performs the actual manual step
(clicking "Approve as Manager") against that live page, standing in for a
human physically doing it, and writes the resolution back. The discovery/
replay process wakes up from its poll, sees `resolved`, and continues from
exactly where it left off — no re-navigation, no state reconstruction.
I mocked the *operator UI* (a CLI, not a co-browsing console — explicitly
allowed by the brief's scope note) but not the *control-transfer
mechanism*: the cross-process CDP handoff onto one shared browser session
is real and is exactly what a real operator console would sit on top of
(swap the CLI for a screen-share/co-browse UI backed by the same
WebSocket endpoint, and it's the same mechanism plus a UI).

**Resuming:** `resolveIntervention` records who acted, what they did, and
whether the outcome was "resumed" or "aborted." On resume, the automation
doesn't re-observe from scratch and re-decide — for replay, it simply moves
to the next recorded step, trusting that the operator did what the
escalate step said was needed (and that step's or the next step's
checkpoint will catch it if they didn't). For discovery, the agent loop
does re-observe (since an LLM is still in the loop and can adapt), but the
important property — same page, same session, no state lost — holds either
way.

**Limits:** the "who is in control" bookkeeping is a status file, not an
enforced lock — nothing currently stops the automation from also touching
the page mid-escalation (it happens not to, because it's blocked on
`waitForResolution`, but that's cooperative, not enforced). A production
version would need an explicit mutex/lease on the session, and a real
timeout/abandonment policy for interventions nobody picks up.

## 6. Safety

**Allowlist enforcement** (`core/guardrails.ts`): every navigation is
checked against `allowedDomains` and `allowedRoutePatterns` *before* it
happens, for both discovery and replay — not just "the agent was told not
to," but a hard `PolicyViolationError` thrown from the same code path both
execution modes share, so there's one enforcement point, not two to keep in
sync.

**Risky vs. safe actions:** classified two ways. Structurally, an artifact
step carries a `riskLevel`; a capability containing any risky step is
itself `riskLevel: "risky"`, and the replay engine runs risky capabilities
headful rather than headless — a real person needs to be *able* to see the
session the moment it needs them, not just be notifiable after the fact.
Behaviorally, `riskyControlPatterns` intercept a specific control
regardless of what step it's part of — this is the layer that stops the
agent from clicking "Approve as Manager" even if it decided, on its own
reasoning, that this seemed like a reasonable thing to do. I chose to
**block-and-escalate** rather than "require confirmation inline," because
inline confirmation still trusts the same agent that just tried the risky
action to correctly ask for permission; routing to a human who takes over
the actual session removes the agent from that decision entirely.

**Data handling:** `redactText`/`redactValue` mask SSN-shaped strings,
card-number-shaped strings, long token-shaped strings, and anything under a
key that looks sensitive (`password`, `token`, `ssn`, ...), applied to
every structured log line before it's written (`RunLogger` redacts on
write, not as an afterthought) and available for artifact fields flagged
`sensitive: true`. The mock app never handles real credentials or PII by
construction (synthetic member data only), so this is exercised on
synthetic-but-realistic shapes (I did not, e.g., pipe a real SSN through it
to prove it works — that would mean creating one to redact, which defeats
the point).

**Approval gate:** `approvalStatus: "draft" | "approved"` — unattended
replay of a draft artifact is refused unless the caller explicitly passes
`--force`. This is the one-sentence version of "someone should look at what
was recorded before an AI agent invokes it against production data
unattended," made structural rather than a policy document.

**Where this model runs out:** guardrails today are pattern-based
(regexes on route/control names). That's legible and fast to review, but a
control renamed to dodge the pattern, or a genuinely risky action with an
innocuous label, would slip through. A more robust version would classify
risk from the *action's effect* (does it call a POST route with side
effects?) rather than its label — I noted this as a next step rather than
building it, since it needs real usage data to calibrate against
false-positive rates.

## 7. Cuts

**What I cut, and why:**

- **Real co-browsing operator console.** Explicitly out of scope per the
  brief. Built the CLI + shared-session mechanism instead (§5) — the part
  that's actually hard (real control transfer over one live session) is
  real; the part that's UI polish is not.
- **Desktop surface.** Not implemented, not required. Argued the
  abstraction seam in §4 rather than build a stub that would just be a
  restatement of "this would be a different perception backend."
- **Multi-tenant override mechanism.** Designed (§4) but not built — the
  brief explicitly says not to build scaling infrastructure prematurely,
  and a tenant-override layer with no second tenant to test it against
  would be exactly that.
- **LLM-discovered failure taxonomy.** `knownOutcomes` are hand-authored
  engineering knowledge on top of two real discovery runs, not mined from
  N discovery runs across every failure path. Explained the reasoning in
  §3; the two real runs I did do (golden path + escalation path) are both
  genuine, evidenced Gemini-driven sessions, not the same run twice.
- **Confidence scoring / multi-run stability** (stretch goal). Designed
  as the natural extension of the "which locator strategy resolved"
  signal already recorded per step (§4), not implemented as a scored
  artifact field.
- **Assisted fallback / bounded LLM recovery on replay failure** (stretch
  goal). Deliberately skipped in favor of the escalation path: routing a
  replay failure to a human is a more conservative choice than letting an
  un-sandboxed LLM improvise a recovery step against a live financial
  session, and the brief asks for depth over breadth on stretch goals.
- **Enforced session lock during escalation.** Noted as a real gap in §5
  rather than papered over.

**What I'd build next, in order:** (1) a real risk classifier informed by
route side-effects rather than label regexes, (2) the multi-tenant override
layer once a second real tenant surface exists to design it against, (3)
per-artifact stability scoring from repeated replay, feeding the
`draft`→`approved` decision instead of that decision being purely manual.
