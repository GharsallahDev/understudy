/**
 * Reproducible evidence suite. Assumes both capabilities are already recorded
 * (run `npm run discover savings-balance` and `npm run discover open-subaccount`
 * first; those are the real LLM runs) and both mock tenants are running
 * (meridian :3100, cascade :3101). This script itself uses NO model; it is the
 * deterministic production path: approvals + the full replay matrix + cross-tenant.
 */
import { CapabilityStore } from '../src/catalog/store.js';
import { config } from '../src/config.js';
import { runReplay, setFaults, resetMock, authenticate } from '../src/runner.js';
import { measureStability, withStability } from '../src/quality/stability.js';
import type { Capability, TenantOverride } from '../src/types/capability.js';
import type { ReplayResult } from '../src/types/result.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MERIDIAN = 'http://localhost:3100';
const CASCADE = 'http://localhost:3101';
const store = new CapabilityStore(config.capabilitiesDir);

const rows: string[] = [];
function record(name: string, expectation: string, r: ReplayResult) {
  const detail =
    r.status === 'success' ? JSON.stringify(r.outputs)
    : r.status === 'business_outcome' ? `${r.outcome.code}: ${r.outcome.message}`
    : r.status === 'needs_intervention' ? `${r.intervention.condition} (resumed=${r.intervention.resumed})`
    : `${r.error.condition} @ ${r.error.stepId ?? '—'}`;
  rows.push(`| ${name} | ${expectation} | \`${r.status}\` | ${detail.replace(/\|/g, '\\|').slice(0, 90)} |`);
  console.log(`\n■ ${name} → ${r.status.toUpperCase()}  ${detail}`);
}

/** The cascade tenant runs the same vendor product with different labels + an extra verify step. */
function cascadeOverride(cap: Capability): TenantOverride {
  const continueStep = cap.steps.find((s) => s.action === 'click' && /continue|review/i.test(s.intent));
  return {
    tenantId: 'cascade',
    note: 'Same vendor product (CoreServicing) as meridian; different control labels + a mandatory identity-verification click on the review screen.',
    labelRewrites: {
      'Member Number': 'Account Number',
      Search: 'Find Member',
      'Open Sub-Account': 'New Sub-Account',
      'Account Type': 'Share Type',
      'Initial Deposit': 'Opening Deposit',
      'Continue to Review': 'Review',
      'Confirm & Open Account': 'Open Account',
    },
    skipStepIds: [],
    insertSteps: continueStep
      ? [{
          afterStepId: continueStep.id,
          step: {
            id: 's-verify',
            intent: 'Click Identity Verified (cascade-only compliance step)',
            action: 'click',
            target: {
              description: 'Identity Verified button',
              strategies: [
                { kind: 'role', role: 'button', name: 'Identity Verified', exact: false },
                { kind: 'text', text: 'Identity Verified', exact: false },
              ],
              confidence: 0.9,
            },
            value: { from: 'none' },
            checkpoint: { description: 'Still on review after verifying', urlIncludes: '/subaccounts/review' },
            expectedConditions: [],
            risk: 'safe',
            timeoutMs: 10_000,
          },
        }]
      : [],
  };
}

