import type { Capability, Step, OutputSpec, Checkpoint } from '../types/capability.js';
import type { ExpectedCondition, ConditionCode } from '../types/conditions.js';
import type { LocatorSpec } from '../types/locator.js';
import type { Observation } from '../types/surface.js';
import type { WebSurface } from '../surface/webSurface.js';
import type { Evidence } from '../evidence.js';
import type { PolicyEngine } from '../safety/policy.js';
import type { SessionControl } from '../hitl/session.js';
import type { ReplayResult } from '../types/result.js';
import { LocatorError, PolicyError } from '../surface/webSurface.js';
import { evaluateCheckpoint, signalMatches } from './conditions.js';
import { applyTenantOverrides } from './tenant.js';
import { healStep } from './selfHeal.js';
import { bindSpec } from './bind.js';

export interface ReplayOptions {
  capability: Capability;
  inputs: Record<string, string>;
  runId: string;
  tenantId?: string;
  surface: WebSurface;
  evidence: Evidence;
  policy: PolicyEngine;
  session?: SessionControl;
  /** Allow risky/irreversible steps to run unattended (only if capability is approved). */
  allowUnattendedRisky?: boolean;
  /** Opt-in bounded self-healing on locator failure (one model call per broken step). */
  selfHeal?: boolean;
  healApiKey?: string;
  healModel?: string;
  /** Internal: self-verification right after recording. */
  verify?: boolean;
  /** Stop before the first risky/irreversible step (used by self-verify so it
   *  reproduces the safe prefix without committing a mutation a second time). */
  stopBeforeRisky?: boolean;
}

type ConditionOutcome = { kind: 'retry' } | { kind: 'continue' } | { kind: 'stop'; result: ReplayResult };
type StepOutcome = { kind: 'continue' } | { kind: 'stop'; result: ReplayResult };

/**
 * The production execution path. Replays a capability with no model in the
 * decision loop. Determinism comes from: (1) locator ladders resolved the same
 * way every time, requiring a unique match; (2) explicit checkpoints instead of
 * assuming a click worked; (3) explicit, declared handling for every runtime
 * condition; (4) waiting on conditions, never on fixed sleeps for correctness.
 */
export class ReplayEngine {
  private readonly cap: Capability;
  private readonly steps: Step[];
  private readonly inputs: Record<string, string>;
  private readonly tenantId: string;
  private stepsAttempted = 0;
  private checkpointsPassed = 0;
  private readonly startedAt = new Date().toISOString();
  private readonly conditionCounts = new Map<string, number>();
  private readonly notes: string[] = [];
  /** Per-step healed target overrides + which steps we've already tried to heal. */
  private readonly healedTargets = new Map<string, LocatorSpec>();
  private readonly healedSteps = new Set<string>();
  private readonly escalatedSteps = new Set<string>();

  constructor(private readonly opts: ReplayOptions) {
    this.cap = opts.capability;
    this.tenantId = opts.tenantId ?? this.cap.target.tenantId;
    this.steps = applyTenantOverrides(this.cap, this.tenantId);
    this.inputs = opts.inputs;
  }

