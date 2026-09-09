import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactDeep, redactString } from './safety/redaction.js';

/**
 * Evidence recorder. Every run (discovery or replay) gets its own directory:
 *
 *   evidence/<kind>-<capabilityId>-<runId>/
 *     events.jsonl     append-only, redacted structured log of what happened & why
 *     summary.json     the final result / outcome
 *     step-XX.png      screenshots (always at start/end; richer on failure)
 *     failure.html     DOM snapshot captured on hard failure
 *
 * All log payloads pass through redaction so no secret/PII is ever written.
 */

export type EventLevel = 'info' | 'warn' | 'error' | 'action' | 'decision' | 'condition';

export interface RunEvent {
  ts: string;
  level: EventLevel;
  msg: string;
  [k: string]: unknown;
}

let clock = 0;
function stamp(): string {
  // monotonic-ish label without depending on Date.now() (kept deterministic-friendly)
  return `t+${(clock++).toString().padStart(4, '0')}`;
}

export class Evidence {
  readonly dir: string;
  private readonly eventsPath: string;
  private screenshotSeq = 0;

  constructor(baseDir: string, kind: 'discovery' | 'replay', capabilityId: string, runId: string) {
    this.dir = join(baseDir, `${kind}-${capabilityId}-${runId}`);
    mkdirSync(this.dir, { recursive: true });
    this.eventsPath = join(this.dir, 'events.jsonl');
  }

  log(level: EventLevel, msg: string, data: Record<string, unknown> = {}): void {
    // Redact the message string itself, not just the structured data (a caller
    // can accidentally interpolate a secret/PII into the message).
    const safeMsg = redactString(msg);
    const safeData = redactDeep(data) as Record<string, unknown>;
    const ev: RunEvent = { ts: stamp(), level, msg: safeMsg, ...safeData };
    appendFileSync(this.eventsPath, JSON.stringify(ev) + '\n', 'utf8');
    const tag = { info: 'ℹ', warn: '⚠', error: '✖', action: '▸', decision: '◆', condition: '⚑' }[level];
    // progress goes to STDERR so machine-facing commands (e.g. `invoke`) keep stdout
    // as pure JSON.
    // eslint-disable-next-line no-console
    console.error(`  ${tag} ${safeMsg}${safeData.detail ? ' — ' + String(safeData.detail) : ''}`);
  }

  nextScreenshotPath(label: string): string {
    return join(this.dir, `step-${String(this.screenshotSeq++).padStart(2, '0')}-${label}.png`);
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  writeSummary(summary: unknown): void {
    writeFileSync(join(this.dir, 'summary.json'), JSON.stringify(redactDeep(summary), null, 2), 'utf8');
  }

  writeJson(name: string, data: unknown, redact = true): void {
    writeFileSync(join(this.dir, name), JSON.stringify(redact ? redactDeep(data) : data, null, 2), 'utf8');
  }
}
