# understudy

**Record-once, replay-many computer use for legacy back-office apps.**

An LLM figures out how to complete a task inside a real UI that has no API. The successful run is recorded as a typed, versioned **capability**. That capability then replays **deterministically, with no model in the loop** (reliably and cheaply) and hands off to a human when it can't safely proceed.

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the AI agent invokes it in production.

The name is the idea: the LLM is the lead actor who learns the role once; the recorded capability is the **understudy** that performs it every night after, no star required.

📄 **Design write-up:** [REPORT.md](REPORT.md) · 🧾 **Evidence:** [evidence/EVIDENCE.md](evidence/EVIDENCE.md) · 🎯 **Example artifact:** [capabilities/lookup-member-savings-balance.json](capabilities/lookup-member-savings-balance.json)

---

## What it does (the vertical slice)

```
 goal + inputs ─▶ LLM discovery loop ─▶ capability.json ─▶ deterministic replay ─▶ result
 (natural lang)   (observe→decide→act)   (typed contract)   (no model)             │
                                                                                    ├─ success (typed outputs)
                        human takeover on the SAME live session ◀── needs_intervention
                                                                                    ├─ business_outcome (e.g. "no such member")
                                                                                    └─ failure (debuggable)
```

The target surface is a **mock legacy credit-union servicing console** (`mock-app/`): server-rendered, table-based layout, **randomized element ids, no test-ids** (the "no clean DOM" reality) with injectable runtime faults (not-found, validation, permission-denied, session-timeout, interstitial dialog, slow load, app error) so replay error-handling is exercised for real.

---

## Quickstart

**Prerequisites:** Node ≥ 20.

```bash
npm install
npx playwright install chromium
```

**Configure** (only discovery needs a key; replay never calls a model):

```bash
cp .env.example .env
# set GEMINI_API_KEY=AQ...   (Vertex AI Express Mode key)
```

**Guided tour:** one command that starts the mock and walks the whole loop (discover → artifact → replay → business outcome → real bank) with a pause before each step:

```bash
npm run demo
```

Or run the steps yourself. In terminal 1, start the mock target app:

```bash
npm run mock                 # MeridianCU servicing console on http://localhost:3100
```

In terminal 2:

```bash
# 1) DISCOVER: one real LLM-driven run; records a capability + evidence
npm run discover -- savings-balance

# 2) REPLAY: deterministic, no model in the loop
npm run replay -- lookup-member-savings-balance --input memberNumber=100123
#   → status: SUCCESS   outputs: {"savingsBalance":482355}

# 3) REPLAY an exceptional state: a legitimate business outcome, not a crash
npm run replay -- lookup-member-savings-balance --input memberNumber=999999
#   → status: BUSINESS_OUTCOME   MEMBER_NOT_FOUND
```

> Add `--headless` to any command (or set `HEADLESS=1`) to run browsers headless. Discovery/replay are **headed by default** so you can watch, and so a human can take over the live window during a handoff.

### Running without the model / without live services

- **Replay, tests, the mock app, and the catalog need no API key.** Only `discover` does.
- The only "live service" is the local mock app. There are no external dependencies.
- `npm test` runs the full suite (50 tests) with zero keys and zero network.

---

## The other core requirements, as commands

```bash
# Recoverable condition: an interstitial dialog is dismissed, run continues
npm run replay -- lookup-member-savings-balance --input memberNumber=100123 --fault '{"interstitial":true}'

# Hard failure: an application error is detected and surfaced (not blindly retried)
npm run replay -- lookup-member-savings-balance --input memberNumber=100123 --fault '{"appError":true}'

# HUMAN-IN-THE-LOOP: session expires → escalation → you take over the SAME browser window
npm run replay -- lookup-member-savings-balance --input memberNumber=100123 --fault '{"expireSessions":true}' --operator
#   then open the operator console printed in the log (http://localhost:4600),
#   re-authenticate in the live browser window, and click "Resume automation".

# A create flow with an irreversible step (gated on approval)
npm run discover -- open-subaccount
npm run approve  -- open-member-subaccount              # governance sign-off
npm run replay   -- open-member-subaccount --input memberNumber=100123 --input accountType=Checking --input initialDeposit=25.00 --allow-risky

# UI DRIFT: a recorded control is renamed + a decoy added, breaking every locator rung.
#   without self-heal → fails loudly (AMBIGUOUS_TARGET), where brittle replays die:
npm run replay -- open-member-subaccount --input memberNumber=100123 --input accountType=Checking --input initialDeposit=25.00 --allow-risky --fault '{"renameControls":true}'
#   with self-heal → one bounded, re-verified model call recovers it + writes a proposed patch:
npm run replay -- open-member-subaccount --input memberNumber=100123 --input accountType=Checking --input initialDeposit=25.00 --allow-risky --fault '{"renameControls":true}' --self-heal
```

> Every recorded capability is **self-verified**: right after discovery it is replayed model-free and only stamped `verifiedByReplay` if it reproduces. Replay also emits **drift telemetry**: it reports which locator rung actually resolved and warns when that's weaker than the recorded primary.

### Proof on a real, live, third-party bank (ParaBank)

