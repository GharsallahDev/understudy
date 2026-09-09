# understudy: design write-up

> The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the AI agent invokes it in production.

The name is the thesis. The LLM is the lead actor who learns the role once; the recorded capability is the understudy that performs it reliably every night after, with no star in the loop.

---

## 1. Architecture

Three phases, one clean seam.

```
                        ┌──────── DISCOVERY (LLM, once) ────────┐
 goal + inputs ──▶ agent loop ──▶ observe→decide→act ──▶ recorder ──▶  capability.json
                        └───────────────────────────────────────┘        (typed, versioned)
                                                                                │
                        ┌──────── REPLAY (no model, many) ──────┐              │
 inputs ─────────▶ replay engine ◀── locator ladders + checkpoints + conditions ◀┘
                        └──▶ result: success | business_outcome | needs_intervention | failure
```

The seam that matters is `Surface` (`src/types/surface.ts`). Everything above it (the agent loop, the recorder, the replay engine, the error taxonomy, safety) speaks only in accessibility terms: roles, names, text. Only `WebSurface` (Playwright) knows about the DOM. That's deliberate: a `DesktopSurface` over Windows UIAutomation or macOS AX would expose the same `ObservedElement[]`, and nothing above the seam would change (see §4).

Key decisions and trade-offs:

- **TypeScript + Zod.** One schema definition gives a runtime validator, static types, and the JSON-Schema the agent-facing catalog exposes. A malformed recording fails at record time, not replay time.
- **Accessibility tree, not screenshots + coordinates.** The brief twice asks for an approach that works with no clean DOM. Role+name is stable across restyles, survives non-semantic legacy markup, and is the one surface that also exists on desktop. Pixel/coordinate control (the screenshot-and-click paradigm general computer-use agents use) is powerful but brittle and expensive for a replayable artifact. Screenshots are kept as evidence, not as the control channel.
- **The model never writes selectors.** During discovery it points at elements by an ephemeral `ref`; understudy synthesizes the durable locator ladder from that element's accessibility properties. Discovery stays reliable and the artifact stays model-independent. (Closest prior art is Stagehand's observe→cache→act; this goes further by decoupling the artifact from the transcript entirely.)
- **Single process, JSON files on disk.** No queues, database, or services. The brief penalizes premature scaling infrastructure, so the abstractions are built to scale (§4) but the plumbing isn't.
- **Gemini via Vertex AI (Express Mode)** for discovery, isolated behind `src/llm/gemini.ts` (about 60 lines). Swapping providers touches that one file.

---

## 2. Artifact schema

`src/types/capability.ts` is the load-bearing contract: a callable capability, not a step log.

```
Capability
├─ schemaVersion / id / version                versioned + reviewable
├─ target { appId, surface, vendorProduct, tenantId, entryRoute, baseUrlEnv }
├─ scope { allowedRoutes[], allowedActions[] } per-capability allowlist (∩ global policy)
├─ inputs:  ParamSpec[]     typed, patterned, `sensitive` flag  → JSON-Schema for agents
├─ outputs: OutputSpec[]    typed + extraction { locator, attribute, transform, pattern }
├─ steps:   Step[]          action, target(LocatorSpec), value(input|literal), checkpoint,
│                           risk(safe|risky), expectedConditions[]
├─ successCondition:        the final checkpoint
├─ globalConditions:        runtime conditions that can occur on ANY screen
├─ canonicalization:        /members/12345 → /members/:memberNumber
├─ tenantOverrides:         declared per-tenant deltas (labels, extra/skipped steps)
├─ provenance:              { model, discoveredAt, sourceRunId, transcriptDigest }
└─ approval:                { state: draft|approved, stability{ score } }
```

Why it's shaped this way:

- **Typed I/O is first-class.** A caller, human or agent, can see what a capability needs and returns without reading the steps. Inputs export directly as JSON-Schema for function-calling.
- **Robustness lives in the data, not in prose.** Each target is a `LocatorSpec`: an ordered ladder of strategies (role → label → placeholder → text → relative → css), most-stable first, each with a stability weight and free-form notes for reviewers.
- **Decoupled from the transcript.** `provenance` links the run by id and SHA-256 digest; replay never needs the transcript.
- **Extraction is parameter-independent by construction.** Output locators that mention an input value are stabilized at record time (input-specific names stripped, status banners reduced to role-only) and the value is pulled from the region text with a regex `pattern`. So "read the Regular Savings balance" anchors on the stable label "Regular Savings", never on `$4,823.55` or the member number.

---

## 3. Determinism & error handling

Determinism (`src/replay/replay.ts`, `src/surface/locator.ts`) rests on four legs:

