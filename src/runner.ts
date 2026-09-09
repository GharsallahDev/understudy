import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { WebSurface } from './surface/webSurface.js';
import { Evidence } from './evidence.js';
import { PolicyEngine, DEFAULT_POLICY, type GlobalPolicy } from './safety/policy.js';
import { discover, type DeclaredInput } from './agent/discover.js';
import { recordCapability, type RecordMeta } from './agent/recorder.js';
import { ReplayEngine, redactResultForEvidence } from './replay/replay.js';
import { OperatorHub } from './hitl/operatorHub.js';
import { startOperatorConsole, type OperatorConsoleHandle } from './hitl/operatorConsole.js';
import { SessionControl } from './hitl/session.js';
import type { Capability } from './types/capability.js';
import type { ReplayResult } from './types/result.js';
import type { LocatorSpec } from './types/locator.js';

export function newRunId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
}

/** Toggle mock-app fault injection out-of-band (tests/evidence). */
export async function setFaults(baseUrl: string, faults: Record<string, unknown>): Promise<void> {
  await fetch(`${baseUrl}/_admin/faults`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(faults),
  }).catch(() => {});
}
export async function resetMock(baseUrl: string): Promise<void> {
  await fetch(`${baseUrl}/_admin/reset`, { method: 'POST' }).catch(() => {});
}

const LOGIN = {
  user: process.env.MOCK_USER ?? 'operator',
  pass: process.env.MOCK_PASS ?? 'demo-pass',
};
const spec = (description: string, strategies: LocatorSpec['strategies']): LocatorSpec => ({ description, strategies, confidence: 0.9 });

/**
 * Platform-level authentication. Sessions/auth are a platform concern, not part
 * of each business capability, so login lives here and every capability assumes
 * an authenticated session. (A SESSION_TIMEOUT during replay escalates for reauth
 * rather than baking credentials into artifacts.)
 */
export async function authenticate(surface: WebSurface, evidence?: Evidence): Promise<void> {
  await surface.navigate('/login');
  const obs = await surface.observe();
  const hasLogin = obs.elements.some((e) => e.role === 'textbox' && e.name === 'Username');
  if (!hasLogin && obs.url.includes('/members')) return; // already authed
  await surface.typeSpec(spec('Username field', [{ kind: 'role', role: 'textbox', name: 'Username', exact: false }, { kind: 'label', label: 'Username', exact: false }]), LOGIN.user);
  await surface.typeSpec(spec('Password field', [{ kind: 'role', role: 'textbox', name: 'Password', exact: false }, { kind: 'label', label: 'Password', exact: false }]), LOGIN.pass);
  await surface.clickSpec(spec('Sign In button', [{ kind: 'role', role: 'button', name: 'Sign In', exact: false }, { kind: 'text', text: 'Sign In', exact: false }]));
  evidence?.log('info', 'Authenticated (platform-level; not part of the capability)');
}

export function buildPolicy(cap?: Capability, override?: Partial<GlobalPolicy>): PolicyEngine {
  return new PolicyEngine({ ...DEFAULT_POLICY, ...override }, cap?.scope);
}

/** Operator-configured global allowlist from the environment (never the artifact).
 *  UNDERSTUDY_ALLOWED_ROUTES / UNDERSTUDY_ALLOWED_HOSTS are comma-separated globs. */
export function operatorPolicyFromEnv(): Partial<GlobalPolicy> | undefined {
  const routes = process.env.UNDERSTUDY_ALLOWED_ROUTES?.split(',').map((s) => s.trim()).filter(Boolean);
  const hosts = process.env.UNDERSTUDY_ALLOWED_HOSTS?.split(',').map((s) => s.trim()).filter(Boolean);
  if (!routes && !hosts) return undefined;
  return { ...(routes ? { allowedRoutes: routes } : {}), ...(hosts ? { allowedHosts: hosts } : {}) };
}

/**
 * The operator chooses the target base URL, so its host is trusted by definition;
 * the allowlist's job is to stop the agent wandering to other hosts. Merge the
 * target host into the allowed set automatically.
 */
