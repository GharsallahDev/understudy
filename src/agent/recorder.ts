import { createHash } from 'node:crypto';
import type { Capability, Step, ParamSpec, OutputSpec, Checkpoint } from '../types/capability.js';
import { ARTIFACT_SCHEMA_VERSION, capability as capabilitySchema } from '../types/capability.js';
import type { ExpectedCondition } from '../types/conditions.js';
import type { LocatorSpec } from '../types/locator.js';
import type { ActionRecord, DeclaredInput, DiscoveryResult } from './discover.js';
import { conditions, globalConditionSet } from './conditionLibrary.js';
import { inferRisk } from '../safety/policy.js';

export interface RecordMeta {
  id: string;
  name: string;
  description: string;
  version?: string;
  appId: string;
  vendorProduct?: string;
  tenantId: string;
  /** Which curated condition set to attach. */
  conditionProfile?: 'lookup' | 'create' | 'auto';
  /** Declared output contract: output names are normalized to these (by order),
   *  so the capability's contract is caller-defined, not model-whim. */
  outputNames?: string[];
  /** The operator-sanctioned global allowlist discovery ran under; recorded so
   *  replay re-applies the same bound (then intersects with the capability scope). */
  operatorPolicy?: { allowedRoutes: string[]; allowedActions: import('../types/capability.js').ActionKind[] };
}

/**
 * Compile a successful discovery run into a durable capability artifact.
 *
 * This is where a raw action trace becomes a reusable contract:
 *  - typed inputs are inferred from the declared task inputs,
 *  - literal values that equal an input are rewritten to input bindings
 *    (parameterization) and concrete routes are canonicalized (/x/123 -> /x/:id),
 *  - every target keeps the durable locator ladder synthesized at discovery time,
 *  - checkpoints are attached where state provably changed,
 *  - known runtime conditions are attached from the condition library,
 *  - outputs carry their own extraction locator + transform,
 *  - provenance links (does not embed) the transcript by digest.
 *
 * The artifact is validated against the Zod schema before return, so a malformed
 * recording fails loudly here rather than at replay.
 */
export function recordCapability(discovery: DiscoveryResult, meta: RecordMeta): Capability {
  const inputs = buildInputs(discovery.inputs);
  const profile = meta.conditionProfile ?? 'auto';

  const steps: Step[] = [];
  const routesTouched = new Set<string>([templatePath(discovery.entryRoute, discovery.inputs)]);

  for (const a of discovery.actions) {
    if (a.tool === 'read') continue; // reads become outputs, not steps
    const stepId = `s${steps.length + 1}`;
    const step = buildStep(stepId, a, discovery.inputs, profile);
    if (a.tool === 'navigate' && a.route) routesTouched.add(templatePath(a.route, discovery.inputs));
    if (a.postUrl) routesTouched.add(templatePath(pathOf(a.postUrl), discovery.inputs));
    steps.push(step);
  }

  const successCondition: Checkpoint = buildSuccessCondition(discovery);

  const outputs = buildOutputs(discovery, meta.outputNames);
  const canonicalization = buildCanonicalization(discovery);

  const draft: Capability = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    id: meta.id,
    version: meta.version ?? '1.0.0',
    name: meta.name,
    description: meta.description,
    target: {
      appId: meta.appId,
      surface: 'web',
      vendorProduct: meta.vendorProduct,
      tenantId: meta.tenantId,
      entryRoute: discovery.entryRoute,
      baseUrlEnv: 'TARGET_BASE_URL',
      operatorPolicy: meta.operatorPolicy,
    },
    scope: {
      allowedRoutes: [...routesTouched].sort(),
      allowedActions: [...new Set(steps.map((s) => s.action))],
    },
    inputs,
    outputs,
    steps,
    successCondition,
    globalConditions: globalConditionSet(),
    canonicalization,
    tenantOverrides: [],
    provenance: {
      discoveredBy: { model: discovery.model, provider: 'google-vertex' },
      discoveredAt: new Date().toISOString(),
      sourceRunId: discovery.runId,
      transcriptDigest: sha256(JSON.stringify(discovery.actions)),
    },
    approval: { state: 'draft' },
  };

  // Validate: a malformed recording must fail here, not at replay time.
  return capabilitySchema.parse(draft);
}

// --- inputs -----------------------------------------------------------------

