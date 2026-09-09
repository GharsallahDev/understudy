import { describe, it, expect } from 'vitest';
import { recordCapability } from '../src/agent/recorder.js';
import type { DiscoveryResult } from '../src/agent/discover.js';
import type { LocatorSpec } from '../src/types/locator.js';

const role = (r: string, name: string): LocatorSpec => ({
  description: `${r} "${name}"`,
  strategies: [{ kind: 'role', role: r, name, exact: false }],
  confidence: 0.95,
});

function fakeDiscovery(): DiscoveryResult {
  return {
    success: true,
    runId: 'disc-test',
    goal: 'Look up member 100123 savings balance',
    inputs: [{ name: 'memberNumber', value: '100123', description: 'member number' }],
    entryRoute: '/members',
    model: 'gemini-3.5-flash',
    interventions: 0,
    stopReason: 'goal_met',
    successText: 'Regular Savings',
    summary: 'Read savings balance',
    finalObs: { url: 'http://localhost/members/100123', title: 'Member', elements: [], textDigest: 'Regular Savings $4,823.55' },
    actions: [
      { index: 0, tool: 'type', intent: 'Enter the member number to search', targetSpec: role('textbox', 'Member Number'), text: '100123', boundInput: 'memberNumber', risk: 'safe', preUrl: 'http://localhost/members', postUrl: 'http://localhost/members', postTextDigest: '' },
      { index: 1, tool: 'click', intent: 'Click Search to look up the member', targetSpec: role('button', 'Search'), risk: 'safe', preUrl: 'http://localhost/members', postUrl: 'http://localhost/members/100123', postTextDigest: 'Regular Savings' },
      { index: 2, tool: 'read', intent: 'Read the Regular Savings balance', targetSpec: role('cell', '$4,823.55'), outputName: 'savingsBalance', readValue: '$4,823.55', risk: 'safe', preUrl: 'http://localhost/members/100123', postUrl: 'http://localhost/members/100123', postTextDigest: '' },
    ],
    outputs: [{ name: 'savingsBalance', value: '$4,823.55', spec: role('cell', '$4,823.55') }],
  };
}

describe('recorder: run -> capability', () => {
  const cap = recordCapability(fakeDiscovery(), {
    id: 'lookup-member-savings-balance',
    name: 'Look up savings balance',
    description: 'test',
    appId: 'meridian-servicing',
    tenantId: 'meridian',
    conditionProfile: 'lookup',
  });

  it('infers typed, patterned inputs', () => {
    expect(cap.inputs[0]!.name).toBe('memberNumber');
    expect(cap.inputs[0]!.pattern).toBe('^\\d+$');
    expect(cap.inputs[0]!.example).toBe('100123');
  });

  it('parameterizes values (literal -> input binding)', () => {
    const typeStep = cap.steps.find((s) => s.action === 'type')!;
    expect(typeStep.value).toEqual({ from: 'input', input: 'memberNumber' });
  });

  it('excludes read actions from steps and turns them into typed outputs', () => {
    expect(cap.steps.every((s) => s.action !== 'read')).toBe(true);
    expect(cap.outputs[0]!.name).toBe('savingsBalance');
    expect(cap.outputs[0]!.type).toBe('number');
    expect(cap.outputs[0]!.extraction.transform).toBe('currencyToCents');
  });

  it('canonicalizes concrete routes to patterns', () => {
    expect(cap.canonicalization.some((r) => r.pattern.includes(':memberNumber'))).toBe(true);
  });

  it('attaches the global condition set and step-scoped RECORD_NOT_FOUND', () => {
    expect(cap.globalConditions).toHaveLength(4);
    const search = cap.steps.find((s) => s.action === 'click' && /search/i.test(s.intent))!;
    expect(search.expectedConditions.some((c) => c.code === 'RECORD_NOT_FOUND')).toBe(true);
  });

  it('produces an artifact that round-trips through the schema', () => {
    // recordCapability already .parse()s; assert the success checkpoint is set
    expect(cap.successCondition.anyText).toContain('Regular Savings');
    expect(cap.schemaVersion).toBe('1.0.0');
  });
});
