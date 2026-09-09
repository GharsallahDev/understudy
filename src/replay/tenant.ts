import type { Capability, Step, Checkpoint } from '../types/capability.js';
import type { LocatorSpec, LocatorStrategy } from '../types/locator.js';

/**
 * Cross-tenant reuse. Many tenants run the same vendor product with different
 * wording and the occasional extra screen. Rather than re-recording per tenant,
 * a capability recorded on the base tenant is replayed on another with a small,
 * declared set of overrides:
 *   - labelRewrites: swap accessible-name/text values inside locators & checkpoints
 *     (e.g. "Member Number" -> "Account Number"), so the same ladders still resolve
 *   - insertSteps / skipStepIds: absorb per-tenant screens (e.g. an extra identity
 *     verification step)
 *
 * This keeps the base flow authoritative and makes tenant deltas reviewable in
 * one place instead of scattered across N copies.
 */
export function applyTenantOverrides(cap: Capability, tenantId: string): Step[] {
  const override = cap.tenantOverrides.find((o) => o.tenantId === tenantId);
  const clone = structuredClone(cap.steps) as Step[];
  if (!override || tenantId === cap.target.tenantId) return clone;

  const rewrites = override.labelRewrites;
  let steps = clone
    .filter((s) => !override.skipStepIds.includes(s.id))
    .map((s) => rewriteStep(s, rewrites));

  for (const ins of override.insertSteps) {
    const idx = steps.findIndex((s) => s.id === ins.afterStepId);
    if (idx >= 0) steps.splice(idx + 1, 0, rewriteStep(structuredClone(ins.step), rewrites));
  }
  return steps;
}

function rewriteStr(s: string | undefined, rw: Record<string, string>): string | undefined {
  if (s == null) return s;
  let out = s;
  for (const [from, to] of Object.entries(rw)) out = out.split(from).join(to);
  return out;
}

function rewriteStrategy(st: LocatorStrategy, rw: Record<string, string>): LocatorStrategy {
  switch (st.kind) {
    case 'role':
      return { ...st, name: rewriteStr(st.name, rw) };
    case 'label':
      return { ...st, label: rewriteStr(st.label, rw)! };
    case 'text':
      return { ...st, text: rewriteStr(st.text, rw)! };
    case 'placeholder':
      return { ...st, placeholder: rewriteStr(st.placeholder, rw)! };
    case 'relative':
      return {
        ...st,
        anchor: { ...st.anchor, text: rewriteStr(st.anchor.text, rw)! },
        target: { role: st.target.role, text: rewriteStr(st.target.text, rw) },
      };
    default:
      return st;
  }
}

function rewriteLocator(spec: LocatorSpec | undefined, rw: Record<string, string>): LocatorSpec | undefined {
  if (!spec) return spec;
  return { ...spec, strategies: spec.strategies.map((s) => rewriteStrategy(s, rw)) };
}

function rewriteCheckpoint(cp: Checkpoint | undefined, rw: Record<string, string>): Checkpoint | undefined {
  if (!cp) return cp;
  return {
    ...cp,
    anyText: cp.anyText?.map((t) => rewriteStr(t, rw)!),
    allText: cp.allText?.map((t) => rewriteStr(t, rw)!),
    roleName: rewriteStr(cp.roleName, rw),
  };
}

function rewriteStep(s: Step, rw: Record<string, string>): Step {
  return {
    ...s,
    target: rewriteLocator(s.target, rw),
    checkpoint: rewriteCheckpoint(s.checkpoint, rw),
  };
}
