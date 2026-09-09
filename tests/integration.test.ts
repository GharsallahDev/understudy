import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../mock-app/server.js';
import { getTenant } from '../mock-app/tenants.js';
import { WebSurface } from '../src/surface/webSurface.js';
import { Evidence } from '../src/evidence.js';
import { ReplayEngine } from '../src/replay/replay.js';
import { buildPolicy, authenticate } from '../src/runner.js';
import { CapabilityStore } from '../src/catalog/store.js';
import type { Capability } from '../src/types/capability.js';
import type { ReplayResult } from '../src/types/result.js';

/**
 * End-to-end integration: the REAL replay engine driving a REAL browser against
 * the in-process mock — no model, no network, no committed-evidence dependency.
 * This is what proves the production path actually works in CI, not just that the
 * pure helpers are correct.
 */
const store = new CapabilityStore(join(process.cwd(), 'capabilities'));
const evDir = mkdtempSync(join(tmpdir(), 'understudy-itest-'));

let server: Server;
let baseUrl: string;
let surface: WebSurface;

async function setFaults(f: Record<string, unknown>) {
  await fetch(`${baseUrl}/_admin/faults`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f) });
}

async function replay(cap: Capability, inputs: Record<string, string>, opts: { verify?: boolean } = {}): Promise<ReplayResult> {
  const evidence = new Evidence(evDir, 'replay', cap.id, `it-${Math.random().toString(36).slice(2, 6)}`);
  return new ReplayEngine({ capability: cap, inputs, runId: 'itest', surface, evidence, policy: buildPolicy(cap), verify: opts.verify }).run();
}

beforeAll(async () => {
  server = createApp(getTenant('meridian')).listen(0);
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
  surface = await WebSurface.launch({ baseUrl, headless: true });
  await authenticate(surface);
});
afterAll(async () => {
  await surface?.close();
  server?.close();
});
afterEach(async () => { await setFaults({ interstitial: false, appError: false, expireSessions: false, renameControls: false }); });

describe('replay engine — end to end against the mock', () => {
  it('happy path returns typed outputs (balance in cents)', async () => {
    const r = await replay(store.load('lookup-member-savings-balance'), { memberNumber: '100123' });
    expect(r.status).toBe('success');
    if (r.status === 'success') expect(r.outputs.savingsBalance).toBe(482355);
  });

  it('missing record is a BUSINESS OUTCOME, not a failure', async () => {
    const r = await replay(store.load('lookup-member-savings-balance'), { memberNumber: '999999' });
    expect(r.status).toBe('business_outcome');
    if (r.status === 'business_outcome') expect(r.outcome.code).toBe('MEMBER_NOT_FOUND');
  });

  it('an interstitial dialog is a RECOVERABLE condition (dismiss + continue)', async () => {
    await setFaults({ interstitial: true });
    const r = await replay(store.load('lookup-member-savings-balance'), { memberNumber: '100123' });
    expect(r.status).toBe('success');
  });

  it('an application error is a HARD FAILURE with a debuggable code', async () => {
    await setFaults({ appError: true });
    const r = await replay(store.load('lookup-member-savings-balance'), { memberNumber: '100123' });
    expect(r.status).toBe('failure');
    if (r.status === 'failure') expect(r.error.condition).toBe('APP_ERROR');
  });

  it('rejects invalid input against the declared contract', async () => {
    const r = await replay(store.load('lookup-member-savings-balance'), { memberNumber: 'not-a-number' });
    expect(r.status).toBe('failure'); // pattern ^\d+$ violated -> caller error
  });

  it('create flow succeeds and extracts the new account number', async () => {
    const r = await replay(store.load('open-member-subaccount'), { memberNumber: '100123', accountType: 'Checking', initialDeposit: '25.00' }, { verify: true });
    expect(r.status).toBe('success');
    // assert an account-number-shaped value is extracted, independent of the model-chosen key
    if (r.status === 'success') expect(Object.values(r.outputs).map(String).some((v) => /^\d+-\d+$/.test(v))).toBe(true);
  });

  it('a restricted member is a PERMISSION_DENIED business outcome', async () => {
    const r = await replay(store.load('open-member-subaccount'), { memberNumber: '100456', accountType: 'Checking', initialDeposit: '25.00' }, { verify: true });
    expect(r.status).toBe('business_outcome');
    if (r.status === 'business_outcome') expect(r.outcome.code).toBe('PERMISSION_DENIED');
  });
});
