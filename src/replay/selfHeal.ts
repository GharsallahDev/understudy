import { Type, type FunctionDeclaration } from '@google/genai';
import { GeminiAgent, createGeminiClient } from '../llm/gemini.js';
import { renderObservation } from '../agent/prompt.js';
import { inferRisk } from '../safety/policy.js';
import type { WebSurface } from '../surface/webSurface.js';
import type { Step } from '../types/capability.js';
import type { LocatorSpec } from '../types/locator.js';

/**
 * Bounded, opt-in self-healing.
 *
 * The two failure modes worth fearing (both flagged in prior-art post-mortems)
 * are (a) "replay that secretly re-calls the model on every run" and (b) "healed
 * steps that silently drift intent." So healing here is deliberately narrow:
 *
 *   - It runs only when a locator is unresolved and the caller opted in.
 *   - It makes exactly one model call for the one broken step.
 *   - The model may only pick an existing element by ref (it cannot invent
 *     selectors, change the action, or choose a riskier control).
 *   - The healed locator is re-synthesized deterministically and must resolve
 *     uniquely before it is used; otherwise healing fails closed.
 *   - Every heal is recorded and emitted as a proposed artifact patch for human
 *     review. It does not silently rewrite the capability.
 */
const HEAL_TOOLS: FunctionDeclaration[] = [
  {
    name: 'pick_element',
    description: 'Identify the single element that fulfills the SAME intent as the original, now-missing target.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: { type: Type.STRING, description: 'The ref of the matching element from the current observation' },
        reason: { type: Type.STRING, description: 'Why this element matches the original intent' },
      },
      required: ['ref', 'reason'],
    },
  },
  {
    name: 'cannot_heal',
    description: 'Declare that no element on the current screen safely matches the original intent.',
    parameters: { type: Type.OBJECT, properties: { reason: { type: Type.STRING } }, required: ['reason'] },
  },
];

const HEAL_SYSTEM = `You are understudy's REPAIR tool for a deterministic automation that just failed.
A recorded step could no longer find its target because the UI changed (drift). Your ONLY job is to
identify which element on the CURRENT screen fulfills the SAME intent as the original step.

Rules:
- Pick exactly one element by its ref, or call cannot_heal.
- The replacement must perform the SAME action toward the SAME goal. Never pick a different, destructive,
  or riskier control (e.g. do not pick "Delete" when the original was "Open").
- If nothing clearly matches, call cannot_heal; failing safely is correct.`;

export interface HealOutcome {
  spec: LocatorSpec;
  ref: string;
  reason: string;
}

export async function healStep(opts: {
  surface: WebSurface;
  step: Step;
  apiKey: string;
  model: string;
}): Promise<HealOutcome | null> {
  const { surface, step, apiKey, model } = opts;
  const obs = await surface.observe();
  const agent = new GeminiAgent(createGeminiClient(apiKey), model, HEAL_SYSTEM, HEAL_TOOLS);
  const prompt = `${renderObservation(obs)}

ORIGINAL STEP INTENT: ${step.intent}
ORIGINAL ACTION: ${step.action}
ORIGINAL TARGET (now missing): ${step.target?.description ?? '(none)'}

Pick the element on the current screen that matches the original intent, or call cannot_heal.`;
  const turn = await agent.sendUser(prompt);
  const call = turn.toolCalls[0];
  if (!call || call.name !== 'pick_element') return null;
  const ref = String(call.args.ref ?? '');
  if (!ref) return null;

  let spec: LocatorSpec;
  try {
    spec = await surface.describeTarget(ref);
  } catch {
    return null;
  }

  // Independent safety check (not just the prompt): recompute the candidate's risk
  // from its own observable label. Never heal a non-risky step to a control that
  // looks destructive (e.g. "Delete account" for a "View account" step). The model
  // could be wrong or adversarial; the prohibition must be enforced in code.
  const el = obs.elements.find((e) => e.ref === ref);
  const candidateLabel = el?.name || el?.text || spec.description;
  const candidateRisk = inferRisk({ action: step.action, intent: candidateLabel });
  if (candidateRisk === 'risky' && step.risk !== 'risky') return null;

  // fail closed: the healed locator must resolve to exactly one element now
  const r = await surface.resolve(spec);
  if (!r.ok) return null;
  return { spec, ref, reason: String(call.args.reason ?? '') };
}