function buildInputs(declared: DeclaredInput[]): ParamSpec[] {
  return declared.map((i) => {
    const numeric = /^\d+$/.test(i.value);
    return {
      name: i.name,
      type: numeric ? 'string' : 'string', // keep string; ids are strings even if all-digits
      description: i.description ?? `Input parameter ${i.name}`,
      required: true,
      pattern: numeric ? '^\\d+$' : undefined,
      example: i.sensitive ? undefined : i.value,
      sensitive: Boolean(i.sensitive),
    } satisfies ParamSpec;
  });
}

// --- steps ------------------------------------------------------------------

function buildStep(id: string, a: ActionRecord, inputs: DeclaredInput[], profile: RecordMeta['conditionProfile']): Step {
  const base = {
    id,
    intent: a.intent,
    expectedConditions: stepConditions(a, profile),
    timeoutMs: 10_000,
  };
  const boundTarget = a.targetSpec ? bindTargetInputs(a.targetSpec, inputs) : undefined;

  switch (a.tool) {
    case 'navigate':
      return {
        ...base,
        action: 'navigate',
        route: templatePath(a.route ?? '/', inputs),
        risk: 'safe',
        checkpoint: urlCheckpoint(a, inputs),
      };
    case 'click': {
      const risk = a.risk === 'risky' ? 'risky' : inferRisk({ action: 'click', intent: a.intent });
      return {
        ...base,
        action: 'click',
        target: boundTarget,
        risk,
        checkpoint: changedUrl(a) ? urlCheckpoint(a, inputs) : undefined,
      };
    }
    case 'type':
      return {
        ...base,
        action: 'type',
        target: boundTarget,
        value: valueSourceFor(a, inputs),
        risk: 'safe',
      };
    case 'select':
      return {
        ...base,
        action: 'select',
        target: boundTarget,
        value: valueSourceForSelect(a, inputs),
        risk: 'safe',
      };
    default:
      return { ...base, action: 'assert', risk: 'safe' };
  }
}

function valueSourceFor(a: ActionRecord, inputs: DeclaredInput[]): Step['value'] {
  const bound = a.boundInput ?? matchInput(a.text ?? '', inputs);
  if (bound) return { from: 'input', input: bound };
  if (a.sensitive) return { from: 'literal', value: '[REDACTED]', sensitive: true };
  return { from: 'literal', value: a.text ?? '', sensitive: false };
}
function valueSourceForSelect(a: ActionRecord, inputs: DeclaredInput[]): Step['value'] {
  const bound = a.boundInput ?? matchInput(a.option ?? '', inputs);
  if (bound) return { from: 'input', input: bound };
  return { from: 'literal', value: a.option ?? '', sensitive: false };
}

function matchInput(value: string, inputs: DeclaredInput[]): string | undefined {
  return inputs.find((i) => !i.sensitive && i.value && i.value === value)?.name;
}

/**
 * Bind a target to input parameters: where a text/relative-anchor value equals an
 * input value, mark it `fromInput` so replay locates the control by the caller's
 * value (e.g. "the row for account {accountId}"). This turns a one-off
 * "read account 13344" recording into a reusable "read account {accountId}".
 */
function bindTargetInputs(spec: LocatorSpec, inputs: DeclaredInput[]): LocatorSpec {
  return {
    ...spec,
    strategies: spec.strategies.map((s) => {
      if (s.kind === 'text') {
        const name = matchInput(s.text, inputs);
        return name ? { ...s, fromInput: name } : s;
      }
      if (s.kind === 'relative') {
        const name = matchInput(s.anchor.text, inputs);
        return name ? { ...s, anchor: { ...s.anchor, fromInput: name } } : s;
      }
      return s;
    }),
  };
}

// --- conditions per step ----------------------------------------------------

function stepConditions(a: ActionRecord, profile: RecordMeta['conditionProfile']): ExpectedCondition[] {
  const out: ExpectedCondition[] = [];
  const intent = a.intent.toLowerCase();
  const isSearch = /search|find|look ?up|member number|account number|lookup/.test(intent);
  const isSubmit = /continue|review|submit|open|confirm|create|save|next/.test(intent);
  const isLogin = /log ?in|sign ?in|authenticate/.test(intent);

  if (a.tool === 'click' && isLogin) out.push(conditions.loginError());

  if (a.tool === 'click' || a.tool === 'navigate') {
    if (profile === 'lookup' || profile === 'auto') {
      if (isSearch) out.push(conditions.recordNotFound('member'));
    }
    if (profile === 'create' || profile === 'auto') {
      if (isSubmit) {
        out.push(conditions.validationError());
        out.push(conditions.permissionDenied());
      }
    }
  }
  return out;
}

