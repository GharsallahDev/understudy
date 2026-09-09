import type { ConditionCode } from '../types/conditions.js';

export type ControlOwner = 'automation' | 'human';

/** Everything a human operator needs to act on a stuck run. */
export interface InterventionContext {
  goal: string;
  capabilityId: string;
  tenantId: string;
  runId: string;
  stepId?: string;
  stepIntent?: string;
  reason: string;
  condition: ConditionCode;
  /** Human-readable snapshot of where we are (url + salient page text). */
  stateSummary: string;
  currentUrl: string;
  screenshotPath?: string;
  snapshotPath?: string;
}

/** A single action captured while the human held control (redacted). */
export interface CapturedAction {
  type: 'click' | 'input' | 'navigate' | 'key';
  target?: string; // role + name / description
  detail?: string; // e.g. "value len=5", never the raw value
  url?: string;
}

export interface Intervention {
  id: string;
  status: 'pending' | 'resolved' | 'cancelled';
  owner: ControlOwner;
  context: InterventionContext;
  createdAt: string;
  resolvedBy?: string;
  note?: string;
  capturedActions: CapturedAction[];
}