function mergeHost(override: Partial<GlobalPolicy> | undefined, baseUrl: string): Partial<GlobalPolicy> {
  let host: string | undefined;
  try { host = new URL(baseUrl).hostname; } catch { /* ignore */ }
  const base = override?.allowedHosts ?? DEFAULT_POLICY.allowedHosts;
  return { ...override, allowedHosts: Array.from(new Set([...base, ...(host ? [host] : [])])) };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
export interface DiscoverRunOptions {
  goal: string;
  inputs: DeclaredInput[];
  entryRoute: string;
  meta: RecordMeta;
  model?: string;
  apiKey: string;
  baseUrl?: string;
  headless?: boolean;
  withOperator?: boolean;
  maxSteps?: number;
  /** Widen/replace the guardrail policy (e.g. to allow a public host). */
  policyOverride?: Partial<GlobalPolicy>;
  /** Pre-authenticate against the mock console. Set false for targets where login
   *  is part of the flow (the agent logs in itself, e.g. a public site). */
  preAuth?: boolean;
}

export async function runDiscovery(opts: DiscoverRunOptions): Promise<{ capability: Capability; success: boolean; evidenceDir: string }> {
  const baseUrl = opts.baseUrl ?? config.targetBaseUrl;
  const runId = newRunId('disc');
  const evidence = new Evidence(config.evidenceDir, 'discovery', opts.meta.id, runId);
  const surface = await WebSurface.launch({ baseUrl, headless: opts.headless ?? config.headless, slowMo: opts.headless ? 0 : 120 });
  const preAuth = opts.preAuth ?? true;

  let hub: OperatorHub | undefined;
  let console_: OperatorConsoleHandle | undefined;
  let session: SessionControl | undefined;
  try {
    // Discovery is a supervised rehearsal (a human runs `discover`), so risky
    // steps are explicitly flagged and recorded as risky here. Replay then
    // re-gates them under the strict require_confirmation policy. This is an
    // explicit choice, not a silent downgrade (see F03).
    const policy = buildPolicy(undefined, mergeHost({ riskyActionHandling: 'flag', ...opts.policyOverride }, baseUrl));
    if (opts.withOperator) {
      hub = new OperatorHub();
      console_ = await startOperatorConsole(hub, config.operatorPort);
      session = new SessionControl(surface, hub, evidence, { goal: opts.goal, capabilityId: opts.meta.id, tenantId: opts.meta.tenantId, runId });
      evidence.log('info', `Operator console: ${console_.url}`);
    }
    if (preAuth) await authenticate(surface, evidence);

    const discovery = await discover({
      goal: opts.goal,
      inputs: opts.inputs,
      entryRoute: opts.entryRoute,
      capabilityId: opts.meta.id,
      tenantId: opts.meta.tenantId,
      runId,
      model: opts.model ?? config.model,
      apiKey: opts.apiKey,
      surface,
      evidence,
      policy,
      session,
      maxSteps: opts.maxSteps,
      preAuthed: preAuth,
    });

    evidence.writeJson('discovery-result.json', { ...discovery, finalObs: undefined });

    if (!discovery.success) {
      evidence.writeSummary({ status: 'discovery_incomplete', stopReason: discovery.stopReason, runId });
      return { capability: null as unknown as Capability, success: false, evidenceDir: evidence.dir };
    }

    // record the operator-sanctioned global allowlist discovery ran under, so
    // replay can re-apply it as the outer bound (then intersect with scope).
    const effectiveGlobal: GlobalPolicy = { ...DEFAULT_POLICY, ...opts.policyOverride };
    const capability = recordCapability(discovery, {
      ...opts.meta,
      operatorPolicy: { allowedRoutes: effectiveGlobal.allowedRoutes, allowedActions: effectiveGlobal.allowedActions },
    });

    // Self-verify: immediately replay the just-recorded artifact (no model in the
    // loop) to confirm it actually reproduces before we offer it. A capability
    // that can't replay its own discovery is not trustworthy.
    // A mutating capability is verified only up to (not through) its first risky
    // step, so self-verification never commits a second irreversible action (F06).
    const hasRisky = capability.steps.some((s) => s.risk === 'risky');
    evidence.log('info', `Self-verifying: replaying the recorded artifact deterministically${hasRisky ? ' (safe prefix only — will not re-commit the irreversible step)' : ''}…`);
    let verified = false;
    try {
      const vres = await runReplay({
        capability,
        // include sensitive inputs (e.g. credentials) so the verify replay can log in
        inputs: Object.fromEntries(opts.inputs.map((i) => [i.name, i.value])),
        headless: opts.headless ?? config.headless,
        baseUrl,
        verify: true,
        stopBeforeRisky: hasRisky,
        preAuth,
        policyOverride: opts.policyOverride,
        runLabel: 'verify',
      });
      verified = vres.status === 'success';
      evidence.log(verified ? 'info' : 'warn', `Self-verify: ${vres.status}`, {
        detail: verified ? 'artifact reproduces ✓' : 'artifact did NOT reproduce — left unverified',
      });
    } catch (e) {
      evidence.log('warn', 'Self-verify errored', { detail: (e as Error).message });
    }
    capability.provenance.verifiedByReplay = verified;

    evidence.writeJson('capability.json', capability, /*redact*/ false);
    evidence.writeSummary({ status: 'discovery_success', capabilityId: capability.id, steps: capability.steps.length, outputs: capability.outputs.map((o) => o.name), verifiedByReplay: verified, runId });
    return { capability, success: true, evidenceDir: evidence.dir };
  } finally {
    await console_?.close();
    await surface.close();
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------
export interface ReplayRunOptions {
  capability: Capability;
  inputs: Record<string, string>;
  tenantId?: string;
  baseUrl?: string;
  headless?: boolean;
  withOperator?: boolean;
  /** Scripted operator: auto-resume any pending intervention after N ms (for reproducible HITL evidence). */
  autoResumeMs?: number;
  autoResumeAction?: (surface: WebSurface) => Promise<void>;
  allowUnattendedRisky?: boolean;
  runLabel?: string;
  /** Opt-in bounded self-healing (needs a model key). */
  selfHeal?: boolean;
  healApiKey?: string;
  healModel?: string;
  /** Internal: self-verification replay right after recording. */
  verify?: boolean;
  /** Stop before the first risky step (safe-prefix self-verify, no re-mutation). */
  stopBeforeRisky?: boolean;
  /** Widen/replace the guardrail policy (e.g. to allow a public host). */
  policyOverride?: Partial<GlobalPolicy>;
  /** Pre-authenticate against the mock console (false when login is in the capability). */
  preAuth?: boolean;
}

export async function runReplay(opts: ReplayRunOptions): Promise<ReplayResult> {
  const baseUrl = opts.baseUrl ?? config.targetBaseUrl;
  const runId = newRunId(opts.runLabel ?? 'replay');
  const evidence = new Evidence(config.evidenceDir, 'replay', opts.capability.id, runId);
  const surface = await WebSurface.launch({ baseUrl, headless: opts.headless ?? config.headless, slowMo: opts.headless ? 0 : 80 });

  let hub: OperatorHub | undefined;
  let console_: OperatorConsoleHandle | undefined;
  let session: SessionControl | undefined;
  try {
    // The outer bound at replay comes from the operator, not the artifact: explicit
    // override, else operator env config, else the default. The artifact can only
    // narrow it via its scope (PolicyEngine intersects), so a tampered
    // target.operatorPolicy/scope can't widen what the operator allows.
    const replayGlobal = opts.policyOverride ?? operatorPolicyFromEnv() ?? undefined;
    if (!opts.policyOverride && !operatorPolicyFromEnv() && opts.capability.target.operatorPolicy) {
      evidence.log('warn', 'Using DEFAULT operator policy; artifact-recorded policy is NOT trusted as the outer bound. Set UNDERSTUDY_ALLOWED_ROUTES or pass --allow-route to sanction non-default routes.');
    }
    const policy = buildPolicy(opts.capability, mergeHost(replayGlobal, baseUrl));
    if (opts.withOperator) {
      hub = new OperatorHub();
      console_ = await startOperatorConsole(hub, config.operatorPort);
      session = new SessionControl(surface, hub, evidence, { goal: opts.capability.description, capabilityId: opts.capability.id, tenantId: opts.tenantId ?? opts.capability.target.tenantId, runId });
      evidence.log('info', `Operator console: ${console_.url}`);
      if (opts.autoResumeMs != null) scheduleAutoResume(hub, surface, opts.autoResumeMs, evidence, opts.autoResumeAction);
    }
    if (opts.preAuth ?? true) await authenticate(surface, evidence);

    const result = await new ReplayEngine({
      capability: opts.capability,
      inputs: opts.inputs,
      runId,
      tenantId: opts.tenantId,
      surface,
      evidence,
      policy,
      session,
      allowUnattendedRisky: opts.allowUnattendedRisky,
      selfHeal: opts.selfHeal,
      healApiKey: opts.healApiKey,
      healModel: opts.healModel,
      verify: opts.verify,
      stopBeforeRisky: opts.stopBeforeRisky,
    }).run();

    evidence.writeSummary(redactResultForEvidence(result, opts.capability));
    return result;
  } finally {
    await console_?.close();
    await surface.close();
  }
}

/**
 * Scripted operator for reproducible HITL evidence: when an intervention appears,
 * optionally perform the manual fix in the live session, then resume, exactly
 * what a human would do by clicking "Resume automation" in the console. The
 * control-transfer mechanism is real; only the click is scripted.
 */
function scheduleAutoResume(
  hub: OperatorHub,
  surface: WebSurface,
  delayMs: number,
  evidence: Evidence,
  action?: (s: WebSurface) => Promise<void>,
): void {
  // Handle each intervention exactly once. onChange fires on every hub event, so
  // without this guard overlapping timers would run the manual fix (e.g. reauth)
  // concurrently on the same live page and corrupt its state.
  const handled = new Set<string>();
  hub.onChange(() => {
    for (const iv of hub.pending()) {
      if (handled.has(iv.id)) continue;
      handled.add(iv.id);
      setTimeout(async () => {
        if (hub.get(iv.id)?.status !== 'pending') return;
        evidence.log('info', `[scripted-operator] performing manual fix + resuming ${iv.id}`);
        if (action) {
          try { await action(surface); } catch (e) { evidence.log('error', `[scripted-operator] manual fix failed`, { detail: (e as Error).message }); }
        }
        hub.resume(iv.id, { resolvedBy: 'scripted-operator', note: 'manual step performed in live session, then resumed' });
      }, delayMs);
    }
  });
}