// --- success predicate ------------------------------------------------------

/**
 * Build a parameter-independent, identity-validating success predicate.
 *
 * The bug this fixes (F08): the model's success marker is often run-specific data
 * (e.g. the discovered member's name), which then only passes for that one input.
 * Instead we assert the requested inputs that appear on the final screen, using
 * `{{name}}` tokens the replay engine substitutes with the caller's values, so
 * "did we land on the right entity?" is checked for any input, not just the one
 * we recorded. The model's free-text marker is kept only as a fallback when no
 * input is echoed on the success screen.
 */
function buildSuccessCondition(d: DiscoveryResult): Checkpoint {
  const text = d.finalObs.textDigest ?? '';
  const idTokens = d.inputs
    .filter((i) => !i.sensitive && i.value && text.includes(i.value))
    .map((i) => `{{${i.name}}}`);
  const path = pathOf(d.finalObs.url);
  const stable = stableUrlFragment(path, d.inputs);
  const urlPart = stable && stable.replace(/\//g, '').length > 0 ? { urlIncludes: stable } : {};
  if (idTokens.length) {
    return {
      description: d.summary ? `Reached the success screen showing the requested inputs (${d.summary})` : 'Reached success screen (identity-validated)',
      allText: idTokens,
      ...urlPart,
    };
  }
  return {
    description: d.summary ? `Reached: ${d.summary}` : 'Goal success screen reached',
    anyText: d.successText ? [d.successText] : undefined,
    ...urlPart,
  };
}

// --- checkpoints ------------------------------------------------------------

function changedUrl(a: ActionRecord): boolean {
  return pathOf(a.preUrl) !== pathOf(a.postUrl);
}
function urlCheckpoint(a: ActionRecord, inputs: DeclaredInput[]): Checkpoint {
  return {
    description: `URL is at ${templatePath(pathOf(a.postUrl), inputs)}`,
    urlIncludes: stableUrlFragment(pathOf(a.postUrl), inputs),
  };
}
/**
 * A stable substring of the post path that is actually present in the concrete
 * URL (so `urlIncludes` holds for any input). We anchor on the path after the
 * last variable segment (e.g. "/subaccounts/new"); if the variable is the tail
 * (e.g. "/members/100123"), we fall back to the stable prefix ("/members/").
 */
function stableUrlFragment(path: string, inputs: DeclaredInput[]): string {
  let idx = -1;
  let valLen = 0;
  for (const i of inputs) {
    if (!i.value) continue;
    const at = path.lastIndexOf(i.value);
    if (at > idx) { idx = at; valLen = i.value.length; }
  }
  if (idx < 0) return path; // no variable in path -> whole path is stable
  const suffix = path.slice(idx + valLen); // e.g. "/subaccounts/new"
  if (suffix.replace(/\//g, '').length > 0) return suffix;
  const prefix = path.slice(0, idx); // e.g. "/members/"
  return prefix.length > 1 ? prefix : path;
}

// --- outputs ----------------------------------------------------------------

function buildOutputs(discovery: DiscoveryResult, declaredNames?: string[]): OutputSpec[] {
  const out: OutputSpec[] = [];
  for (const o of discovery.outputs) {
    // Prefer the extraction target the model pointed at; otherwise synthesize one
    // from the final screen by finding the row/element that contains the value.
    const raw = o.spec ?? synthesizeExtraction(o.value, discovery);
    if (!raw) continue;
    // bind input-identified anchors first, then stabilize the rest
    const target = stabilizeExtractionTarget(bindTargetInputs(raw, discovery.inputs), discovery.inputs);
    const isCurrency = /[$€£]/.test(o.value) || /balance|amount|deposit/i.test(o.name);
    const isAccountNumber = /^\d+-\d+$/.test(o.value.trim()) || /account.*number|new account/i.test(o.name);
    const isNumeric = /^\s*[$€£]?[\d,]+(\.\d+)?\s*$/.test(o.value);
    // clean model-chosen names to a stable contract (drop redundant suffixes)
    const cleanName = o.name.replace(/(Raw|Value|Text)$/i, '') || o.name;
    out.push({
      name: cleanName,
      type: isCurrency || (isNumeric && !isAccountNumber) ? 'number' : 'string',
      description: `Extracted ${o.name}`,
      sensitive: Boolean(o.sensitive),
      extraction: {
        target,
        attribute: 'text',
        transform: isCurrency ? 'currencyToCents' : isNumeric && !isAccountNumber ? 'number' : 'trim',
        // pull the salient token out of a larger text region (row / status banner)
        pattern: isCurrency ? '(-?\\$[\\d,]+\\.\\d{2})' : isAccountNumber ? '(\\d+-\\d+)' : undefined,
      },
    });
  }
  // Honor the declared output contract: rename by order to the caller's names.
  if (declaredNames) out.forEach((o, i) => { if (declaredNames[i]) o.name = declaredNames[i]!; });
  return out;
}

/**
 * Make an extraction target parameter-independent: drop any locator name/text
 * that contains an input value (it would only match this one invocation), and
 * reduce status/alert banners to a role-only locator (unique on a result screen).
 * The value itself is recovered from the region text via the output's pattern.
 */
function stabilizeExtractionTarget(spec: LocatorSpec, inputs: DeclaredInput[]): LocatorSpec {
  const values = inputs.filter((i) => !i.sensitive && i.value).map((i) => i.value);
  const contaminated = (s?: string) => !!s && values.some((v) => s.includes(v));
  const strategies = spec.strategies
    .map((st) => {
      if (st.kind === 'role') {
        if ((st.role === 'status' || st.role === 'alert')) return { ...st, name: undefined }; // banner: role-only is unique
        if (contaminated(st.name)) return { ...st, name: undefined };
        return st;
      }
      // keep input-bound strategies: they generalize via the input, not strip
      if (st.kind === 'text' && st.fromInput) return st;
      if (st.kind === 'relative' && st.anchor.fromInput) return st;
      if (st.kind === 'text' && contaminated(st.text)) return null;
      if (st.kind === 'relative' && contaminated(st.anchor.text)) return null;
      return st;
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
  const finalStrategies = strategies.length ? strategies : [{ kind: 'role' as const, role: 'status', exact: false }];
  return { ...spec, strategies: finalStrategies, robustnessNotes: (spec.robustnessNotes ?? '') + ' Stabilized for extraction: input-specific names removed.' };
}

/** Find the row/element on the final screen that contains the value, anchor on its label. */
function synthesizeExtraction(value: string, discovery: DiscoveryResult): LocatorSpec | undefined {
  const norm = value.trim();
  const el = discovery.finalObs.elements.find((e) => (e.rowText ?? e.text ?? '').includes(norm));
  if (el?.role === 'row' && el.name) {
    return {
      description: `row "${el.name}" (synthesized extraction)`,
      strategies: [{ kind: 'relative', anchor: { text: el.name, exact: false }, relation: 'parentRow', target: {} }],
      confidence: 0.8,
      robustnessNotes: `Synthesized from the final screen: anchored on stable row label "${el.name}"; value read from row text.`,
    };
  }
  return undefined;
}

// --- canonicalization -------------------------------------------------------

function buildCanonicalization(discovery: DiscoveryResult): Capability['canonicalization'] {
  const rules: Capability['canonicalization'] = [];
  const seen = new Set<string>();
  for (const a of discovery.actions) {
    const concretePath = pathOf(a.postUrl);
    for (const i of discovery.inputs) {
      if (!i.value || i.sensitive) continue;
      if (concretePath.includes(i.value) && !seen.has(concretePath)) {
        seen.add(concretePath);
        rules.push({
          concrete: concretePath,
          pattern: concretePath.replaceAll(i.value, `:${i.name}`),
          boundTo: i.name,
        });
      }
    }
  }
  return rules;
}

// --- helpers ----------------------------------------------------------------

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
function templatePath(path: string, inputs: DeclaredInput[]): string {
  let p = pathOf(path);
  for (const i of inputs) if (i.value && !i.sensitive) p = p.replaceAll(i.value, `:${i.name}`);
  return p;
}
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
