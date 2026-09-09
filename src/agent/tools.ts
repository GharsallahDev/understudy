import { Type, type FunctionDeclaration } from '@google/genai';

/**
 * The action space exposed to the model during discovery (Gemini function
 * declarations).
 *
 * Design choice: the model never writes selectors. It points at elements by the
 * ephemeral `ref` it sees in the observation, and understudy synthesizes the
 * durable locator ladder from that element's accessibility properties. This
 * keeps the model's job easy (reliable discovery) and yields high-quality,
 * model-independent locators (reliable replay). Every acting tool also requires
 * an `intent`: the "why" that becomes the reviewable step description.
 */
export const DISCOVERY_TOOLS: FunctionDeclaration[] = [
  {
    name: 'navigate',
    description: 'Navigate to a route within the target application (path only, e.g. "/members").',
    parameters: {
      type: Type.OBJECT,
      properties: {
        route: { type: Type.STRING, description: 'Path to navigate to, e.g. "/members"' },
        intent: { type: Type.STRING, description: 'Why this navigation is needed for the goal' },
      },
      required: ['route', 'intent'],
    },
  },
  {
    name: 'click',
    description: 'Click an element identified by its ref from the current observation.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: { type: Type.STRING, description: 'The ref of the element to click, e.g. "e5"' },
        intent: { type: Type.STRING, description: 'What clicking this accomplishes' },
      },
      required: ['ref', 'intent'],
    },
  },
  {
    name: 'type',
    description: 'Type text into an editable element identified by ref. If the text is one of the provided input values, set boundInput to that input name.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: { type: Type.STRING },
        text: { type: Type.STRING, description: 'The text to type' },
        boundInput: { type: Type.STRING, description: 'If this text is a task input parameter, its name (e.g. "memberNumber"); else omit' },
        sensitive: { type: Type.BOOLEAN, description: 'True if the value is a secret/PII that must never be stored' },
        intent: { type: Type.STRING },
      },
      required: ['ref', 'text', 'intent'],
    },
  },
  {
    name: 'select',
    description: 'Choose an option (by visible label) in a combobox/select identified by ref.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: { type: Type.STRING },
        option: { type: Type.STRING, description: 'The visible option label to choose' },
        boundInput: { type: Type.STRING, description: 'If the option is a task input parameter, its name; else omit' },
        intent: { type: Type.STRING },
      },
      required: ['ref', 'option', 'intent'],
    },
  },
  {
    name: 'read',
    description: 'Read the text/value of an element for data extraction. Use for outputs the caller needs, e.g. a balance.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: { type: Type.STRING },
        outputName: { type: Type.STRING, description: 'Name to record this extracted value under, e.g. "savingsBalance"' },
        sensitive: { type: Type.BOOLEAN, description: 'True if this value is regulated PII (SSN, DOB, full account/card number). It is returned to the caller but redacted from persisted evidence.' },
        intent: { type: Type.STRING },
      },
      required: ['ref', 'outputName', 'intent'],
    },
  },
  {
    name: 'finish',
    description: 'Call when the goal is fully achieved. Provide extracted outputs and a distinctive success marker visible on the final screen.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING, description: 'One line: what was accomplished' },
        successText: { type: Type.STRING, description: 'A distinctive piece of text visible on the success screen that proves success (becomes the replay checkpoint)' },
        outputs: {
          type: Type.ARRAY,
          description: 'The typed outputs the caller receives',
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              value: { type: Type.STRING },
            },
            required: ['name', 'value'],
          },
        },
      },
      required: ['summary', 'successText'],
    },
  },
  {
    name: 'escalate',
    description: 'Call ONLY if genuinely stuck and a human must intervene (dead-end, ambiguous, or a risky step you should not take autonomously).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        reason: { type: Type.STRING, description: 'Why you cannot safely proceed' },
      },
      required: ['reason'],
    },
  },
];