1. **Unique-match ladder resolution.** Replay walks the ladder most-stable-first, and a rung wins only if it resolves to exactly one visible element. An ambiguous match (more than one) is treated as a miss and we fall through; acting on the wrong one of several is worse than failing loudly. We log which rung won (`resolve s1 via role[0]`), so drift is observable: if a step that used to resolve on `role` starts resolving on `css`, the semantic layer has shifted.
2. **Checkpoints, not optimism.** Every state-changing step asserts a post-condition (URL substring, role, or text present/absent). We never assume a click worked.
3. **Explicit condition handling** instead of blind proceeding (below).
4. **Waiting on conditions, not fixed sleeps** for correctness (a short bounded retry loop absorbs transient render).

The error taxonomy is the centrepiece (`src/types/conditions.ts`). The brief flags conflating a business outcome with a failure as the number-one mistake, so a condition has two independent axes: what happened (`ConditionCode`) and how to treat it (`Disposition`). The same code can carry different dispositions in different capabilities, so disposition is declared in the artifact rather than hard-wired. The replay result maps one-to-one onto the dispositions:

| Result status | Meaning | Example (proven in `/evidence`) |
|---|---|---|
| `success` | goal met, typed outputs returned | `{ savingsBalance: 482355 }` |
| `business_outcome` | a legitimate result the caller must handle, not a crash | `MEMBER_NOT_FOUND`, `PERMISSION_DENIED`, `VALIDATION_FAILED` |
| `needs_intervention` | stopped and handed off to a human | session timeout → reauth |
| `failure` | hard failure with step/expected/observed to debug | `APP_ERROR @ s2` |

Recoverable conditions are handled in-band and phase-aware: an interstitial dialog detected before a step means dismiss and retry the step; the same dialog popping over a completed step means dismiss and continue. Recovery attempts are capped per condition. All nine rows of the evidence matrix are real replays with no model in the loop.

Three further guarantees harden this in practice:

- **Self-verify on record.** A capability is only trustworthy if it can reproduce its own discovery, so immediately after recording we replay it model-free and stamp `provenance.verifiedByReplay`. The model claiming success isn't enough.
- **Drift telemetry.** Replay reports which ladder rung resolved each target; resolving on a weaker rung than the recorded primary emits a note and a warning, so drift becomes visible before it becomes an outage.
- **Bounded self-healing** (opt-in). When every rung genuinely fails (proven case: a control is renamed and an added decoy makes the ladder ambiguous, giving `AMBIGUOUS_TARGET`), a single policy-checked model call may re-pick an existing element toward the same intent. The new locator must resolve uniquely before use, and a proposed artifact patch is recorded for review. Default replay never calls a model; this is the deliberate answer to the two classic anti-patterns, replay that secretly re-calls the model and healed steps that silently drift intent. Both the failure and the recovery are in `/evidence`.

---

## 4. Heterogeneity & multi-tenant

Proven on a real, live, third-party bank. Beyond the mock, the whole loop runs against ParaBank, a public demo bank that is server-rendered, table-based, and has no test-ids. A real LLM discovery logs in (credentials injected securely, so the model never sees them), reads an account balance, and the artifact self-verifies and replays deterministically. The same capability reads a different account purely by input (`accountId`) through input-bound targeting, which is the exact shape of a real back-office lookup. That is the "works on an untested, prod-like surface" signal, on-domain. (A literal private core-banking system is inaccessible, and the brief forbids obtaining one; ParaBank is the closest legitimate live proxy.)

**Surface abstraction.** The seam is `Surface` (§1). Its currency is `ObservedElement { role, name, value, rowText }`, which is what an accessibility API provides on any platform. Legacy web is already handled by the same `WebSurface`: the ladder spans role/name → label → text → table-row anchor → proximity anchor (card/section layouts) → href (icon links) → test-id (when present) → css, most-stable-first, unique-match. Frames and shadow DOM are covered too. Perception traverses every frame (iframes and framesets, the real legacy-bank reality) and pierces open shadow roots; refs are frame-namespaced and acts route to the owning frame; and replay resolves a target across frames using a durable frame hint rather than an index, which is what lets a capability drive a screen embedded in a frameset. Adding a desktop app means implementing `DesktopSurface` over UIAutomation/AX/AT-SPI emitting the same `ObservedElement[]`; the artifact, ladders, replay engine, conditions, and safety are untouched because none of them mention the DOM.

**Multi-tenant reuse.** Many tenants run the same vendor product, branded and labelled differently. A capability is recorded once against a base tenant and replayed on another through declared `tenantOverrides`: `labelRewrites` swap accessible-name/text inside ladders and checkpoints ("Member Number" → "Account Number"), and `insertSteps`/`skipStepIds` absorb per-tenant screens. `canonicalization` parameterizes concrete routes. This is demonstrated end-to-end: the `open-member-subaccount` capability recorded on meridian replays successfully on cascade (a second tenant, port 3101), where relabelled controls resolve and an inserted "Identity Verified" compliance click runs, with no re-record (`/evidence`, cascade row). On drift: because replay logs the winning rung and checkpoints assert state, per-tenant and per-version drift shows up as resolution-tier regressions and checkpoint failures, which gate the capability back to `draft`.

