import { z } from 'zod';
import { locatorSpec } from './locator.js';
import { expectedCondition, conditionSignal } from './conditions.js';

/**
 * The capability artifact: the load-bearing contract of the whole system.
 *
 * Design goals that shaped it:
 *  - It is a callable contract, not a step log. Typed inputs/outputs mean an AI
 *    agent (or a human) can understand what it needs and returns without reading
 *    the steps. That's why inputs/outputs are first-class and JSON-Schema-able.
 *  - It is decoupled from the model transcript. Provenance references the run
 *    that produced it (by id + digest) but the artifact stands alone; replay
 *    never needs the transcript.
 *  - It is versioned and reviewable. `schemaVersion` versions the format;
 *    `version` versions this capability; `approval` gates unattended replay.
 *  - Robustness lives in the targets (locator ladders) and the conditions
 *    (declared runtime outcomes), not in prose.
 *  - It is designed to be reused across tenants running the same vendor product:
 *    `canonicalization` parameterizes concrete routes/values, and
 *    `tenantOverrides` carries the small, declared deltas between tenants.
 */

// ---- typed I/O contract ---------------------------------------------------

export const paramType = z.enum(['string', 'number', 'boolean', 'enum']);

export const paramSpec = z.object({
  name: z.string(),
  type: paramType,
  description: z.string(),
  required: z.boolean().default(true),
  enum: z.array(z.string()).optional(),
  pattern: z.string().optional().describe('Regex the value must match (strings)'),
  example: z.string().optional(),
  /** Sensitive inputs (PII/credentials) are never persisted into artifacts or logs. */
  sensitive: z.boolean().default(false),
});
export type ParamSpec = z.infer<typeof paramSpec>;

export const extractionTransform = z.enum(['trim', 'number', 'currencyToCents', 'raw']);

export const outputSpec = z.object({
  name: z.string(),
  type: paramType,
  description: z.string(),
  /** Regulated/PII output (e.g. an SSN read off screen). The value is returned to
   *  the caller but redacted from persisted evidence, logs, and the transcript. */
  sensitive: z.boolean().default(false),
  extraction: z.object({
    target: locatorSpec,
    attribute: z.enum(['text', 'value']).default('text'),
    transform: extractionTransform.default('trim'),
    /** Optional regex whose first capture group becomes the value. */
    pattern: z.string().optional(),
  }),
});
export type OutputSpec = z.infer<typeof outputSpec>;

// ---- steps ----------------------------------------------------------------

export const actionKind = z.enum([
  'navigate', // go to a URL (route)
  'click',    // click a target
  'type',     // type a value into a target
  'select',   // choose an option in a combobox/select
  'press',    // press a key (e.g. Enter)
  'read',     // capture text/value from a target into named capture
  'assert',   // assert a checkpoint without acting
  'waitFor',  // wait until a checkpoint holds
]);
export type ActionKind = z.infer<typeof actionKind>;

/** Where a step's value comes from. Literals are redacted if marked sensitive. */
export const valueSource = z.discriminatedUnion('from', [
  z.object({ from: z.literal('input'), input: z.string() }),
  z.object({ from: z.literal('literal'), value: z.string(), sensitive: z.boolean().default(false) }),
  z.object({ from: z.literal('none') }),
]);
export type ValueSource = z.infer<typeof valueSource>;

/**
 * A positive assertion that we reached the expected state. Checkpoints are how
 * replay knows a step actually worked instead of blindly proceeding.
 */
export const checkpoint = z.object({
  description: z.string(),
  urlIncludes: z.string().optional(),
  anyText: z.array(z.string()).optional().describe('At least one of these must be present'),
  allText: z.array(z.string()).optional().describe('All of these must be present'),
  absentText: z.array(z.string()).optional().describe('None of these may be present'),
  role: z.string().optional(),
  roleName: z.string().optional(),
});
export type Checkpoint = z.infer<typeof checkpoint>;

export const riskClass = z.enum(['safe', 'risky']);

export const step = z.object({
  id: z.string(),
  intent: z.string().describe('What this step accomplishes and why (for reviewers)'),
  action: actionKind,
  target: locatorSpec.optional(),
  value: valueSource.optional(),
  /** For navigate: a route template, e.g. "/members/:memberNumber". */
  route: z.string().optional(),
  /** For press: the key, e.g. "Enter". */
  key: z.string().optional(),
  /** For read: the capture name to store into. */
  capture: z.string().optional(),
  /** Post-condition asserted after the action; failure => CHECKPOINT_FAILED. */
  checkpoint: checkpoint.optional(),
  /** Conditions specific to this step (checked in addition to global ones). */
  expectedConditions: z.array(expectedCondition).default([]),
  /** safe vs risky/irreversible: drives confirmation/blocking policy. */
  risk: riskClass.default('safe'),
  timeoutMs: z.number().int().positive().default(10_000),
}).superRefine((s, ctx) => {
  // Action-discriminated integrity: a step must carry what its action needs, so a
  // malformed artifact (e.g. a click with no target) fails at parse, not replay.
  if (['click', 'type', 'select', 'read'].includes(s.action) && !s.target) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step "${s.id}": action "${s.action}" requires a target` });
  }
  if (['type', 'select'].includes(s.action) && !s.value) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step "${s.id}": action "${s.action}" requires a value` });
  }
  if (s.action === 'navigate' && !s.route) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step "${s.id}": navigate requires a route` });
  }
  if ((s.action === 'waitFor' || s.action === 'assert') && !s.checkpoint) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step "${s.id}": ${s.action} requires a checkpoint` });
  }
});
export type Step = z.infer<typeof step>;

