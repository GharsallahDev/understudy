import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader (no dependency). Only sets vars that aren't already set. */
function loadDotenv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotenv();

export const config = {
  /** Vertex AI Express Mode API key (starts with "AQ."). Read from GEMINI_API_KEY / GOOGLE_API_KEY. */
  geminiApiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.VERTEX_API_KEY ?? '',
  /** Default discovery model. Gemini 3.5 Flash is agentic + fast; bump to gemini-3.1-pro-preview for harder flows. */
  model: process.env.UNDERSTUDY_MODEL ?? 'gemini-3.5-flash',
  targetBaseUrl: (process.env.TARGET_BASE_URL ?? 'http://localhost:3100').replace(/\/$/, ''),
  operatorPort: Number(process.env.OPERATOR_PORT ?? 4600),
  catalogPort: Number(process.env.CATALOG_PORT ?? 4700),
  headless: process.env.HEADLESS === '1',
  capabilitiesDir: resolve(process.cwd(), 'capabilities'),
  evidenceDir: resolve(process.cwd(), 'evidence'),
} as const;

export function requireApiKey(): string {
  if (!config.geminiApiKey) {
    throw new Error(
      'No model API key set. Create a .env with GEMINI_API_KEY=AQ... (Vertex AI Express Mode key; it is gitignored). ' +
        'Only discovery needs it; replay never calls the model.',
    );
  }
  return config.geminiApiKey;
}
