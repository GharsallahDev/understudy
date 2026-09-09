import { describe, it, expect } from 'vitest';
import { parseCapability } from '../src/types/capability.js';

// Regression (F16 / review R15): the artifact schema is action-discriminated —
// a malformed step fails at PARSE, not silently at replay.
function baseCap(): any {
  return {
    schemaVersion: '1.0.0', id: 'c', version: '1.0.0', name: 'c', description: 'c',
    target: { appId: 'a', surface: 'web', tenantId: 't', entryRoute: '/x', baseUrlEnv: 'TARGET_BASE_URL' },
    scope: { allowedRoutes: ['/x'], allowedActions: ['click'] },
    inputs: [], outputs: [],
    steps: [{ id: 's1', intent: 'i', action: 'click', target: { description: 'b', strategies: [{ kind: 'role', role: 'button', name: 'Go' }], confidence: 1 }, expectedConditions: [], risk: 'safe', timeoutMs: 1000 }],
    successCondition: { description: 'ok', anyText: ['ok'] },
    globalConditions: [], canonicalization: [], tenantOverrides: [],
    provenance: { discoveredBy: { model: 'm', provider: 'google-vertex' }, discoveredAt: 'now', sourceRunId: 'r' },
    approval: { state: 'draft' },
  };
}

describe('capability schema integrity', () => {
  it('accepts a well-formed capability', () => {
    expect(() => parseCapability(baseCap())).not.toThrow();
  });

  it('rejects a click step with no target', () => {
    const bad = baseCap();
    bad.steps = [{ id: 's1', intent: 'i', action: 'click', expectedConditions: [], risk: 'safe', timeoutMs: 1000 }];
    expect(() => parseCapability(bad)).toThrow();
  });

  it('rejects a type step with no value', () => {
    const bad = baseCap();
    bad.steps = [{ id: 's1', intent: 'i', action: 'type', target: baseCap().steps[0].target, expectedConditions: [], risk: 'safe', timeoutMs: 1000 }];
    expect(() => parseCapability(bad)).toThrow();
  });

  it('rejects a navigate step with no route', () => {
    const bad = baseCap();
    bad.steps = [{ id: 's1', intent: 'i', action: 'navigate', expectedConditions: [], risk: 'safe', timeoutMs: 1000 }];
    expect(() => parseCapability(bad)).toThrow();
  });
});
