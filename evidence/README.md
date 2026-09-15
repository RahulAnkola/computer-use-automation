# Evidence index

All runs below are real: a live Gemini-driven discovery run against a live
Chromium session, and real deterministic replays of the artifact it
produced (no LLM involved in any replay). Regenerate any of them with the
commands in the root `README.md`.

## Discovery run (real LLM, live browser)

**`discover-bankops_open_sub_account-1789448974006/`** — goal: "Look up
member 10023 ... open a new Sub-Savings sub-account with an initial
deposit of $500 ... report the new sub-account id and confirmed balance."

- `log.jsonl` — every observation, decision, and action the agent took,
  in order, with reasoning-relevant context (tool called, args, resulting
  page).
- `step-00.png` … `step-09.png` — a screenshot at each step.
- `artifact.json` — the capability artifact produced (also saved to
  `artifacts/bankops.open_sub_account.json`).

Model: `gemini-flash-lite-latest`. 10 real LLM decisions, ending in a
`finish(success=true)` call once the agent could see the confirmation
screen with the new sub-account id.

## Replay runs (deterministic, no LLM)

All four use the artifact discovered above, invoked with different inputs.

| Directory | Inputs | Result |
|---|---|---|
| `replay-bankops_open_sub_account-1789449227615/` | member `10023`, `$500` | `success`, outputs `{subAccountId: "SUB-501", confirmedBalance: "$500.00"}` |
| `replay-bankops_open_sub_account-1789449244973/` | member `99999` (doesn't exist) | `business_outcome` `MEMBER_NOT_FOUND` — not a crash |
| `replay-bankops_open_sub_account-1789449270611/` | member `10023`, `-$50` | `business_outcome` `VALIDATION_ERROR` |
| `replay-bankops_open_sub_account-1789449356896/` | member `90011` (restricted) | `business_outcome` `PERMISSION_DENIED` |

Each directory has `log.jsonl` (step-by-step action log), `result.json`
(the final structured result), `inputs.json`, and `final.png` (last-page
screenshot).

See `tests/replay.test.ts` for a fifth category exercised under test rather
than as standalone evidence: a genuine **hard failure** (an undeclared
dead-end the known-outcome taxonomy doesn't cover), to show the
error/business-outcome/hard-failure split holds in both directions.

## Escalation & handoff demo (real, captured)

The `bankops.open_sub_account_large_deposit` capability opens a sub-account
with a deposit over the $10,000 self-service limit, which the mock app
gates behind a manager-only "Approve as Manager" control. Both runs below
are real: the discovery agent (and, separately, the replay engine) actually
paused, and a second process (`npm run operator`) actually attached to the
same live Chromium session over CDP and clicked the approval control.

- **`discover-bankops_open_sub_account_large_deposit-1789449655195/`** —
  live Gemini-driven discovery for member `10045`, deposit `$15000`. The
  agent recognized the manager-approval requirement, called `request_human`
  rather than clicking it, and `log.jsonl` shows `escalation_raised` →
  (operator CLI approves in a separate process) → `escalation_resolved` →
  the agent resuming, extracting outputs, and finishing successfully. The
  resulting artifact (`artifacts/bankops.open_sub_account_large_deposit.json`)
  contains the pause point as a first-class `escalate` step (`step-6`) and
  is marked `riskLevel: "risky"`.
- **`replay-bankops_open_sub_account_large_deposit-1789449816262/`** — a
  *deterministic replay* of that same artifact (no LLM). It hits the exact
  same `escalate` step and pauses identically, proving escalation is a
  designed-in property of the capability, not just something the live
  agent happened to do once. Resolved via the same `operator` CLI, then
  resumed and completed with outputs `{subAccountId: "SUB-501",
  confirmedBalance: "$15000.00"}`.

Reproduce it yourself with the exact commands in the root `README.md` §3.
