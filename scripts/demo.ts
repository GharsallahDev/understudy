/**
 * Guided demo runner for a screen recording. One terminal: it starts the mock
 * bank, then walks five headed scenes with a title card and an Enter-pause before
 * each, so you can narrate at your own pace. Browsers open visibly (headed is the
 * default). Ctrl-C at any point stops cleanly and shuts the mock down.
 *
 *   npm run demo
 *
 * Scene 1 needs a Vertex key in .env (the live discovery run); scenes 2-4 use the
 * local mock; scene 5 hits the real public ParaBank over the network.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const MOCK_URL = 'http://localhost:3100';
const TOTAL = 5;
const c = {
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

function card(n: number, title: string, desc: string): void {
  const line = '─'.repeat(66);
  console.log('\n' + c.cyan('┌' + line + '┐'));
  console.log(c.cyan('│ ') + c.bold(`SCENE ${n}/${TOTAL}`) + '   ' + c.bold(title));
  console.log(c.cyan('│ ') + desc);
  console.log(c.cyan('└' + line + '┘') + '\n');
}

function pause(msg: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(c.yellow(`\n▶ ${msg}  (press Enter)`), () => { rl.close(); resolve(); });
  });
}

/** Run a CLI subprocess with inherited stdio so its output and browser show on
 *  screen. Resolves on any exit (a business outcome exits non-failure), so the
 *  recording never aborts mid-scene. */
function cli(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', 'src/cli.ts', ...args], { stdio: 'inherit', env: process.env });
    child.on('close', () => resolve());
    child.on('error', reject);
  });
}

async function waitForMock(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fetch(MOCK_URL); return; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error(`mock did not come up on ${MOCK_URL} within ${timeoutMs}ms`);
}

/** A concise, readable view of the recorded artifact: more watchable than dumping raw JSON. */
function showArtifact(): void {
  const cap = JSON.parse(readFileSync('capabilities/lookup-member-savings-balance.json', 'utf8'));
  console.log('  ' + c.bold(`${cap.id}@${cap.version}`));
  console.log('  inputs:  ' + cap.inputs.map((i: any) => `${i.name}:${i.type}`).join(', '));
  console.log('  outputs: ' + cap.outputs.map((o: any) => `${o.name}:${o.type}`).join(', '));
  console.log('  steps:   ' + `${cap.steps.length}  ` + c.dim('(replayed deterministically, no model in the loop)'));
  const s = cap.steps[0];
  console.log('\n  ' + c.dim(`each target is a locator ladder, most-stable first, e.g. step "${s.intent}":`));
  for (const st of s.target.strategies) {
    const label = [st.kind, st.role, st.name && `"${st.name}"`, st.label && `"${st.label}"`].filter(Boolean).join(' ');
    console.log('     - ' + label);
  }
  console.log('\n  ' + c.dim('full artifact: capabilities/lookup-member-savings-balance.json'));
}

async function main(): Promise<void> {
  console.log(c.bold('\nunderstudy live demo') + c.dim('  (record your screen now: Cmd+Shift+5)\n'));
  console.log('Starting the mock bank on :3100 …');
  const mock = spawn('npx', ['tsx', 'mock-app/server.ts'], { stdio: 'ignore', env: process.env });
  const cleanup = () => { try { mock.kill('SIGTERM'); } catch { /* already gone */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  await waitForMock(15_000);
  console.log(c.dim('mock up.\n'));

  await pause('Scene 1: the model discovers the task');
  card(1, 'DISCOVERY', 'The LLM completes the task once in a real browser, and we record it.');
  await cli(['discover', 'savings-balance']);

  await pause('Scene 2: what it recorded');
  card(2, 'THE CAPABILITY ARTIFACT', 'Typed, versioned, and replayable with no model needed.');
  showArtifact();

  await pause('Scene 3: deterministic replay, no model');
  card(3, 'DETERMINISTIC REPLAY', 'The same task, run with no model: fast, and generalized by input.');
  await cli(['replay', 'lookup-member-savings-balance', '--input', 'memberNumber=100123']);
  await cli(['replay', 'lookup-member-savings-balance', '--input', 'memberNumber=100789']);

  await pause('Scene 4: an outcome, not a crash');
  card(4, 'BUSINESS OUTCOME', 'A missing member is a first-class result the caller can handle, not a failure.');
  await cli(['replay', 'lookup-member-savings-balance', '--input', 'memberNumber=999999']);

  await pause('Scene 5: a real, live public bank');
  card(5, 'A REAL BANK (ParaBank)', 'The same engine logs in and reads a balance on a bank we do not control.');
  await cli(['replay', 'parabank-account-balance', '--no-preauth',
    '--base-url', 'https://parabank.parasoft.com', '--allow-route', '/parabank/**',
    '--input', 'username=john', '--input', 'password=demo', '--input', 'accountId=40650']);

  console.log('\n' + c.cyan('That is the whole loop: discover → record → replay → handle outcomes → run anywhere.'));
  console.log(c.dim('Design write-up: REPORT.md   ·   Full matrix: evidence/EVIDENCE.md\n'));
  cleanup();
  process.exit(0);
}

main().catch((e) => { console.error('demo failed:', e); process.exit(1); });
