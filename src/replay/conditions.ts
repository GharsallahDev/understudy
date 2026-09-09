import type { Observation } from '../types/surface.js';
import type { ConditionSignal } from '../types/conditions.js';
import type { Checkpoint } from '../types/capability.js';

/**
 * Deterministic condition + checkpoint evaluation over an Observation. No model,
 * no heuristics beyond simple, explainable text/role/url/status matching. This
 * is what keeps replay reproducible.
 */

function hay(obs: Observation): string {
  return (obs.textDigest + ' ' + obs.elements.map((e) => `${e.name} ${e.text ?? ''}`).join(' ')).toLowerCase();
}

export function signalMatches(obs: Observation, sig: ConditionSignal): boolean {
  // OR-group: match if any sub-signal matches (e.g. a 5xx status or an error banner).
  if (sig.anyOf && sig.anyOf.length) {
    if (sig.anyOf.some((s) => signalMatches(obs, s))) return true;
    // if anyOf is the only thing specified, it decides the whole signal
    if (!sig.anyText && !sig.role && !sig.urlIncludes && sig.httpStatusGte == null) return false;
  }
  const text = hay(obs);
  if (sig.anyText && !sig.anyText.some((t) => text.includes(t.toLowerCase()))) return false;
  if (sig.role) {
    const hit = obs.elements.some(
      (e) => e.role === sig.role && (!sig.roleName || (e.name + ' ' + (e.text ?? '')).toLowerCase().includes(sig.roleName.toLowerCase())),
    );
    if (!hit) return false;
  }
  if (sig.urlIncludes && !obs.url.toLowerCase().includes(sig.urlIncludes.toLowerCase())) return false;
  if (sig.httpStatusGte != null && (obs.lastResponseStatus ?? 0) < sig.httpStatusGte) return false;
  // require at least one positive assertion to have been specified
  return Boolean(sig.anyText || sig.role || sig.urlIncludes || sig.httpStatusGte != null);
}

export interface CheckpointResult {
  ok: boolean;
  reasons: string[];
}

export function evaluateCheckpoint(obs: Observation, cp: Checkpoint): CheckpointResult {
  const reasons: string[] = [];
  const text = hay(obs);
  if (cp.urlIncludes && !obs.url.toLowerCase().includes(cp.urlIncludes.toLowerCase())) {
    reasons.push(`url "${obs.url}" does not include "${cp.urlIncludes}"`);
  }
  if (cp.anyText && !cp.anyText.some((t) => text.includes(t.toLowerCase()))) {
    reasons.push(`none of [${cp.anyText.join(', ')}] present`);
  }
  if (cp.allText) {
    for (const t of cp.allText) if (!text.includes(t.toLowerCase())) reasons.push(`missing required text "${t}"`);
  }
  if (cp.absentText) {
    for (const t of cp.absentText) if (text.includes(t.toLowerCase())) reasons.push(`unexpected text present "${t}"`);
  }
  if (cp.role) {
    const hit = obs.elements.some(
      (e) => e.role === cp.role && (!cp.roleName || (e.name + ' ' + (e.text ?? '')).toLowerCase().includes(cp.roleName!.toLowerCase())),
    );
    if (!hit) reasons.push(`no ${cp.role}${cp.roleName ? ` "${cp.roleName}"` : ''} present`);
  }
  return { ok: reasons.length === 0, reasons };
}
