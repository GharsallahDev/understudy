import { describe, it, expect } from 'vitest';
import { applyTenantOverrides } from '../src/replay/tenant.js';
import type { Capability } from '../src/types/capability.js';

function baseCap(): Capability {
  return {
    schemaVersion: '1.0.0',
    id: 'c', version: '1.0.0', name: 'c', description: 'c',
    target: { appId: 'a', surface: 'web', tenantId: 'meridian', entryRoute: '/members', baseUrlEnv: 'TARGET_BASE_URL' },
    scope: { allowedRoutes: ['/members/**'], allowedActions: ['type', 'click'] },
    inputs: [], outputs: [],
    steps: [
      { id: 's1', intent: 'enter member', action: 'type', target: { description: 'field', strategies: [{ kind: 'role', role: 'textbox', name: 'Member Number', exact: false }], confidence: 0.9 }, value: { from: 'input', input: 'memberNumber' }, expectedConditions: [], risk: 'safe', timeoutMs: 10000 },
      { id: 's2', intent: 'search', action: 'click', target: { description: 'btn', strategies: [{ kind: 'role', role: 'button', name: 'Search', exact: false }], confidence: 0.9 }, expectedConditions: [], risk: 'safe', timeoutMs: 10000 },
    ],
    successCondition: { description: 'ok', anyText: ['Member'] },
    globalConditions: [], canonicalization: [],
    tenantOverrides: [
      {
        tenantId: 'cascade',
        note: 'same vendor product, different labels + extra verify step',
        labelRewrites: { 'Member Number': 'Account Number', Search: 'Find Member' },
        skipStepIds: [],
        insertSteps: [
          { afterStepId: 's2', step: { id: 's-verify', intent: 'verify identity', action: 'click', target: { description: 'verify', strategies: [{ kind: 'role', role: 'button', name: 'Identity Verified', exact: false }], confidence: 0.9 }, expectedConditions: [], risk: 'safe', timeoutMs: 10000 } },
        ],
      },
    ],
    provenance: { discoveredBy: { model: 'm', provider: 'google-vertex' }, discoveredAt: 'now', sourceRunId: 'r' },
    approval: { state: 'draft' },
  };
}

describe('cross-tenant overrides', () => {
  it('returns the base steps unchanged for the base tenant', () => {
    const steps = applyTenantOverrides(baseCap(), 'meridian');
    expect(steps).toHaveLength(2);
    const first = steps[0]!.target!.strategies[0]!;
    expect(first.kind === 'role' && first.name).toBe('Member Number');
  });

  it('rewrites labels and inserts steps for another tenant on the same product', () => {
    const steps = applyTenantOverrides(baseCap(), 'cascade');
    expect(steps).toHaveLength(3); // extra verify step inserted
    const s1 = steps[0]!.target!.strategies[0]!;
    expect(s1.kind === 'role' && s1.name).toBe('Account Number'); // relabelled
    const s2 = steps[1]!.target!.strategies[0]!;
    expect(s2.kind === 'role' && s2.name).toBe('Find Member');
    expect(steps[2]!.id).toBe('s-verify');
  });
});