  async run(): Promise<ReplayResult> {
    const { evidence, surface, policy } = this.opts;
    evidence.log('info', `Replay start: ${this.cap.id}@${this.cap.version} (tenant ${this.tenantId})`, {
      inputs: this.redactInputsForLog(),
      approval: this.cap.approval.state,
    });

    // 0. input contract validation (caller error -> hard failure, clearly)
    const badInput = this.validateInputs();
    if (badInput) return this.failure('UNKNOWN', badInput, undefined, 'valid inputs', 'invalid/missing input');

    // Install the navigation guard so link clicks, form submits and redirects are
    // all enforced at the surface boundary, not just explicit navigate() calls.
    surface.setNavigationGuard?.((url) => policy.checkNavigation(url));

    // entry
    const entry = this.resolveRoute(this.cap.target.entryRoute);
    const nav = policy.checkNavigation(entry);
    if (!nav.allowed) return this.failure('POLICY_BLOCKED', `Entry route blocked: ${nav.reason}`);
    try {
      await surface.navigate(entry);
    } catch (err) {
      // Run-level error boundary: entry/nav failures become a structured result,
      // never an unhandled throw that escapes the ReplayResult contract (F24).
      if (err instanceof PolicyError) return this.failure('POLICY_BLOCKED', err.message);
      return this.failure('UNKNOWN', `Entry navigation failed: ${(err as Error).message}`, undefined, `reach ${entry}`, 'navigation error');
    }
    await surface.screenshot(evidence.nextScreenshotPath('entry'));

    // steps
    for (const step of this.steps) {
      // Self-verify: reproduce the safe prefix but never re-commit an irreversible
      // action. Stop at the first risky step (F06). No second account is created.
      if (this.opts.stopBeforeRisky && step.risk === 'risky') {
        evidence.log('info', `Self-verify: reached risky step ${step.id}; stopping before executing an irreversible action`);
        this.notes.push(`self-verify reproduced the safe prefix and stopped before risky step ${step.id} (no mutation)`);
        return { ...this.base(), status: 'success', outputs: {}, checkpointsPassed: this.checkpointsPassed };
      }
      this.stepsAttempted++;
      const outcome = await this.executeStep(step);
      if (outcome.kind === 'stop') {
        evidence.log(outcome.result.status === 'success' ? 'info' : 'warn', `Stop at ${step.id}: ${outcome.result.status}`);
        return outcome.result;
      }
    }

    // final success verification
    const finalObs = await surface.observe();
    const preempt = await this.detectAndHandle(finalObs, undefined);
    if (preempt && preempt.kind === 'stop') return preempt.result;

    const successCp = this.resolveCheckpointInputs(this.cap.successCondition);
    const cp = evaluateCheckpoint(finalObs, successCp);
    if (!cp.ok) {
      await surface.screenshot(evidence.nextScreenshotPath('fail-success'));
      await surface.htmlSnapshot(evidence.path('failure.html'));
      return this.failure('CHECKPOINT_FAILED', `Success condition not met: ${cp.reasons.join('; ')}`, undefined, successCp.description, finalObs.textDigest.slice(0, 160));
    }
    this.checkpointsPassed++;

    // A declared output that can't be validly extracted means we did not reach the
    // promised end state: surface it as a failure, never as success-with-null (F07).
    const { outputs, errors } = await this.extractOutputs(this.cap.outputs);
    if (errors.length) {
      await surface.screenshot(evidence.nextScreenshotPath('fail-output'));
      await surface.htmlSnapshot(evidence.path('failure.html'));
      return this.failure('CHECKPOINT_FAILED', `Declared outputs not satisfied: ${errors.join('; ')}`, undefined, 'valid declared outputs', JSON.stringify(outputs).slice(0, 160));
    }
    // Mask sensitive outputs in the log; the result we return keeps the real
    // values, since the caller needs them. Redaction is only for evidence.
    evidence.log('info', 'Replay success', { outputs: this.maskSensitiveOutputs(outputs) });
    return {
      ...this.base(),
      status: 'success',
      outputs,
      checkpointsPassed: this.checkpointsPassed,
    };
  }

  // --- per-step execution ---------------------------------------------------

