# Computer-Use Automation System

An LLM-driven agent that discovers how to complete a task inside a legacy,
no-API back-office web app, records what it learned as a typed, replayable
**capability artifact**, and replays that artifact deterministically
afterwards — no model in the loop, with a real error taxonomy and a
human-escalation path for the cases it can't (or shouldn't) resolve itself.

Built for interface.ai's take-home assignment. See `REPORT.md` for the design
write-up (architecture, artifact schema, determinism/error handling,
heterogeneity & multi-tenant story, escalation, safety, and cuts).

## What's here

- **`src/mock-app/`** — "BankOps Console", a small server-rendered mock
  credit-union back-office app (member lookup, sub-account opening flow).
  Deliberately legacy: nested tables, no test ids, no `<label for>`
  associations, inline styles. This stands in for the real thing (see
  ground rules — no real bank system, no real PII).
- **`src/core/`** — perception (DOM → structured elements), locator
  resolution, the artifact schema (Zod), guardrails/redaction, the
  escalation queue, the shared-browser-session mechanism, checkpoints,
  known-interstitial handling, and templating (parameterizing recorded
  steps).
- **`src/agent/`** — the LLM-driven discovery loop (Gemini function
  calling) that produces a capability artifact from a live run.
- **`src/replay/`** — the deterministic replay engine (no LLM).
- **`src/capabilities/`** — hand-authored capability contracts (typed
  params/outputs, known-outcome taxonomy) layered on top of discovered flows.
- **`src/cli/`** — `discover`, `replay`, `operator` (human-in-the-loop),
  `catalog` (agent-facing capability listing/invocation).
- **`artifacts/`** — saved capability artifacts (JSON).
- **`evidence/`** — logs, screenshots, and artifacts from real runs.
- **`tests/`** — unit/integration tests for the parts that don't need an LLM
  (guardrails, templating, artifact schema, locator resolution, the full
  replay engine against a real headless browser).

## Setup

Requirements: Node.js 20+, and a Gemini API key (this project uses Gemini,
not Anthropic — see `REPORT.md` §1 for why; it's an explicit "your call" per
the assignment).

```bash
npm install
npx playwright install chromium   # one-time browser download
cp .env.example .env              # then fill in GEMINI_API_KEY
```

`.env`:

```
GEMINI_API_KEY=your-key-here
GEMINI_MODEL=gemini-flash-lite-latest
```

Get a free key at https://aistudio.google.com/apikey. **Note:** free-tier
Gemini quotas are tight and are enforced *per model, per day* (not just
per-minute) — `gemini-2.5-flash`'s free quota is 20 requests/day, which a
single discovery run can exhaust on its own. `gemini-flash-lite-latest` has
a separate, more generous quota and is the default here for that reason.
The discovery agent also throttles itself to roughly one call per 13s and
retries on 429s with backoff (you'll see `[llm] Rate limited ... waiting
Ns` in the output), so a discovery run still takes a few minutes even when
quota isn't an issue. None of this affects replay: replay never calls the
LLM.

Run the test suite (no API key needed — these never call an LLM):

```bash
npm run typecheck
npm test
```

## Demo path

Everything below spins up its own copy of the mock app on `localhost:4173`
by default (pass `--no-start-server` if you'd rather run `npm run mock-app`
yourself in another terminal first).

### 1. Discover a capability (real LLM run against a live browser)

```bash
npm run discover -- --capability bankops.open_sub_account \
  --member 10023 --account-type Sub-Savings --amount 500
```

This drives a real Chromium session with Gemini deciding each step, saves
the resulting artifact to `artifacts/bankops.open_sub_account.json`, and
writes a full step-by-step log + screenshots to `evidence/discover-.../`.

### 2. Replay it deterministically (no LLM)

```bash
npm run replay -- --artifact artifacts/bankops.open_sub_account.json \
  --member 10023 --account-type Sub-Savings --amount 500 --force
```

(`--force` bypasses the draft/approval gate — see REPORT.md §6. In a real
deployment a human would review and flip `approvalStatus` to `"approved"`
instead of using `--force` every time.)

Try it with a member that doesn't exist, to see a **business outcome**
(not a crash):

```bash
npm run replay -- --artifact artifacts/bankops.open_sub_account.json \
  --member 99999 --account-type Sub-Savings --amount 500 --force
```

Or an invalid deposit amount, to see the validation-error business outcome:

```bash
npm run replay -- --artifact artifacts/bankops.open_sub_account.json \
  --member 10023 --account-type Sub-Savings --amount -50 --force
```

### 3. Escalation & handoff demo

The `bankops.open_sub_account_large_deposit` capability opens a sub-account
with a deposit over the $10,000 self-service limit, which the mock app
gates behind a manager-only "Approve as Manager" control. The agent's
guardrails forbid it from clicking that control itself — it must escalate.

Discover it (the agent will pause and wait for a human operator):

```bash
npm run discover -- --capability bankops.open_sub_account_large_deposit \
  --member 10045 --account-type Sub-Savings --amount 15000
```

In a **second terminal**, see the pending intervention and act on it as the
human operator — attaching to the *same live browser session* over CDP
(not a fresh one) and performing the manual approval:

```bash
npm run operator -- list
npm run operator -- approve <intervention-id> --note "Reviewed and approved manager override"
```

The discovery run resumes automatically once resolved, finishes the goal,
and saves the artifact. Replaying that artifact later will hit the same
`escalate` step and pause the same way — this is a designed-in property of
the capability, not just a one-off agent hiccup (see REPORT.md §5).

### 4. Capability catalog (agent-facing interface, stretch goal)

```bash
npm run catalog -- list
npm run catalog -- invoke bankops.open_sub_account --memberId 10023 --accountType Sub-Savings --depositAmount 500 --force
```

Lists saved artifacts with their typed input/output contracts and known
outcomes — a stand-in for how an AI agent's tool-use layer would discover
and call these capabilities by name.

## Running without live services

The whole system is self-contained: `npm run mock-app` runs the target app
standalone, and every CLI script launches its own copy by default. There is
no external dependency besides the Gemini API for discovery specifically —
replay, the catalog, and the test suite need no network access at all
(the mock app is `localhost`-only, no real bank system is used or contacted).

## Evidence

`evidence/` contains real runs already: two discovery runs (the golden
path, and the escalation/manager-approval path — each with the full
decide/act log and screenshots) and five replays covering success, all
three business-outcome categories, and the escalation handoff. See
`evidence/README.md` for the full index.
