import { GoogleGenAI, type FunctionDeclaration, type Content, type Part } from '@google/genai';

/**
 * The LLM provider seam. The rest of the system speaks only in terms of
 * `AgentTurn` (text + tool calls) and tool results. Nothing above this file
 * knows it's Gemini. Swapping providers means reimplementing this one class.
 *
 * Auth: Vertex AI Express Mode via `vertexai: true` + an `AQ.`-prefixed API key.
 * The SDK routes through the Vertex endpoint with no project/location needed. We
 * clear GOOGLE_APPLICATION_CREDENTIALS so ADC never shadows the API-key path.
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}
export interface AgentTurn {
  text: string;
  toolCalls: ToolCall[];
}
export interface ToolResult {
  name: string;
  response: Record<string, unknown>;
}

export function createGeminiClient(apiKey: string): GoogleGenAI {
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  return new GoogleGenAI({ vertexai: true, apiKey });
}

/** Retry transient LLM failures (429/5xx/network) with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message ?? err);
      const transient = /\b(429|500|502|503|504|deadline|unavailable|overloaded|timeout|ECONNRESET|ETIMEDOUT|fetch failed)\b/i.test(msg);
      if (!transient || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.floor(300 * (i + 1))));
    }
  }
  throw lastErr;
}

/**
 * Stateful function-calling conversation. Maintains the `contents` history with
 * correct user/model alternation, including function-response turns.
 */
export class GeminiAgent {
  private history: Content[] = [];

  constructor(
    private readonly client: GoogleGenAI,
    private readonly model: string,
    private readonly system: string,
    private readonly tools: FunctionDeclaration[],
  ) {}

  private async generate(): Promise<AgentTurn> {
    const resp = await withRetry(() =>
      this.client.models.generateContent({
        model: this.model,
        contents: this.history,
        config: {
          systemInstruction: this.system,
          tools: [{ functionDeclarations: this.tools }],
          temperature: 0.15,
        },
      }),
    );
    const content = resp.candidates?.[0]?.content;
    if (content) this.history.push(content);
    const toolCalls: ToolCall[] = (resp.functionCalls ?? []).map((fc) => ({
      name: fc.name ?? '',
      args: (fc.args ?? {}) as Record<string, unknown>,
    }));
    let text = '';
    try {
      text = resp.text ?? '';
    } catch {
      text = '';
    }
    return { text, toolCalls };
  }

  /** Send a user turn (initial observation or a plain nudge) and get the model's response. */
  async sendUser(text: string): Promise<AgentTurn> {
    this.history.push({ role: 'user', parts: [{ text }] });
    return this.generate();
  }

  /** Send one function response per prior tool call, then get the model's next move. */
  async sendToolResults(results: ToolResult[]): Promise<AgentTurn> {
    const parts: Part[] = results.map((r) => ({ functionResponse: { name: r.name, response: r.response } }));
    this.history.push({ role: 'user', parts });
    return this.generate();
  }

  get transcript(): Content[] {
    return this.history;
  }
}
