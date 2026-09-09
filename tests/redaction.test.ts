import { describe, it, expect } from 'vitest';
import { redactString, redactDeep, redactInputs } from '../src/safety/redaction.js';
import { redactResultForEvidence } from '../src/replay/replay.js';
import type { ParamSpec, Capability } from '../src/types/capability.js';
import type { ReplayResult } from '../src/types/result.js';

describe('redaction', () => {
  it('masks api keys, tokens, SSNs, and PANs by pattern', () => {
    expect(redactString('key sk-ant-abc123DEF456ghijk more')).toContain('[REDACTED:api-key]');
    expect(redactString('Authorization: Bearer abcDEF123456ghijkl')).toContain('[REDACTED:token]');
    expect(redactString('ssn 123-45-6789')).toContain('[REDACTED:ssn]');
    expect(redactString('card 4111111111111111')).toContain('[REDACTED:pan]');
  });

  // regression (audit): PAN in the formats a UI actually renders, Luhn-checked.
  it('masks spaced/dashed card numbers (Luhn-valid) but NOT lookalike digit runs', () => {
    expect(redactString('PAN 4111 1111 1111 1111 ok')).toContain('[REDACTED:pan]');
    expect(redactString('PAN 4111-1111-1111-1111 ok')).toContain('[REDACTED:pan]');
    // a 16-digit balance-in-cents that is NOT a valid card must survive (no over-redaction)
    expect(redactString('balance 1234567890123456 cents')).toContain('1234567890123456');
    expect(redactString('balance 1234567890123456 cents')).not.toContain('[REDACTED:pan]');
  });

  it('masks SSNs in spaced and dotted forms too', () => {
    expect(redactString('ssn 123 45 6789')).toContain('[REDACTED:ssn]');
    expect(redactString('ssn 123.45.6789')).toContain('[REDACTED:ssn]');
  });

  it('deep-redacts by sensitive key name', () => {
    const out = redactDeep({ password: 'hunter2', nested: { token: 'zzz', ok: 'visible' } }) as any;
    expect(out.password).toBe('[REDACTED]');
    expect(out.nested.token).toBe('[REDACTED]');
    expect(out.nested.ok).toBe('visible');
  });

  // regression (F01 / review R10): a { sensitive: true } record masks its value.
  it('masks the value of a declaration-sensitive record (not just by key name)', () => {
    const out = JSON.stringify(redactDeep({ inputs: [{ name: 'password', sensitive: true, value: 'REVIEW_SECRET', example: 'REVIEW_SECRET' }] }));
    expect(out).not.toContain('REVIEW_SECRET');
  });

  // regression (audit): declaration now covers OUTPUTS — a sensitive read value is
  // masked in persisted evidence, while the in-memory result keeps it for the caller.
  it('masks declared-sensitive OUTPUT values in evidence, not in the returned result', () => {
    const cap = { outputs: [{ name: 'ssn', sensitive: true }, { name: 'balance', sensitive: false }] } as unknown as Capability;
    const result = { status: 'success', outputs: { ssn: '123-45-6789', balance: 482355 } } as unknown as ReplayResult;
    const forEvidence = redactResultForEvidence(result, cap);
    expect(forEvidence.status === 'success' && forEvidence.outputs.ssn).toBe('[REDACTED]');
    expect(forEvidence.status === 'success' && forEvidence.outputs.balance).toBe(482355);
    // the original (returned to the caller) is untouched
    expect(result.status === 'success' && result.outputs.ssn).toBe('123-45-6789');
  });

  it('masks declared-sensitive inputs by name', () => {
    const specs: ParamSpec[] = [
      { name: 'memberNumber', type: 'string', description: '', required: true, sensitive: false },
      { name: 'pin', type: 'string', description: '', required: true, sensitive: true },
    ];
    const out = redactInputs({ memberNumber: '100123', pin: '4417' }, specs);
    expect(out.memberNumber).toBe('100123');
    expect(out.pin).toBe('[REDACTED]');
  });
});