---

## 5. Escalation & handoff

`src/hitl/` is a real control-transfer model on the same live session, not a TODO.

- **Detect and route.** Replay raises an intervention on any `escalate`/`reauth` condition or a risky step needing approval, carrying full context: capability, goal, step, why, and a live screenshot plus DOM snapshot.
- **One session, one owner.** `SessionControl` flips ownership from automation to human and awaits a resume promise; that promise is the pause gate, so automation is genuinely idle while the human drives the same headed browser window (not a fresh one). `OperatorHub` is the state machine, and the minimal operator console (`localhost:4600`) shows the context and screenshot with a single "Resume automation" control.
- **Capture.** Everything the human does during the window is captured through injected listeners (clicks, inputs, navigations, with values reduced to lengths) and attached to the intervention as evidence.
- **Intent-aware resume.** After a reauth handoff the human re-established the session but didn't do the business step, so we retry the step. After a generic stuck handoff the human performed the manual step, so we continue. Proven in `/evidence`: the session-timeout run shows the handoff to the human, re-auth on the live session, the handback, the condition clearing, and the run completing to `success`.

What's mocked, deliberately and at a clean seam: a full co-browsing console is out of scope, and for reproducible evidence a scripted operator clicks "Resume". The control-transfer mechanism, pause gate, capture, and console are all real; only the human's click is scripted.

---

## 6. Safety

`src/safety/`, enforced at both discovery and replay.

- **Allowlist.** An explicit allowlist of hosts, route globs, and action types. The effective policy is the intersection of the operator-set global policy and the capability's declared `scope`, so a capability can only ever narrow what it may touch. Violations block during discovery (fed back to the model) and are a hard `POLICY_BLOCKED` failure during replay.
- **Risky vs. reversible.** Steps are classified `safe` or `risky` (irreversible: open/close account, transfer, confirm). Risky steps are handled conservatively: unattended replay requires the capability to be `approved` and an explicit `allowUnattendedRisky` flag, otherwise it escalates for human approval before executing. The confirm step in `open-subaccount` demonstrates the gate.
- **Regulated data.** The capability artifact never stores raw values: targets are locators, sensitive inputs are kept as `[REDACTED]`, and outputs are extraction locators rather than captured values. Logs, the discovery transcript, and evidence are scrubbed both by declaration (inputs and read outputs marked `sensitive`; a value read during discovery is returned to the caller but not written to disk) and by pattern (API keys, JWTs, SSNs, and Luhn-valid card numbers including the spaced/dashed forms a UI renders, so a real PAN is caught but a like-length balance isn't). Screenshots mask password fields.
- **Operator policy isn't trusted from the artifact.** The replay allowlist is operator-supplied (`--allow-route` / `UNDERSTUDY_ALLOWED_ROUTES`, else the default); a capability's `scope` can only narrow it, so a tampered artifact can't widen what the operator allows.

Limits, honestly: redaction is pattern plus declaration, so undeclared free-text PII on a screen (a name, a DOB) can still land in a screenshot or DOM snapshot; treat `/evidence` as sensitive. The allowlist is route/host/action-level, not field-level, and approval is a boolean gate rather than a four-eyes workflow. Each is a clean extension point, not a rewrite.

---

## 7. Cuts

Deliberately left out, at clean seams, with the design intact:

- **Desktop surface.** The abstraction is proven (§4); there's no `DesktopSurface` implementation.
- **Co-browsing operator console.** The handoff mechanism is real; the console is a minimal control plane, and the resume click is scripted for evidence.
- **Persistence and scale.** JSON files, single process. The catalog and `invoke` API exist; queues and multi-tenant plumbing don't, by design.
- **Confidence/approval and multi-run stability** (built, stretch). Capabilities carry a stability score and a draft→approved gate; unattended risky replay depends on it.
- **Bounded self-healing** (built, stretch). Opt-in, a single model call, may only re-pick an existing element toward the same intent, re-verified before use and recorded with a proposed artifact patch. Default replay stays model-free. See §3.
- **Self-verify on record** (built). Every recorded capability is immediately replayed with no model and only marked `verifiedByReplay` if it reproduces.
- **Drift telemetry** (built). Replay reports which ladder rung resolved and flags downgrades so operators can re-record before a capability breaks.

What I'd build next, in order: (1) a `DesktopSurface` to validate the seam on a native app; (2) field-level redaction and a four-eyes approval workflow; (3) auto-applied self-heal patches behind review and a version bump; (4) cross-tenant/version drift dashboards from the resolution-tier telemetry.