  private async executeStep(step: Step): Promise<StepOutcome> {
    const { evidence, surface, policy } = this.opts;

    // policy
    const dec = policy.checkStep(step);
    if (!dec.allowed) {
      await surface.screenshot(evidence.nextScreenshotPath('policy-block'));
      return { kind: 'stop', result: this.failure('POLICY_BLOCKED', `Step ${step.id} blocked: ${dec.reason}`, step.id) };
    }

    // risky gate: require approval/confirmation for irreversible steps
    if (step.risk === 'risky' && dec.requiresConfirmation) {
      const approvedForUnattended = this.opts.verify || (this.cap.approval.state === 'approved' && this.opts.allowUnattendedRisky);
      if (!approvedForUnattended) {
        const gate = await this.confirmRisky(step);
        if (gate.kind === 'stop') return gate;
      }
    }

    const maxAttempts = 1 + Math.max(1, ...step.expectedConditions.map((c) => c.maxRetries), ...this.cap.globalConditions.map((c) => c.maxRetries));

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // pre-action: clear known blocking recoverable conditions (e.g. interstitial)
      const preObs = await surface.observe();
      const pre = await this.detectAndHandle(preObs, step, /*preAction*/ true);
      if (pre) {
        if (pre.kind === 'stop') return pre;
        if (pre.kind === 'retry') continue;
      }

      // act
      try {
        await this.performAction(step);
      } catch (err) {
        // A blocked destination is definitive: stop immediately, don't proceed.
        if (err instanceof PolicyError) {
          await surface.screenshot(evidence.nextScreenshotPath('policy-block')).catch(() => {});
          return { kind: 'stop', result: this.failure('POLICY_BLOCKED', err.message, step.id) };
        }
        const obs = await surface.observe();
        // did a runtime condition cause the element to be missing (e.g. timeout redirect)?
        const handled = await this.detectAndHandle(obs, step);
        if (handled) {
          if (handled.kind === 'stop') return handled;
          if (handled.kind === 'retry') continue;
          if (handled.kind === 'continue') return { kind: 'continue' };
        }
        if (err instanceof LocatorError) {
          // Bounded self-healing (opt-in): try one model-guided re-resolve for this step.
          if (this.opts.selfHeal && !this.healedSteps.has(step.id) && ['click', 'type', 'select'].includes(step.action)) {
            const healed = await this.tryHeal(step);
            if (healed) continue; // retry the action with the healed target
          }
          if (attempt < maxAttempts - 1) { evidence.log('warn', `Locator retry on ${step.id}`, { detail: err.reason }); continue; }
          const code = err.reason === 'AMBIGUOUS_TARGET' ? 'AMBIGUOUS_TARGET' : 'LOCATOR_UNRESOLVED';
          // If a human operator is available, a genuinely stuck step escalates
          // (take over the live session) and then re-attempts once the human hands
          // control back, so their fix actually takes effect (F23). If it's still
          // unresolved after that, it ends as needs_intervention, not a hard fail.
          if (this.opts.session && !this.escalatedSteps.has(step.id)) {
            this.escalatedSteps.add(step.id);
            await this.opts.session.escalate({ reason: `Stuck: could not resolve "${step.target?.description}" for step ${step.id}`, condition: code, stepId: step.id, stepIntent: step.intent });
            evidence.log('info', `Resuming after handoff; re-attempting ${step.id}`);
            attempt = -1; // fresh attempt cycle now that a human has taken over
            continue;
          }
          await surface.screenshot(evidence.nextScreenshotPath('fail-locator'));
          await surface.htmlSnapshot(evidence.path('failure.html'));
          if (this.opts.session) {
            const after = await surface.observe();
            return { kind: 'stop', result: this.intervention({ code, disposition: 'escalate', detect: {}, onDetect: 'escalate', maxRetries: 0, note: 'stuck: target unresolved after retries/self-heal and human handoff' } as ExpectedCondition, after, step, true) };
          }
          return { kind: 'stop', result: this.failure(code, `Could not target "${step.target?.description}" for step ${step.id}`, step.id, step.target?.description, err.reason) };
        }
        return { kind: 'stop', result: this.failure('UNKNOWN', `Step ${step.id} error: ${(err as Error).message}`, step.id) };
      }

      // post-action conditions
      const obs = await surface.observe();
      const handled = await this.detectAndHandle(obs, step);
      if (handled) {
        if (handled.kind === 'stop') return handled;
        if (handled.kind === 'retry') continue;
        if (handled.kind === 'continue') return { kind: 'continue' };
      }

      // checkpoint: the action has already executed, so on failure we wait for the
      // expected state (deadline-based polling), we never re-run the action. Re-
      // executing a write on a failed checkpoint could double an irreversible
      // operation (F05). A `waitFor` step gets its full declared timeout (F11).
      if (step.checkpoint) {
        const scp = this.resolveCheckpointInputs(step.checkpoint);
        let cp = evaluateCheckpoint(obs, scp);
        if (!cp.ok) {
          const budget = step.action === 'waitFor' ? step.timeoutMs : Math.min(step.timeoutMs, 4000);
          cp = await this.pollCheckpoint(scp, budget);
        }
        if (!cp.ok) {
          await surface.screenshot(evidence.nextScreenshotPath('fail-checkpoint'));
          await surface.htmlSnapshot(evidence.path('failure.html'));
          return { kind: 'stop', result: this.failure('CHECKPOINT_FAILED', `Step ${step.id} checkpoint failed: ${cp.reasons.join('; ')}`, step.id, step.checkpoint.description, obs.textDigest.slice(0, 160)) };
        }
        this.checkpointsPassed++;
      }

      evidence.log('action', `${step.action} ${step.id} ✓`, { detail: step.intent });
      await surface.screenshot(evidence.nextScreenshotPath(step.id));
      return { kind: 'continue' };
    }
    return { kind: 'stop', result: this.failure('UNKNOWN', `Step ${step.id} exhausted retries`, step.id) };
  }

  /** Substitute {{inputName}} tokens in a checkpoint with the caller's values, so
   *  a success predicate can validate the requested identity ("{{memberNumber}}")
   *  in a parameter-independent way instead of hard-coding one run's data (F08). */
  private resolveCheckpointInputs(cp: Checkpoint): Checkpoint {
    const sub = (s?: string): string | undefined =>
      s?.replace(/\{\{(\w+)\}\}/g, (_m, n: string) => this.inputs[n] ?? `{{${n}}}`);
    const subArr = (a?: string[]): string[] | undefined => a?.map((x) => sub(x)!);
    return {
      ...cp,
      anyText: subArr(cp.anyText),
      allText: subArr(cp.allText),
      absentText: subArr(cp.absentText),
      roleName: sub(cp.roleName),
      urlIncludes: sub(cp.urlIncludes),
    };
  }

  /** Wait (deadline-based) for a checkpoint to hold by re-observing only, never
   *  re-executing the action. Used after a failed post-action checkpoint and for
   *  `waitFor` steps. */
  private async pollCheckpoint(cp: Checkpoint, timeoutMs: number): Promise<ReturnType<typeof evaluateCheckpoint>> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 15_000);
    let result = evaluateCheckpoint(await this.opts.surface.observe(), cp);
    while (!result.ok && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      result = evaluateCheckpoint(await this.opts.surface.observe(), cp);
    }
    return result;
  }

  // --- condition detection + handling --------------------------------------

  private candidateConditions(step?: Step): ExpectedCondition[] {
    return [...(step?.expectedConditions ?? []), ...this.cap.globalConditions];
  }

  /** Detect the first matching condition and handle it. Returns null if none matched. */
  private async detectAndHandle(obs: Observation, step?: Step, preAction = false): Promise<ConditionOutcome | null> {
    for (const ec of this.candidateConditions(step)) {
      if (!signalMatches(obs, ec.detect)) continue;
      // pre-action pass handles states that block us from even acting:
      // recoverable "clear the way" dialogs, and escalate/reauth (e.g. an expired
      // session). Business outcomes / hard failures are only meaningful post-action.
      if (preAction && !(ec.disposition === 'recoverable' || ec.disposition === 'escalate')) continue;
      this.opts.evidence.log('condition', `Detected ${ec.code} (${ec.disposition})`, { step: step?.id, onDetect: ec.onDetect });
      return this.handleCondition(ec, obs, step, preAction);
    }
    return null;
  }

  private async handleCondition(ec: ExpectedCondition, obs: Observation, step?: Step, preAction = false): Promise<ConditionOutcome> {
    const { surface, evidence } = this.opts;
    const key = `${step?.id ?? 'global'}:${ec.code}`;
    const count = (this.conditionCounts.get(key) ?? 0) + 1;
    this.conditionCounts.set(key, count);

    switch (ec.onDetect) {
      case 'return_outcome':
        await surface.screenshot(evidence.nextScreenshotPath('business-outcome'));
        return {
          kind: 'stop',
          result: {
            ...this.base(),
            status: 'business_outcome',
            outcome: {
              code: ec.outcomeCode ?? ec.code,
              condition: ec.code,
              message: this.messageFrom(obs, ec),
            },
          },
        };

      case 'fail':
        await surface.screenshot(evidence.nextScreenshotPath('hard-failure'));
        await surface.htmlSnapshot(evidence.path('failure.html'));
        return { kind: 'stop', result: this.failure(ec.code, this.messageFrom(obs, ec), step?.id, ec.note, obs.textDigest.slice(0, 160)) };

      case 'dismiss_and_retry':
        if (count > ec.maxRetries) return { kind: 'stop', result: this.failure(ec.code, `Recovery exhausted for ${ec.code}`, step?.id) };
        if (ec.dismissText) {
          await surface.clickSpec(dismissLocator(ec.dismissText)).catch(() => {});
          evidence.log('info', `Dismissed ${ec.code} via "${ec.dismissText}"`);
        }
        // pre-action: re-attempt the (not-yet-done) step; post-action: the step
        // already succeeded and a dialog merely popped over the result -> continue.
        return preAction ? { kind: 'retry' } : { kind: 'continue' };

      case 'wait_and_retry':
        if (count > ec.maxRetries) return { kind: 'stop', result: this.failure(ec.code, `Retry budget exhausted for ${ec.code}`, step?.id) };
        await surface.pressKey('Escape').catch(() => {});
        return { kind: 'retry' };

      case 'escalate':
      case 'reauth': {
        if (!this.opts.session) {
          return { kind: 'stop', result: this.intervention(ec, obs, step, /*resumed*/ false) };
        }
        if (count > 1) {
          // already handed off once for this condition on this step; don't loop
          return { kind: 'stop', result: this.intervention(ec, obs, step, true) };
        }
        const res = await this.opts.session.escalate({
          reason: `${ec.code}: ${ec.note ?? 'automation cannot safely proceed'}`,
          condition: ec.code,
          stepId: step?.id,
          stepIntent: step?.intent,
        });
        const after = await surface.observe();
        if (signalMatches(after, ec.detect)) {
          // human didn't clear it -> return as intervention outcome (resumed but unresolved)
          return { kind: 'stop', result: this.intervention(ec, after, step, true, res.interventionId) };
        }
        evidence.log('info', `Condition ${ec.code} cleared after handoff; ${ec.onDetect === 'reauth' ? 'retrying step' : 'resuming'}`);
        // reauth: the human re-established the session but did not do the business
        // step. Re-navigate to the entry route (a known-good authenticated page)
        // and retry, independent of wherever the operator left the browser.
        if (ec.onDetect === 'reauth') {
          await surface.navigate(this.resolveRoute(this.cap.target.entryRoute)).catch(() => {});
          return { kind: 'retry' };
        }
        // generic escalate: the human performed the manual step -> continue.
        return { kind: 'continue' };
      }
    }
  }

  private async confirmRisky(step: Step): Promise<StepOutcome> {
    const { session, evidence, surface } = this.opts;
    evidence.log('warn', `Risky step ${step.id} requires confirmation`, { detail: step.intent });
    if (!session) {
      const obs = await surface.observe();
      return { kind: 'stop', result: this.intervention(
        { code: 'POLICY_BLOCKED', disposition: 'escalate', detect: {}, onDetect: 'escalate', maxRetries: 0, note: 'risky step needs approval' } as ExpectedCondition,
        obs, step, false,
      ) };
    }
    await session.escalate({
      reason: `Risky/irreversible step requires human approval: ${step.intent}`,
      condition: 'POLICY_BLOCKED',
      stepId: step.id,
      stepIntent: step.intent,
    });
    evidence.log('info', `Human approved risky step ${step.id}; automation will execute it`);
    return { kind: 'continue' };
  }

  /** One bounded, policy-checked, re-verified self-heal attempt for a broken step. */
  private async tryHeal(step: Step): Promise<boolean> {
    const { evidence, policy } = this.opts;
    if (!this.opts.healApiKey || !this.opts.healModel) return false;
    this.healedSteps.add(step.id); // one attempt per step, regardless of outcome
    evidence.log('warn', `Self-heal: attempting model-guided re-resolve for ${step.id}`, { detail: step.intent });
    let healed;
    try {
      healed = await healStep({ surface: this.opts.surface, step, apiKey: this.opts.healApiKey, model: this.opts.healModel });
    } catch (e) {
      evidence.log('error', `Self-heal errored for ${step.id}`, { detail: (e as Error).message });
      return false;
    }
    if (!healed) { evidence.log('warn', `Self-heal could not safely repair ${step.id} (failing closed)`); return false; }

    // the healed action is still the same action/risk -> re-check policy, never widen
    const dec = policy.checkAction(step.action, step.risk);
    if (!dec.allowed) { evidence.log('warn', `Self-heal candidate blocked by policy for ${step.id}`); return false; }

    this.healedTargets.set(step.id, healed.spec);
    const note = `self-healed ${step.id}: "${step.target?.description}" → "${healed.spec.description}" (${healed.reason})`;
    this.notes.push(note);
    evidence.log('info', `Self-heal OK for ${step.id}`, { detail: healed.spec.description });
    // emit a proposed artifact patch for human review, do not silently rewrite
    evidence.writeJson(`self-heal-patch-${step.id}.json`, {
      capabilityId: this.cap.id,
      stepId: step.id,
      reason: healed.reason,
      oldTarget: step.target,
      newTarget: healed.spec,
      note: 'Proposed patch. Apply only after human review; then bump capability version.',
    });
    return true;
  }

  // --- actions --------------------------------------------------------------

  private async performAction(step: Step): Promise<void> {
    const { surface, evidence } = this.opts;
    switch (step.action) {
      case 'navigate': {
        const route = this.resolveRoute(step.route ?? '/');
        const nav = this.opts.policy.checkNavigation(route);
        if (!nav.allowed) throw new Error(`navigation blocked: ${nav.reason}`);
        await surface.navigate(route);
        return;
      }
      case 'click':
      case 'type':
      case 'select': {
        const spec = bindSpec(this.healedTargets.get(step.id) ?? step.target!, this.inputs);
        const r = await surface.resolve(spec); // resolve first to log which rung won (drift signal)
        if (!r.ok) throw new LocatorError(spec, r.reason ?? 'LOCATOR_UNRESOLVED');
        evidence.log('action', `resolve ${step.id} via ${r.strategyKind}[${r.strategyIndex}]`, { detail: spec.description });
        // Drift telemetry: the recorded primary rung is index 0. Resolving on a
        // lower/weaker rung means the semantic layer shifted: surface it.
        if ((r.strategyIndex ?? 0) > 0) {
          const note = `drift: step ${step.id} resolved via ${r.strategyKind}[${r.strategyIndex}] (recorded primary was ${spec.strategies[0]!.kind}) — capability should be reviewed/re-recorded`;
          this.notes.push(note);
          evidence.log('warn', note);
        }
        if (step.action === 'click') await surface.clickSpec(spec);
        else if (step.action === 'type') await surface.typeSpec(spec, this.resolveValue(step));
        else await surface.selectSpec(spec, this.resolveValue(step));
        return;
      }
      case 'press':
        await surface.pressKey(step.key ?? 'Enter');
        return;
      case 'read':
      case 'assert':
      case 'waitFor':
        // handled via checkpoint evaluation on the post-observation
        return;
    }
  }

  // --- outputs --------------------------------------------------------------

  /**
   * Extract declared outputs and validate them. A declared output that can't be
   * located, extracts to empty, or fails its type is an error, not a silent null
   * and never a fabricated zero. "Success" must mean the caller actually got the
   * data it was promised (F07).
   */
  private async extractOutputs(specs: OutputSpec[]): Promise<{ outputs: Record<string, string | number | boolean | null>; errors: string[] }> {
    const outputs: Record<string, string | number | boolean | null> = {};
    const errors: string[] = [];
    for (const o of specs) {
      let raw: string;
      try {
        raw = await this.opts.surface.readSpec(bindSpec(o.extraction.target, this.inputs), o.extraction.attribute);
      } catch (e) {
        errors.push(`output "${o.name}" could not be located (${(e as Error).message})`);
        outputs[o.name] = null;
        continue;
      }
      const val = transform(raw, o);
      const invalid =
        val === null ||
        val === '' ||
        (o.type === 'number' && (typeof val !== 'number' || !Number.isFinite(val)));
      if (invalid) {
        errors.push(`output "${o.name}" not extractable from "${String(raw).slice(0, 48)}"`);
        outputs[o.name] = val;
      } else {
        outputs[o.name] = val;
      }
    }
    return { outputs, errors };
  }

  // --- helpers --------------------------------------------------------------

  private validateInputs(): string | null {
    const declared = new Set(this.cap.inputs.map((i) => i.name));
    // Reject undeclared inputs: the invocation contract is exact.
    for (const k of Object.keys(this.inputs)) {
      if (!declared.has(k)) return `Unknown input "${k}" (not in the capability contract)`;
    }
    for (const spec of this.cap.inputs) {
      const v = this.inputs[spec.name];
      if (v == null || v === '') {
        if (spec.required) return `Missing required input "${spec.name}"`;
        continue;
      }
      // Real type validation, not just pattern/enum.
      if (spec.type === 'number' && !Number.isFinite(Number(v))) return `Input "${spec.name}" must be a number (got "${v}")`;
      if (spec.type === 'boolean' && !['true', 'false'].includes(v.toLowerCase())) return `Input "${spec.name}" must be a boolean`;
      if (spec.pattern && !new RegExp(spec.pattern).test(v)) return `Input "${spec.name}" does not match ${spec.pattern}`;
      if (spec.enum && !spec.enum.includes(v)) return `Input "${spec.name}" must be one of ${spec.enum.join(', ')}`;
    }
    return null;
  }

  private resolveRoute(template: string): string {
    return template.replace(/:([A-Za-z0-9_]+)/g, (_m, name) => encodeURIComponent(this.inputs[name] ?? `:${name}`));
  }

  private resolveValue(step: Step): string {
    const vs = step.value;
    if (!vs || vs.from === 'none') return '';
    if (vs.from === 'input') return this.inputs[vs.input] ?? '';
    return vs.value;
  }

  private messageFrom(obs: Observation, ec: ExpectedCondition): string {
    const alert = obs.elements.find((e) => e.role === 'alert');
    if (alert?.name) return alert.name.slice(0, 200);
    const hit = ec.detect.anyText?.find((t) => obs.textDigest.toLowerCase().includes(t.toLowerCase()));
    return (hit ? obs.textDigest.slice(Math.max(0, obs.textDigest.toLowerCase().indexOf(hit.toLowerCase()))) : obs.textDigest).slice(0, 200);
  }

  private maskSensitiveOutputs(outputs: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
    const sens = new Set(this.cap.outputs.filter((o) => o.sensitive).map((o) => o.name));
    if (!sens.size) return outputs;
    return Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, sens.has(k) ? '[REDACTED]' : v]));
  }

  private redactInputsForLog(): Record<string, string> {
    const sensitive = new Set(this.cap.inputs.filter((i) => i.sensitive).map((i) => i.name));
    return Object.fromEntries(Object.entries(this.inputs).map(([k, v]) => [k, sensitive.has(k) ? '[REDACTED]' : v]));
  }

  private base() {
    return {
      runId: this.opts.runId,
      capabilityId: this.cap.id,
      capabilityVersion: this.cap.version,
      tenantId: this.tenantId,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      stepsAttempted: this.stepsAttempted,
      evidenceDir: this.opts.evidence.dir,
      notes: this.notes.length ? [...this.notes] : undefined,
    };
  }

  private failure(condition: ConditionCode, message: string, stepId?: string, expected?: string, observed?: string): ReplayResult {
    return {
      ...this.base(),
      status: 'failure',
      error: { condition, disposition: 'hard_failure', stepId, message, expected, observed },
    };
  }

  private intervention(ec: ExpectedCondition, obs: Observation, step: Step | undefined, resumed: boolean, interventionId?: string): ReplayResult {
    return {
      ...this.base(),
      status: 'needs_intervention',
      intervention: {
        interventionId: interventionId ?? 'pending',
        reason: ec.note ?? `${ec.code} requires a human`,
        condition: ec.code,
        stepId: step?.id,
        context: {
          goal: this.cap.description,
          stepIntent: step?.intent,
          stateSummary: obs.textDigest.slice(0, 200),
          screenshotPath: undefined,
        },
        resumed,
      },
    };
  }
}

