import type { WebSurface } from '../surface/webSurface.js';
import type { Evidence } from '../evidence.js';
import type { PolicyEngine } from '../safety/policy.js';
import type { SessionControl } from '../hitl/session.js';
import type { Observation } from '../types/surface.js';
import type { LocatorSpec } from '../types/locator.js';
import { DISCOVERY_TOOLS } from './tools.js';
import { SYSTEM_PROMPT, renderObservation } from './prompt.js';
import { inferRisk } from '../safety/policy.js';
import { redactDeep } from '../safety/redaction.js';
import { GeminiAgent, createGeminiClient, type ToolResult } from '../llm/gemini.js';

export interface DeclaredInput {
  name: string;
  value: string;
  description?: string;
  sensitive?: boolean;
}

export interface ActionRecord {
  index: number;
  tool: 'navigate' | 'click' | 'type' | 'select' | 'read';
  intent: string;
  route?: string;
  targetSpec?: LocatorSpec;
  targetDescription?: string;
  text?: string;
  option?: string;
  boundInput?: string;
  sensitive?: boolean;
  outputName?: string;
  readValue?: string;
  risk: 'safe' | 'risky';
  preUrl: string;
  postUrl: string;
  postTextDigest: string;
}

export interface DiscoveryResult {
  success: boolean;
  runId: string;
  goal: string;
  inputs: DeclaredInput[];
  entryRoute: string;
  actions: ActionRecord[];
  outputs: Array<{ name: string; value: string; spec?: LocatorSpec; sensitive?: boolean }>;
  successText?: string;
  summary?: string;
  finalObs: Observation;
  model: string;
  interventions: number;
  stopReason: 'goal_met' | 'max_steps' | 'dead_end' | 'error';
}

export interface DiscoverOptions {
  goal: string;
  inputs: DeclaredInput[];
  entryRoute: string;
  capabilityId: string;
  tenantId: string;
  runId: string;
  maxSteps?: number;
  model: string;
  apiKey: string;
  surface: WebSurface;
  evidence: Evidence;
  policy: PolicyEngine;
  session?: SessionControl;
  /** Whether the session is already authenticated (mock) vs. login is part of the flow. */
  preAuthed?: boolean;
}

/**
 * The discovery loop: observe → (LLM decides) → act, until the goal is met or a
 * stopping condition fires. The model acts by ref; we synthesize a durable
 * locator ladder for each target before acting on it (while the element is still
 * live), so the recorded artifact never depends on the model or the transcript.
 */
