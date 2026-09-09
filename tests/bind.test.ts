import { describe, it, expect } from 'vitest';
import { bindSpec } from '../src/replay/bind.js';
import type { LocatorSpec } from '../src/types/locator.js';

describe('input-bound targeting', () => {
  it('substitutes an input value into a text strategy at replay', () => {
    const spec: LocatorSpec = {
      description: 'account link',
      strategies: [{ kind: 'text', text: '13344', exact: false, fromInput: 'accountId' }],
      confidence: 0.8,
    };
    const bound = bindSpec(spec, { accountId: '15453' });
    expect(bound.strategies[0]).toMatchObject({ kind: 'text', text: '15453' });
  });

  it('substitutes an input value into a relative row anchor', () => {
    const spec: LocatorSpec = {
      description: 'balance in account row',
      strategies: [{ kind: 'relative', anchor: { text: '13344', exact: false, fromInput: 'accountId' }, relation: 'parentRow', target: {} }],
      confidence: 0.8,
    };
    const bound = bindSpec(spec, { accountId: '99999' });
    const s = bound.strategies[0]!;
    expect(s.kind === 'relative' && s.anchor.text).toBe('99999');
  });

  it('leaves unbound strategies untouched', () => {
    const spec: LocatorSpec = {
      description: 'search button',
      strategies: [{ kind: 'role', role: 'button', name: 'Search', exact: false }],
      confidence: 0.95,
    };
    expect(bindSpec(spec, { accountId: '1' })).toEqual(spec);
  });
});
