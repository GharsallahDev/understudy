import type { ConditionCode, Disposition } from './conditions.js';

/**
 * The replay result contract. This is what an AI agent (the caller in
 * production) actually receives. Its shape is deliberate: the four statuses map
 * one-to-one onto the dispositions the brief asks us to separate, so a caller
 * can branch on `status` without string-matching error messages.
 *
 *   success            -> the goal was achieved; typed outputs returned
 *   business_outcome   -> a legitimate result the caller must handle (not a crash)
 *   needs_intervention -> we stopped and asked a human to take over
 *   failure            -> a hard failure with enough context to debug
 */

export interface ResultBase {
  runId: string;
  capabilityId: string;
  capabilityVersion: string;
  tenantId: string;
  startedAt: string;
  endedAt: string;
  stepsAttempted: number;
  /** Directory holding structured logs + screenshots + snapshots for this run. */
  evidenceDir: string;
  /** Non-fatal observations worth surfacing: locator drift, self-heal events, etc. */
  notes?: string[];
}

export interface SuccessResult extends ResultBase {
  status: 'success';
  outputs: Record<string, string | number | boolean | null>;
  checkpointsPassed: number;
}

export interface BusinessOutcomeResult extends ResultBase {
  status: 'business_outcome';
  outcome: {
    /** Stable, capability-declared code, e.g. "MEMBER_NOT_FOUND". */
    code: string;
    /** The underlying runtime condition that produced it. */
    condition: ConditionCode;
    message: string;
    data?: Record<string, unknown>;
  };
}

export interface InterventionResult extends ResultBase {
  status: 'needs_intervention';
  intervention: {
    interventionId: string;
    reason: string;
    condition: ConditionCode;
    stepId?: string;
    /** Everything a human needs to act: what capability/goal, where it stopped, why. */
    context: {
      goal: string;
      stepIntent?: string;
      stateSummary: string;
      screenshotPath?: string;
      snapshotPath?: string;
    };
    resolvedBy?: string;
    resumed?: boolean;
  };
}

export interface FailureResult extends ResultBase {
  status: 'failure';
  error: {
    condition: ConditionCode;
    disposition: Disposition;
    stepId?: string;
    message: string;
    expected?: string;
    observed?: string;
  };
}

export type ReplayResult = SuccessResult | BusinessOutcomeResult | InterventionResult | FailureResult;

/** A condition raised internally during a run before it's turned into a result. */
export interface RaisedCondition {
  code: ConditionCode;
  disposition: Disposition;
  message: string;
  stepId?: string;
  expected?: string;
  observed?: string;
  outcomeCode?: string;
  data?: Record<string, unknown>;
}
