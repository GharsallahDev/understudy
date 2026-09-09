import type { ParamSpec } from '../types/capability.js';

/**
 * Redaction for a regulated-data environment. Two jobs:
 *  1. Never let secrets/PII reach logs or the model transcript.
 *  2. Never persist raw sensitive values into the capability artifact.
 *
 * We redact by pattern (defense in depth, catches things nobody declared) and
 * by declaration (inputs marked `sensitive` in the schema are masked by name).
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_\-]{10,}/g, '[REDACTED:api-key]'],
  [/\bAQ\.[A-Za-z0-9._\-]{10,}/g, '[REDACTED:api-key]'], // Vertex Express keys
  [/\bBearer\s+[A-Za-z0-9._\-]{10,}/gi, 'Bearer [REDACTED:token]'],
  [/\beyJ[A-Za-z0-9._\-]{10,}/g, '[REDACTED:jwt]'],
  // SSN: dashed, spaced, or dotted (the forms a UI actually renders).
  [/\b\d{3}[-.\s]\d{2}[-.\s]\d{4}\b/g, '[REDACTED:ssn]'],
];

/** Luhn check, so we only redact real card numbers and leave a 16-digit
 *  balance-in-cents or account id alone. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const SENSITIVE_KEY = /(password|passwd|secret|token|authorization|api[_-]?key|ssn|social|card|cvv|pin)/i;

export function redactString(input: string): string {
  let out = input;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  // PAN: 13–19 digit runs with optional space/dash separators (e.g. 4111 1111 1111 1111),
  // redacted only if Luhn-valid, so balances/account ids of similar length survive.
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? '[REDACTED:pan]' : m;
  });
  return out;
}

/** Deep-redact an arbitrary value for logging: masks by key name and by pattern. */
export function redactDeep(value: unknown, keyHint?: string): unknown {
  if (typeof value === 'string') {
    if (keyHint && SENSITIVE_KEY.test(keyHint)) return '[REDACTED]';
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value && typeof value === 'object') {
    // Declaration-aware: a record marked { sensitive: true } has its `value`
    // (and `example`) masked, so persisted inputs/params never leak the secret.
    const isSensitiveRecord = (value as { sensitive?: unknown }).sensitive === true;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveRecord && (k === 'value' || k === 'example') ? '[REDACTED]' : redactDeep(v, k);
    }
    return out;
  }
  return value;
}

/** Mask input values whose ParamSpec is marked sensitive; used before logging invocations. */
export function redactInputs(
  inputs: Record<string, unknown>,
  specs: ParamSpec[],
): Record<string, unknown> {
  const sensitive = new Set(specs.filter((s) => s.sensitive).map((s) => s.name));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    out[k] = sensitive.has(k) ? '[REDACTED]' : redactDeep(v, k);
  }
  return out;
}
