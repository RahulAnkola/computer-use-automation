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

## Escalation demo

See the root `README.md` §3 for how to reproduce the human-in-the-loop
escalation and handoff live (it requires a second terminal acting as the
operator, so it isn't a single static log to check in the same way).