export async function discover(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const { goal, inputs, entryRoute, model, surface, evidence, policy, session } = opts;
  const maxSteps = opts.maxSteps ?? 25;
  const agent = new GeminiAgent(createGeminiClient(opts.apiKey), model, SYSTEM_PROMPT, DISCOVERY_TOOLS);

  const actions: ActionRecord[] = [];
  const outputs: DiscoveryResult['outputs'] = [];
  let interventions = 0;

  evidence.log('info', `Discovery start: "${goal}"`, { entryRoute, model, inputs: inputs.map((i) => i.name) });

  // Enforce policy on the entry route and install the navigation guard so every
  // subsequent navigation (link/form/redirect) is checked, not just navigate().
  surface.setNavigationGuard?.((url) => policy.checkNavigation(url));
  const entryDecision = policy.checkNavigation(entryRoute);
  if (!entryDecision.allowed) {
    evidence.log('error', `Entry route blocked by policy: ${entryRoute}`, { detail: entryDecision.reason });
    const finalObs = await surface.observe().catch(() => ({ url: '', title: '', elements: [], textDigest: '' }));
    return { success: false, runId: opts.runId, goal, inputs, entryRoute, actions, outputs, finalObs, model, interventions, stopReason: 'error' };
  }
  await surface.navigate(entryRoute);
  await surface.screenshot(evidence.nextScreenshotPath('entry'));
  let obs = await surface.observe();

  const inputLines = inputs
    .map((i) => `  - ${i.name} = ${i.sensitive ? '[provided securely; set boundInput to this name and the system injects the value]' : i.value}${i.description ? ` (${i.description})` : ''}`)
    .join('\n');
  const authNote = (opts.preAuthed ?? true)
    ? 'You are already signed in and on the entry screen. Complete the goal.'
    : 'You are on the entry screen. If the app requires signing in, do that first using the provided inputs, then complete the goal.';
  const initialText = renderObservation(
    obs,
    `GOAL: ${goal}\n\nINPUTS AVAILABLE:\n${inputLines || '  (none)'}\n\n${authNote}`,
  );

  let stopReason: DiscoveryResult['stopReason'] = 'max_steps';
  let successText: string | undefined;
  let summary: string | undefined;
  let idleTurns = 0;

  let turn = await agent.sendUser(initialText);

  for (let step = 0; step < maxSteps; step++) {
    if (turn.text.trim()) evidence.log('decision', turn.text.trim().slice(0, 200));

    if (turn.toolCalls.length === 0) {
      idleTurns++;
      if (idleTurns >= 2) { stopReason = 'dead_end'; break; }
      turn = await agent.sendUser('You did not take an action. Use one of the tools to act, or call escalate/finish.');
      continue;
    }
    idleTurns = 0;

    const results: ToolResult[] = [];
    let finished = false;

    for (const tc of turn.toolCalls) {
      const args = tc.args;
      const preUrl = obs.url;
      let resultText = '';

      try {
        switch (tc.name) {
          case 'navigate': {
            const route = String(args.route ?? '');
            const decision = policy.checkNavigation(route);
            if (!decision.allowed) {
              resultText = `BLOCKED by policy: ${decision.reason}`;
              evidence.log('warn', `Policy blocked navigate ${route}`, { detail: decision.reason });
              break;
            }
            await surface.navigate(route);
            obs = await surface.observe();
            actions.push(rec(actions.length, 'navigate', String(args.intent ?? ''), { route, preUrl, obs }));
            resultText = renderObservation(obs);
            break;
          }
          case 'click': {
            const ref = String(args.ref ?? '');
            const intent = String(args.intent ?? '');
            const spec = await surface.describeTarget(ref);
            const risk = inferRisk({ action: 'click', intent });
            const dec = policy.checkAction('click', risk);
            if (!dec.allowed) { resultText = `BLOCKED by policy: ${dec.reason}`; break; }
            // Honor the configured risk policy, don't silently flag: under
            // require_confirmation a risky action needs a human (escalate) or is
            // refused; only an explicit 'flag' policy allows it to proceed here.
            if (risk === 'risky' && dec.requiresConfirmation) {
              if (session) {
                await session.escalate({ reason: `Risky action needs approval: ${intent}`, condition: 'POLICY_BLOCKED', stepIntent: intent });
                obs = await surface.observe();
              } else {
                resultText = `BLOCKED: "${intent}" is risky and the policy requires confirmation, but no operator is available. Not executed.`;
                evidence.log('warn', `Risky action refused during discovery (require_confirmation, no operator): ${intent}`);
                break;
              }
            } else if (risk === 'risky') {
              evidence.log('decision', `Risky action flagged (policy=flag): ${intent}`);
            }
            await surface.clickRef(ref);
            obs = await surface.observe();
            actions.push(rec(actions.length, 'click', intent, { targetSpec: spec, preUrl, obs, risk }));
            resultText = renderObservation(obs);
            break;
          }
          case 'type': {
            const td = policy.checkAction('type');
            if (!td.allowed) { resultText = `BLOCKED by policy: ${td.reason}`; break; }
            const ref = String(args.ref ?? '');
            const boundInput = args.boundInput ? String(args.boundInput) : undefined;
            const decl = boundInput ? inputs.find((d) => d.name === boundInput) : undefined;
            // Secure injection: for a sensitive bound input, type the real value
            // without the model ever handling it. Otherwise use the model's text.
            const sensitive = Boolean(args.sensitive) || Boolean(decl?.sensitive);
            const text = decl?.sensitive ? decl.value : String(args.text ?? '');
            const spec = await surface.describeTarget(ref);
            await surface.typeRef(ref, text);
            obs = await surface.observe();
            actions.push(rec(actions.length, 'type', String(args.intent ?? ''), { targetSpec: spec, text: sensitive ? '[REDACTED]' : text, boundInput, sensitive, preUrl, obs }));
            resultText = renderObservation(obs);
            break;
          }
          case 'select': {
            const sd = policy.checkAction('select');
            if (!sd.allowed) { resultText = `BLOCKED by policy: ${sd.reason}`; break; }
            const ref = String(args.ref ?? '');
            const option = String(args.option ?? '');
            const boundInput = args.boundInput ? String(args.boundInput) : undefined;
            const spec = await surface.describeTarget(ref);
            await surface.selectRef(ref, option);
            obs = await surface.observe();
            actions.push(rec(actions.length, 'select', String(args.intent ?? ''), { targetSpec: spec, option, boundInput, preUrl, obs }));
            resultText = renderObservation(obs);
            break;
          }
          case 'read': {
            const rd = policy.checkAction('read');
            if (!rd.allowed) { resultText = `BLOCKED by policy: ${rd.reason}`; break; }
            const ref = String(args.ref ?? '');
            const outputName = String(args.outputName ?? 'value');
            const outSensitive = Boolean(args.sensitive);
            const spec = await surface.describeTarget(ref);
            const value = await surface.readRef(ref);
            actions.push(rec(actions.length, 'read', String(args.intent ?? ''), { targetSpec: spec, outputName, readValue: outSensitive ? '[REDACTED]' : value, sensitive: outSensitive, preUrl, obs }));
            outputs.push({ name: outputName, value, spec, sensitive: outSensitive });
            evidence.log('action', `read ${outputName}`, { detail: outSensitive ? '[REDACTED]' : value.slice(0, 60) });
            // Give the model back a masked confirmation for sensitive reads.
            resultText = `Read "${outputName}" = "${outSensitive ? '[REDACTED]' : value}".\n${renderObservation(obs)}`;
            break;
          }
          case 'finish': {
            summary = String(args.summary ?? '');
            successText = String(args.successText ?? '');
            for (const o of (args.outputs as Array<{ name: string; value: string }>) ?? []) {
              if (!outputs.find((x) => x.name === o.name)) outputs.push({ name: o.name, value: o.value });
            }
            finished = true;
            resultText = 'Recorded. Goal complete.';
            evidence.log('info', `Discovery finish: ${summary}`, { detail: successText });
            break;
          }
          case 'escalate': {
            interventions++;
            const reason = String(args.reason ?? 'agent requested help');
            if (session) {
              await session.escalate({ reason, condition: 'CHECKPOINT_FAILED', stepIntent: reason });
              obs = await surface.observe();
              resultText = `A human intervened and handed control back. Continue.\n${renderObservation(obs)}`;
            } else {
              resultText = `No operator available; escalation not possible. Try another approach.`;
            }
            break;
          }
          default:
            resultText = `Unknown tool ${tc.name}`;
        }
      } catch (err) {
        resultText = `Action failed: ${(err as Error).message}`;
        evidence.log('error', `Action ${tc.name} failed`, { detail: (err as Error).message });
      }

      if (['click', 'type', 'select', 'navigate'].includes(tc.name)) {
        evidence.log('action', `${tc.name}: ${String(args.intent ?? '')}`);
        await surface.screenshot(evidence.nextScreenshotPath(tc.name));
      }
      results.push({ name: tc.name, response: { result: resultText } });
    }

    if (finished) { stopReason = 'goal_met'; break; }
    turn = await agent.sendToolResults(results);
  }

  const finalObs = await surface.observe();
  // Scrub declared-sensitive values (credentials and sensitive read outputs like an
  // SSN read off screen) from the transcript by exact match, then apply pattern
  // redaction, so declared outputs are covered and not just declared inputs.
  const sensitiveValues = [
    ...inputs.filter((i) => i.sensitive).map((i) => i.value),
    ...outputs.filter((o) => o.sensitive).map((o) => o.value),
  ].filter((v) => v && v.length >= 3);
  let txJson = JSON.stringify(agent.transcript);
  for (const v of sensitiveValues) txJson = txJson.split(v).join('[REDACTED]');
  evidence.writeJson('discovery-transcript.json', redactDeep(JSON.parse(txJson)));

  return {
    success: stopReason === 'goal_met',
    runId: opts.runId,
    goal,
    inputs,
    entryRoute,
    actions,
    outputs,
    successText,
    summary,
    finalObs,
    model,
    interventions,
    stopReason,
  };
}

function rec(
  index: number,
  tool: ActionRecord['tool'],
  intent: string,
  extra: Partial<ActionRecord> & { preUrl: string; obs: Observation },
): ActionRecord {
  const { preUrl, obs, ...rest } = extra;
  return {
    index,
    tool,
    intent,
    risk: 'safe',
    preUrl,
    postUrl: obs.url,
    postTextDigest: obs.textDigest,
    ...rest,
  };
}
