import type { Capability } from '../types/capability.js';
import { runReplay } from '../runner.js';

/**
 * Multi-run stability signal (stretch): replay a capability N times with the
 * same inputs and report how reliably it reproduces. A capability should only be
 * promoted from draft -> approved once it replays stably; unattended risky replay
 * is gated on that approval.
 */
export interface StabilityReport {
  runs: number;
  successes: number;
  score: number;
  statuses: string[];
}

export async function measureStability(
  capability: Capability,
  inputs: Record<string, string>,
  runs: number,
  opts: { baseUrl?: string } = {},
): Promise<StabilityReport> {
  const statuses: string[] = [];
  let successes = 0;
  for (let i = 0; i < runs; i++) {
    const result = await runReplay({
      capability,
      inputs,
      headless: true,
      baseUrl: opts.baseUrl,
      runLabel: `stability-${i + 1}`,
      allowUnattendedRisky: capability.approval.state === 'approved',
    });
    statuses.push(result.status);
    if (result.status === 'success') successes++;
  }
  return { runs, successes, score: runs ? successes / runs : 0, statuses };
}

export function withStability(cap: Capability, report: StabilityReport): Capability {
  return {
    ...cap,
    approval: {
      ...cap.approval,
      stability: { runs: report.runs, successes: report.successes, score: report.score, lastEvaluatedAt: new Date().toISOString() },
    },
  };
}