function dismissLocator(text: string): LocatorSpec {
  return {
    description: `dismiss control "${text}"`,
    strategies: [
      { kind: 'role', role: 'button', name: text, exact: false },
      { kind: 'text', text, exact: false },
    ],
    confidence: 0.7,
  };
}

function transform(raw: string, o: OutputSpec): string | number | null {
  let v = raw.trim();
  if (o.extraction.pattern) {
    const m = new RegExp(o.extraction.pattern).exec(raw);
    // pattern miss => null (do not fall back to raw, which fabricates a value)
    if (!m) return null;
    v = (m[1] ?? m[0] ?? '').trim();
  }
  // A numeric transform requires actual digits; empty/no-digit input is null,
  // never a fabricated 0 (Number('') === 0).
  const numeric = (s: string): number | null => {
    const cleaned = s.replace(/[^0-9.\-]/g, '');
    if (!/[0-9]/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  };
  switch (o.extraction.transform) {
    case 'number':
      return numeric(v);
    case 'currencyToCents': {
      const n = numeric(v);
      return n === null ? null : Math.round(n * 100);
    }
    case 'raw':
      return raw;
    default:
      return v || null;
  }
}

/** Convenience wrapper. */
export function replay(opts: ReplayOptions): Promise<ReplayResult> {
  return new ReplayEngine(opts).run();
}

/** Mask declared-sensitive output values before a result is written to evidence.
 *  The in-memory result returned to the caller keeps the real values. */
export function redactResultForEvidence(result: ReplayResult, cap: Capability): ReplayResult {
  if (result.status !== 'success') return result;
  const sens = new Set(cap.outputs.filter((o) => o.sensitive).map((o) => o.name));
  if (!sens.size) return result;
  return {
    ...result,
    outputs: Object.fromEntries(Object.entries(result.outputs).map(([k, v]) => [k, sens.has(k) ? '[REDACTED]' : v])),
  };
}
