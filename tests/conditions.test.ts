import { describe, it, expect } from 'vitest';
import { signalMatches, evaluateCheckpoint } from '../src/replay/conditions.js';
import type { Observation } from '../src/types/surface.js';

function obs(partial: Partial<Observation>): Observation {
  return { url: 'http://localhost/members', title: 't', elements: [], textDigest: '', ...partial };
}

describe('condition detection', () => {
  it('matches on text', () => {
    expect(signalMatches(obs({ textDigest: 'No member found for 999' }), { anyText: ['no member found'] })).toBe(true);
    expect(signalMatches(obs({ textDigest: 'all good' }), { anyText: ['no member found'] })).toBe(false);
  });

  it('matches on role + name', () => {
    const o = obs({ elements: [{ ref: 'e0', role: 'alert', name: 'Permission denied', enabled: true, editable: false }] });
    expect(signalMatches(o, { role: 'alert', roleName: 'permission denied' })).toBe(true);
    expect(signalMatches(o, { role: 'alert', roleName: 'nope' })).toBe(false);
  });

  it('matches on http status', () => {
    expect(signalMatches(obs({ lastResponseStatus: 500 }), { httpStatusGte: 500 })).toBe(true);
    expect(signalMatches(obs({ lastResponseStatus: 200 }), { httpStatusGte: 500 })).toBe(false);
  });

  it('requires at least one positive assertion', () => {
    expect(signalMatches(obs({ textDigest: 'anything' }), {})).toBe(false);
  });

  // regression (F13 / review R13): app-error detects a 5xx OR an error page (OR-group).
  it('anyOf matches when EITHER a 5xx status OR error text is present', () => {
    const sig = { anyOf: [{ httpStatusGte: 500 }, { anyText: ['application error', 'internal server error'] }] };
    expect(signalMatches(obs({ lastResponseStatus: 500, textDigest: 'Internal Server Error' }), sig)).toBe(true);
    expect(signalMatches(obs({ lastResponseStatus: 200, textDigest: 'Application Error' }), sig)).toBe(true);
    expect(signalMatches(obs({ lastResponseStatus: 200, textDigest: 'all good' }), sig)).toBe(false);
  });
});

describe('checkpoint evaluation', () => {
  it('passes when all constraints hold', () => {
    const o = obs({ url: 'http://localhost/members/100123', textDigest: 'Regular Savings $4,823.55' });
    const r = evaluateCheckpoint(o, { description: 'on member', urlIncludes: '/members/', allText: ['Regular Savings'] });
    expect(r.ok).toBe(true);
  });

  it('fails and explains when a constraint is violated', () => {
    const o = obs({ url: 'http://localhost/members', textDigest: 'search' });
    const r = evaluateCheckpoint(o, { description: 'x', allText: ['Regular Savings'], absentText: ['search'] });
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });
});
