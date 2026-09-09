import { z } from 'zod';

/**
 * Runtime condition taxonomy.
 *
 * The brief calls out the #1 design mistake explicitly: conflating a legitimate
 * business outcome ("no such member") with a hard failure (a crash). So a
 * condition has two independent axes:
 *
 *   1. What happened   -> `ConditionCode` (a stable, machine-readable label)
 *   2. How to treat it -> `Disposition`   (business outcome | recoverable | hard failure)
 *
 * The same code can carry different dispositions in different capabilities
 * (e.g. an unexpected dialog might be a routine interstitial to dismiss in one
 * flow and a genuine blocker in another), so the disposition is declared in the
 * artifact per condition, not hard-wired to the code.
 */

export const conditionCode = z.enum([
  'RECORD_NOT_FOUND',   // a lookup legitimately returned nothing
  'VALIDATION_ERROR',   // the app rejected input (bad amount, missing field)
  'PERMISSION_DENIED',  // the operation is not allowed for this member/role
  'UNEXPECTED_DIALOG',  // an interstitial / modal appeared
  'SESSION_TIMEOUT',    // auth/session expired mid-run
  'TRANSIENT_LOAD',     // slow or partial load; likely retryable
  'APP_ERROR',          // 5xx / explicit application error page
  'CHECKPOINT_FAILED',  // we did not reach the state we asserted
  'LOCATOR_UNRESOLVED', // no locator strategy resolved the target
  'POLICY_BLOCKED',     // a safety guardrail refused the action
  'AMBIGUOUS_TARGET',   // a locator matched >1 element
  'UNKNOWN',
]);
export type ConditionCode = z.infer<typeof conditionCode>;

export const disposition = z.enum([
  'business_outcome', // a legitimate result the caller must be told about; not a crash
  'recoverable',      // handle in-band (dismiss, wait+retry) then continue
  'hard_failure',     // stop; surface a debuggable error
  'escalate',         // hand off to a human
]);
export type Disposition = z.infer<typeof disposition>;

/**
 * How the replay engine recognizes a condition on the live surface after a step.
 * All present fields must match (and). Detection is deterministic, no model.
 */
export type ConditionSignal = {
  /** Any of these substrings present in visible text. */
  anyText?: string[];
  /** An element with this role is present (e.g. "alert"). */
  role?: string;
  /** ...with this accessible name/text. */
  roleName?: string;
  urlIncludes?: string;
  /** Last navigation response status >= this. */
  httpStatusGte?: number;
  /** OR-group: matches if any sub-signal matches (e.g. a 5xx status or an error banner). */
  anyOf?: ConditionSignal[];
};

export const conditionSignal: z.ZodType<ConditionSignal> = z.lazy(() =>
  z.object({
    anyText: z.array(z.string()).optional(),
    role: z.string().optional(),
    roleName: z.string().optional(),
    urlIncludes: z.string().optional(),
    httpStatusGte: z.number().int().optional(),
    anyOf: z.array(conditionSignal).optional(),
  }),
);

export const recoveryAction = z.enum([
  'dismiss_and_retry', // click a known dismissal control, then re-attempt the step
  'wait_and_retry',    // back off and retry the step
  'reauth',            // re-run the login sub-flow, then retry (design-level; stubbed)
  'return_outcome',    // stop the run and return this as a business outcome
  'escalate',          // raise a human intervention
  'fail',              // stop and report a hard failure
]);
export type RecoveryAction = z.infer<typeof recoveryAction>;

/**
 * A condition the capability author anticipated and told replay how to handle.
 * Declared conditions are checked after each step (and globally). Anything not
 * matching a declared condition, plus checkpoint failures, fall through to the
 * default disposition (hard_failure) unless globally recoverable.
 */
export const expectedCondition = z.object({
  code: conditionCode,
  disposition,
  detect: conditionSignal,
  /** What replay should do when this fires. */
  onDetect: recoveryAction,
  /** For return_outcome: the stable outcome code handed back to the caller. */
  outcomeCode: z.string().optional(),
  /** Human-readable explanation for reviewers. */
  note: z.string().optional(),
  /** For retriable actions: cap the attempts. */
  maxRetries: z.number().int().min(0).max(5).default(1),
  /** For dismiss_and_retry: how to dismiss (a locator description resolved the same way as step targets). */
  dismissText: z.string().optional(),
});
export type ExpectedCondition = z.infer<typeof expectedCondition>;