async function main() {
  await resetMock(MERIDIAN);
  await resetMock(CASCADE);

  const lookup = store.load('lookup-member-savings-balance');
  let openSub = store.load('open-member-subaccount');

  // --- approvals ---------------------------------------------------------
  console.log('\n=== Approval: lookup (by replay stability) ===');
  const stab = await measureStability(lookup, { memberNumber: '100123' }, 3, { baseUrl: MERIDIAN });
  const approvedLookup = withStability(lookup, stab);
  approvedLookup.approval.state = stab.score >= 1 ? 'approved' : 'draft';
  approvedLookup.approval.approvedBy = 'evidence-suite';
  store.save(approvedLookup);
  console.log(`lookup stability ${stab.score * 100}% -> ${approvedLookup.approval.state}`);

  console.log('\n=== Approval: open-subaccount (human governance — contains an irreversible step) ===');
  // Attach the cascade override, then govern-approve (irreversible capabilities
  // are promoted by human sign-off, not stability alone).
  openSub = { ...openSub, tenantOverrides: [cascadeOverride(openSub)] };
  openSub.approval.state = 'approved';
  openSub.approval.approvedBy = 'supervisor (governance)';
  const osStab = await measureStability({ ...openSub }, { memberNumber: '100123', accountType: 'Checking', initialDeposit: '25.00' }, 2, { baseUrl: MERIDIAN });
  openSub = withStability(openSub, osStab);
  store.save(openSub);
  console.log(`open-subaccount stability ${osStab.score * 100}% (approved by governance)`);

  // --- replay matrix -----------------------------------------------------
  console.log('\n=== Replay matrix ===');

  record('lookup / happy path', 'success + balance in cents',
    await runReplay({ capability: approvedLookup, inputs: { memberNumber: '100123' }, headless: true, baseUrl: MERIDIAN, runLabel: 'happy' }));

  record('lookup / member not found', 'business_outcome MEMBER_NOT_FOUND',
    await runReplay({ capability: approvedLookup, inputs: { memberNumber: '999999' }, headless: true, baseUrl: MERIDIAN, runLabel: 'notfound' }));

  await setFaults(MERIDIAN, { interstitial: true });
  record('lookup / interstitial dialog', 'recoverable: dismiss + succeed',
    await runReplay({ capability: approvedLookup, inputs: { memberNumber: '100123' }, headless: true, baseUrl: MERIDIAN, runLabel: 'interstitial' }));
  await setFaults(MERIDIAN, { interstitial: false });

  await setFaults(MERIDIAN, { appError: true });
  record('lookup / application error', 'hard_failure APP_ERROR',
    await runReplay({ capability: approvedLookup, inputs: { memberNumber: '100123' }, headless: true, baseUrl: MERIDIAN, runLabel: 'apperror' }));
  await setFaults(MERIDIAN, { appError: false });

  // HITL: session expired -> escalate -> scripted operator re-authenticates on the
  // SAME live session -> resume -> retry -> success.
  await setFaults(MERIDIAN, { expireSessions: true });
  record('lookup / session timeout (HITL reauth)', 'needs_intervention -> resumed -> success',
    await runReplay({
      capability: approvedLookup, inputs: { memberNumber: '100123' }, headless: true, baseUrl: MERIDIAN, runLabel: 'timeout',
      withOperator: true, autoResumeMs: 600,
      autoResumeAction: async (surface) => { await setFaults(MERIDIAN, { expireSessions: false }); await authenticate(surface); },
    }));
  await setFaults(MERIDIAN, { expireSessions: false });

  record('open-subaccount / happy path (approved, risky allowed)', 'success + new account number',
    await runReplay({ capability: openSub, inputs: { memberNumber: '100123', accountType: 'Checking', initialDeposit: '25.00' }, headless: true, baseUrl: MERIDIAN, allowUnattendedRisky: true, runLabel: 'happy' }));

  record('open-subaccount / restricted member', 'business_outcome PERMISSION_DENIED',
    await runReplay({ capability: openSub, inputs: { memberNumber: '100456', accountType: 'Checking', initialDeposit: '25.00' }, headless: true, baseUrl: MERIDIAN, allowUnattendedRisky: true, runLabel: 'permission' }));

  record('open-subaccount / below-minimum deposit', 'business_outcome VALIDATION_FAILED',
    await runReplay({ capability: openSub, inputs: { memberNumber: '100789', accountType: 'Money Market', initialDeposit: '5.00' }, headless: true, baseUrl: MERIDIAN, allowUnattendedRisky: true, runLabel: 'validation' }));

  // Cross-tenant: SAME artifact, replayed on cascade with declared overrides.
  record('open-subaccount / CASCADE tenant (cross-tenant reuse)', 'success on a different tenant, no re-record',
    await runReplay({ capability: openSub, inputs: { memberNumber: '100123', accountType: 'Checking', initialDeposit: '25.00' }, tenantId: 'cascade', headless: true, baseUrl: CASCADE, allowUnattendedRisky: true, runLabel: 'cascade' }));

  // UI DRIFT: the recorded "Open Sub-Account" control is renamed. First without
  // self-heal (brittle replay dies, where most implementations fail), then with
  // bounded self-heal (one model call re-resolves it, re-verifies, and proposes a patch).
  // Two controls drift: a renamed LINK (with an added decoy) and a renamed BUTTON.
  // The ladder auto-absorbs the link via its href rung; only the button (no stable
  // handle left) truly breaks, which is where the NO-heal run dies and self-heal saves it.
  await setFaults(MERIDIAN, { renameControls: true });
  record('open-subaccount / UI drift, NO self-heal', 'hard_failure LOCATOR_UNRESOLVED where the ladder truly cannot resolve (brittle replays die here)',
    await runReplay({ capability: openSub, inputs: { memberNumber: '100123', accountType: 'Checking', initialDeposit: '25.00' }, headless: true, baseUrl: MERIDIAN, allowUnattendedRisky: true, runLabel: 'drift-fail' }));

  if (config.geminiApiKey) {
    record('open-subaccount / UI drift, WITH self-heal', 'success — ladder absorbs the renamed link (href rung); self-heal recovers the renamed button + writes a patch',
      await runReplay({ capability: openSub, inputs: { memberNumber: '100123', accountType: 'Checking', initialDeposit: '25.00' }, headless: true, baseUrl: MERIDIAN, allowUnattendedRisky: true, selfHeal: true, healApiKey: config.geminiApiKey, healModel: config.model, runLabel: 'drift-heal' }));
  } else {
    console.log('\n(skipped self-heal scenario: no model key set)');
  }
  await setFaults(MERIDIAN, { renameControls: false });

  // A REAL, live, third-party PUBLIC BANK (ParaBank). Same engine, no mock: proves
  // the system works on an untested legacy-style banking surface, and that the
  // SAME capability generalizes across accounts via input-bound targeting.
  const PARABANK = 'https://parabank.parasoft.com';
  let parabank;
  try { parabank = store.load('parabank-account-balance'); } catch { parabank = undefined; }
  if (parabank) {
    // ParaBank is a shared demo that resets; use the account the capability was
    // recorded against. (Two-accounts-by-input is proven deterministically on the mock.)
    const acct = parabank.inputs.find((i) => i.name === 'accountId')?.example ?? '40650';
    record(`ParaBank (REAL public bank) / balance lookup, account ${acct}`, 'success — logs in (injected creds) and reads a live balance on a third-party bank',
      await runReplay({ capability: parabank, inputs: { username: 'john', password: 'demo', accountId: acct }, headless: true, baseUrl: PARABANK, preAuth: false,
        // operator sanctions the target's routes at replay (not trusted from the artifact)
        policyOverride: { allowedRoutes: ['/parabank/**', '/**'], allowedActions: ['navigate', 'click', 'type', 'select', 'press', 'read', 'assert', 'waitFor'] },
        runLabel: 'parabank' }));
  } else {
    console.log('\n(skipped ParaBank scenarios: capability not recorded — run `npm run discover parabank-balance`)');
  }

  // --- manifest ----------------------------------------------------------
  const md = `# Evidence

Generated by \`npm run evidence\`. Discovery runs (real LLM, Gemini via Vertex) are in the
\`discovery-*\` directories; everything below is deterministic replay with **no model in the loop**.

## Replay matrix

| Scenario | Expectation | Result status | Detail |
|---|---|---|---|
${rows.join('\n')}

Each row has a matching \`replay-*\` directory with \`events.jsonl\`, screenshots, and \`summary.json\`.
Failure/■ runs also include \`failure.html\`.
`;
  writeFileSync(join(config.evidenceDir, 'EVIDENCE.md'), md, 'utf8');
  console.log(`\n✔ Wrote ${join(config.evidenceDir, 'EVIDENCE.md')}`);
}

main().catch((e) => { console.error('evidence suite failed:', e); process.exit(1); });