// ---- cross-tenant / canonicalization --------------------------------------

export const canonicalizationRule = z.object({
  /** e.g. "/member/12345" -> "/member/:memberNumber" */
  concrete: z.string(),
  pattern: z.string(),
  boundTo: z.string().optional().describe('input param the segment binds to'),
});

export const tenantOverride = z.object({
  tenantId: z.string(),
  note: z.string().optional(),
  /** Replace accessible-name / text values inside locator ladders and checkpoints. */
  labelRewrites: z.record(z.string(), z.string()).default({}),
  /** Steps (by id) to insert after a given step id, for tenants with extra screens. */
  insertSteps: z.array(z.object({ afterStepId: z.string(), step })).default([]),
  /** Step ids to skip for this tenant. */
  skipStepIds: z.array(z.string()).default([]),
});
export type TenantOverride = z.infer<typeof tenantOverride>;

// ---- provenance / approval ------------------------------------------------

export const provenance = z.object({
  discoveredBy: z.object({
    model: z.string(),
    provider: z.string().default('google-vertex'),
  }),
  discoveredAt: z.string(),
  sourceRunId: z.string(),
  /** SHA-256 of the raw transcript, so the artifact links to (but does not embed) it. */
  transcriptDigest: z.string().optional(),
  /** Whether the recorded artifact was immediately confirmed by a model-free replay. */
  verifiedByReplay: z.boolean().optional(),
});

export const stabilitySignal = z.object({
  runs: z.number().int(),
  successes: z.number().int(),
  score: z.number().min(0).max(1),
  lastEvaluatedAt: z.string(),
});

export const approval = z.object({
  state: z.enum(['draft', 'approved']).default('draft'),
  approvedBy: z.string().optional(),
  stability: stabilitySignal.optional(),
});

// ---- the capability --------------------------------------------------------

export const ARTIFACT_SCHEMA_VERSION = '1.0.0' as const;

export const capability = z.object({
  schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
  id: z.string().describe('stable slug, e.g. "lookup-member-savings-balance"'),
  version: z.string().describe('semver of this capability'),
  name: z.string(),
  description: z.string(),

  target: z.object({
    appId: z.string(),
    surface: z.enum(['web', 'legacy-web', 'desktop']).default('web'),
    vendorProduct: z.string().optional().describe('the shared underlying product, for cross-tenant reuse'),
    tenantId: z.string(),
    entryRoute: z.string().describe('route template to start from, e.g. "/members"'),
    baseUrlEnv: z.string().default('TARGET_BASE_URL').describe('env var holding the concrete base URL; base URL is NOT baked into the artifact'),
    /** The operator-sanctioned global allowlist this capability was discovered under.
     *  Replay re-applies it as the global bound and then intersects with `scope`,
     *  so replay never has to silently widen the default policy to run the target. */
    operatorPolicy: z
      .object({ allowedRoutes: z.array(z.string()), allowedActions: z.array(actionKind) })
      .optional(),
  }),

  /** Per-capability allowlist scope; the runtime policy is the intersection with the global policy. */
  scope: z.object({
    allowedRoutes: z.array(z.string()).describe('route glob patterns this capability may touch'),
    allowedActions: z.array(actionKind),
  }),

  inputs: z.array(paramSpec).default([]),
  outputs: z.array(outputSpec).default([]),
  steps: z.array(step).min(1),

  /** Overall success condition, asserted at the end (in addition to per-step checkpoints). */
  successCondition: checkpoint,

  /** Conditions that apply across all steps (e.g. session timeout can happen anywhere). */
  globalConditions: z.array(expectedCondition).default([]),

  canonicalization: z.array(canonicalizationRule).default([]),
  tenantOverrides: z.array(tenantOverride).default([]),

  provenance,
  approval: approval.default({ state: 'draft' }),
});
export type Capability = z.infer<typeof capability>;

/** Parse + validate untrusted JSON into a Capability. */
export function parseCapability(json: unknown): Capability {
  return capability.parse(json);
}

export { conditionSignal };
