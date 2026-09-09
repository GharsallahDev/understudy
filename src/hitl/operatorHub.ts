import { randomBytes } from 'node:crypto';
import type { Intervention, InterventionContext, CapturedAction } from './types.js';

/**
 * In-process registry of interventions and the control-transfer state machine.
 *
 * The seam this models: automation and a human share one live session. At any
 * moment exactly one party owns control. `escalate()` flips ownership to the
 * human and returns a promise that only resolves when the operator console (or
 * a caller) signals `resume()`. That promise is the pause-gate: the automation
 * literally awaits it, so nothing runs while the human is driving.
 */
export class OperatorHub {
  private interventions = new Map<string, Intervention>();
  private resolvers = new Map<string, (v: ResumeSignal) => void>();
  private listeners = new Set<() => void>();

  list(): Intervention[] {
    return [...this.interventions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  pending(): Intervention[] {
    return this.list().filter((i) => i.status === 'pending');
  }
  get(id: string): Intervention | undefined {
    return this.interventions.get(id);
  }
  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Raise an intervention and return a promise resolved when a human hands control back. */
  escalate(context: InterventionContext, seq: number): { id: string; wait: Promise<ResumeSignal> } {
    const id = `iv_${seq.toString().padStart(3, '0')}_${randomBytes(3).toString('hex')}`;
    const iv: Intervention = {
      id,
      status: 'pending',
      owner: 'human',
      context,
      createdAt: `iv+${seq.toString().padStart(3, '0')}`,
      capturedActions: [],
    };
    this.interventions.set(id, iv);
    this.emit();
    const wait = new Promise<ResumeSignal>((resolve) => this.resolvers.set(id, resolve));
    return { id, wait };
  }

  recordAction(id: string, action: CapturedAction): void {
    const iv = this.interventions.get(id);
    if (iv && iv.status === 'pending') iv.capturedActions.push(action);
  }

  /** Operator signals they're done; control returns to automation. */
  resume(id: string, opts: { resolvedBy?: string; note?: string } = {}): boolean {
    const iv = this.interventions.get(id);
    const resolve = this.resolvers.get(id);
    if (!iv || !resolve || iv.status !== 'pending') return false;
    iv.status = 'resolved';
    iv.owner = 'automation';
    iv.resolvedBy = opts.resolvedBy ?? 'operator';
    iv.note = opts.note;
    this.resolvers.delete(id);
    this.emit();
    resolve({ resolvedBy: iv.resolvedBy, note: iv.note, capturedActions: iv.capturedActions });
    return true;
  }
}

export interface ResumeSignal {
  resolvedBy: string;
  note?: string;
  capturedActions: CapturedAction[];
}