The mock is a faithful legacy proxy, but the system is also proven end-to-end against a **real public banking app** we don't control: [ParaBank](https://parabank.parasoft.com) (server-rendered, table-based, no test-ids). Credentials are injected securely (the model never sees them). One command:

```bash
npm run discover -- parabank-balance     # real LLM run against the live bank
npm run replay   -- parabank-account-balance --no-preauth --base-url https://parabank.parasoft.com \
  --allow-route '/parabank/**' \
  --input username=john --input password=demo --input accountId=40650
#   → status: SUCCESS   outputs: {"accountBalance": <live balance in cents>}
```

The account is read by **input-bound targeting** (`{{accountId}}` bound to the caller's value), the shape of a real back-office lookup. ParaBank is a shared demo that periodically resets, so `john`'s account numbers drift (set `accountId` to a current one before recording); the *two-accounts-by-input* proof of input-binding is therefore shown deterministically on the mock (member `100123`→$4,823.55 vs `100789`→$9,031.12), which we control. ParaBank's instance also keeps `john` logged in regardless of credentials, so the auth-failure business-outcome is likewise demonstrated on the mock, where it's deterministic.

### Agent-facing capability catalog (stretch)

Saved capabilities are callable tools an AI agent can discover and invoke by name with typed args:

```bash
npm run catalog                      # list capabilities with their input JSON-Schema + outputs
npm run serve                        # agent-facing API on http://localhost:4700
#   GET  /capabilities
#   POST /capabilities/lookup-member-savings-balance/invoke   {"inputs":{"memberNumber":"100123"}}

npm run invoke -- lookup-member-savings-balance --input memberNumber=100123   # prints the JSON a calling agent receives
```

### Regenerate the whole evidence set (deterministic; needs both mock tenants)

```bash
# terminal 1: npm run mock                          (meridian :3100)
# terminal 2: PORT=3101 TENANT=cascade npm run mock (cascade :3101, 2nd tenant, same vendor product)
npm run discover -- savings-balance
npm run discover -- open-subaccount
npm run evidence            # approvals + 12-scenario replay matrix + cross-tenant reuse → evidence/EVIDENCE.md
```

---

## What's in the box

| Area | Where | Highlight |
|---|---|---|
| **Capability schema** | `src/types/capability.ts` | Typed I/O contract, multi-strategy locator ladders, declared conditions, tenant overrides, provenance, approval |
| **Discovery agent** | `src/agent/` | Gemini (Vertex) tool-use loop; model acts by `ref`, understudy synthesizes durable locators |
| **Replay engine** | `src/replay/replay.ts` | No model; unique-match ladder resolution, checkpoints, error taxonomy, recovery, escalation |
| **Surface seam** | `src/types/surface.ts`, `src/surface/` | Accessibility-tree perception; the one seam that extends to legacy/desktop |
| **Safety** | `src/safety/` | Allowlist (∩ capability scope), risk classification, redaction |
| **Human-in-the-loop** | `src/hitl/` | Pause-gate + control token + operator console + live-action capture, same session |
| **Catalog** | `src/catalog/` | Agent-facing list/invoke + JSON-Schema |
| **Targets** | `mock-app/` + ParaBank | Legacy CU console (2 tenants, injectable faults) **and** a real live public bank |

**Frames & shadow DOM:** perception traverses iframes/framesets and pierces open shadow roots; replay resolves a target across frames (durable frame hint, never an index), so it can drive a screen embedded in a frameset, the real legacy-bank reality. Proven in `tests/frames.browser.test.ts`.

**Locator ladder** (per target, most-stable first): `role+name → label → placeholder → text → relative(table-row anchor) → proximity(nearest card/section label) → href(for icon links) → test-id → css`. A rung wins only on a **unique** match, and replay logs which rung won, so drift is observable. Targets and anchors can also be **input-bound** (`fromInput`): "the row for account `{accountId}`", the locator analogue of value parameterization. Proven in `tests/locator.browser.test.ts` (role+name survives every id changing) and `tests/bind.test.ts`.

**Error taxonomy:** the four result statuses map 1:1 onto dispositions (see [REPORT.md §3](REPORT.md)):

| status | meaning |
|---|---|
| `success` | goal met, typed outputs returned |
| `business_outcome` | a legitimate result the caller must handle (e.g. `MEMBER_NOT_FOUND`), **not a crash** |
| `needs_intervention` | handed off to a human |
| `failure` | hard failure, with step/expected/observed |

---

## Tests

```bash
npm test          # 50 tests: schema integrity, iframe + shadow-DOM, recorder, locator drift +
                  # exact-anchor + visibility (browser), input-bound targeting, conditions, policy
                  # intersection, redaction, tenant overrides, and an in-process integration replay matrix.
npm run typecheck
```

## Notes

- **Secrets** stay in `.env` (gitignored). Redaction scrubs logs and artifacts by pattern and by declaration; the discovery transcript is redacted before it touches disk.
- **Credentials in the mock** are `operator` / `demo-pass`, mock only, never real.
- **Provider** is Gemini via Vertex AI Express Mode, isolated in `src/llm/gemini.ts`; swap providers by reimplementing that one file.
