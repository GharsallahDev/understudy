/* understudy CLI: discover, replay, invoke, catalog, serve, approve, stability. */
import { config, requireApiKey } from './config.js';
import { RECIPES } from './recipes.js';
import { runDiscovery, runReplay, setFaults, resetMock } from './runner.js';
import { CapabilityStore } from './catalog/store.js';
import { toCatalogEntry } from './catalog/registry.js';
import { startCatalogServer } from './catalog/server.js';
import { measureStability, withStability } from './quality/stability.js';

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
  inputs: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const inputs: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--input' || a === '-i') {
      const kv = argv[++i] ?? '';
      const eq = kv.indexOf('=');
      if (eq > -1) inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else {
      _.push(a);
    }
  }
  return { _, flags, inputs };
}

const store = new CapabilityStore(config.capabilitiesDir);

async function main() {
  const { _, flags, inputs } = parseArgs(process.argv.slice(2));
  const cmd = _[0];
  const headless = Boolean(flags.headless) || config.headless;

  switch (cmd) {
    case 'discover': {
      const recipeKey = _[1];
      const recipe = recipeKey ? RECIPES[recipeKey] : undefined;
      if (!recipe) {
        console.error(`Usage: discover <recipe>\nRecipes: ${Object.keys(RECIPES).join(', ')}`);
        process.exit(1);
      }
      const apiKey = requireApiKey();
      console.log(`\n▶ Discovery: ${recipe.meta.name}  (model ${config.model})\n`);
      const { capability, success, evidenceDir } = await runDiscovery({
        goal: recipe.goal,
        inputs: recipe.inputs,
        entryRoute: recipe.entryRoute,
        meta: recipe.meta,
        apiKey,
        headless,
        withOperator: Boolean(flags.operator),
        baseUrl: recipe.baseUrl,
        preAuth: recipe.preAuth,
        policyOverride: recipe.policyOverride,
        maxSteps: recipe.maxSteps,
      });
      if (!success) {
        console.error(`\n✖ Discovery did not complete. See evidence: ${evidenceDir}`);
        process.exit(2);
      }
      store.save(capability);
      console.log(`\n✔ Recorded capability "${capability.id}" (${capability.steps.length} steps, ${capability.outputs.length} outputs)`);
      console.log(`  Artifact: ${store.path(capability.id)}`);
      console.log(`  Evidence: ${evidenceDir}`);
      break;
    }

    case 'replay': {
      const id = _[1];
      if (!id) { console.error('Usage: replay <capabilityId> [--input k=v]... [--tenant t] [--operator] [--fault JSON] [--allow-risky]'); process.exit(1); }
      const capability = store.load(id);
      const baseUrl = (flags['base-url'] as string) || (flags.baseUrl as string) || config.targetBaseUrl;
      if (flags.fault) { await setFaults(baseUrl, JSON.parse(flags.fault as string)); console.log(`  (fault injected: ${flags.fault})`); }
      // Operator-supplied outer allowlist for non-default targets (never the artifact).
      const allowRoutes = typeof flags['allow-route'] === 'string' ? (flags['allow-route'] as string).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const allowHosts = typeof flags['allow-host'] === 'string' ? (flags['allow-host'] as string).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const policyOverride = allowRoutes || allowHosts
        ? { ...(allowRoutes ? { allowedRoutes: allowRoutes } : {}), ...(allowHosts ? { allowedHosts: allowHosts } : {}) }
        : undefined;
      const result = await runReplay({
        capability,
        inputs: Object.keys(inputs).length ? inputs : defaultInputs(capability),
        tenantId: flags.tenant as string | undefined,
        baseUrl,
        policyOverride,
        headless,
        withOperator: Boolean(flags.operator),
        autoResumeMs: flags['auto-resume'] ? Number(flags['auto-resume']) : undefined,
        allowUnattendedRisky: Boolean(flags['allow-risky']),
        selfHeal: Boolean(flags['self-heal']),
        healApiKey: flags['self-heal'] ? requireApiKey() : undefined,
        healModel: config.model,
        preAuth: !flags['no-preauth'],
      });
      if (flags.fault) await resetMock(baseUrl);
      printResult(result);
      process.exit(result.status === 'failure' ? 3 : 0);
      break;
    }

    case 'invoke': {
      // Agent-style: prints the ReplayResult as JSON (what a calling agent receives).
      const id = _[1];
      if (!id) { console.error('Usage: invoke <capabilityId> [--input k=v]...'); process.exit(1); }
      const capability = store.load(id);
      const result = await runReplay({
        capability,
        inputs: Object.keys(inputs).length ? inputs : defaultInputs(capability),
        tenantId: flags.tenant as string | undefined,
        headless: true,
        allowUnattendedRisky: Boolean(flags['allow-risky']) && capability.approval.state === 'approved',
        runLabel: 'invoke',
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'catalog': {
      const entries = store.list().map(toCatalogEntry);
      if (flags.json) { console.log(JSON.stringify(entries, null, 2)); break; }
      if (entries.length === 0) { console.log('No capabilities yet. Run: npm run discover savings-balance'); break; }
      console.log('\nCapability catalog:\n');
      for (const e of entries) {
        console.log(`  ${e.id}@${e.version}  [${e.approval.state}]  tenant=${e.tenantId}`);
        console.log(`    ${e.description}`);
        console.log(`    inputs: ${Object.keys(e.inputSchema.properties).join(', ') || '(none)'}  |  outputs: ${e.outputs.map((o) => `${o.name}:${o.type}`).join(', ') || '(none)'}  |  risky steps: ${e.riskySteps}`);
        if (e.approval.stability) console.log(`    stability: ${(e.approval.stability.score * 100).toFixed(0)}% over ${e.approval.stability.runs} runs`);
        console.log('');
      }
      break;
    }

    case 'serve': {
      const s = await startCatalogServer(store, config.catalogPort);
      console.log(`Catalog API on ${s.url}`);
      console.log(`  GET  ${s.url}/capabilities`);
      console.log(`  POST ${s.url}/capabilities/:id/invoke   {"inputs": {...}}`);
      break; // keep process alive
    }

    case 'stability': {
      const id = _[1];
      if (!id) { console.error('Usage: stability <capabilityId> [--runs N] [--input k=v]...'); process.exit(1); }
      const cap = store.load(id);
      const runs = Number(flags.runs ?? 3);
      console.log(`Measuring stability of ${id} over ${runs} runs...`);
      const report = await measureStability(cap, Object.keys(inputs).length ? inputs : defaultInputs(cap), runs, { baseUrl: config.targetBaseUrl });
      console.log(JSON.stringify(report, null, 2));
      break;
    }

    case 'approve': {
      const id = _[1];
      if (!id) { console.error('Usage: approve <capabilityId> [--runs N] [--min-stability X] [--input k=v]...'); process.exit(1); }
      const cap = store.load(id);
      const runs = Number(flags.runs ?? 3);
      // approval is a human governance act; --min-stability optionally auto-gates it.
      const min = flags['min-stability'] != null ? Number(flags['min-stability']) : 0;
      const runInputs = Object.keys(inputs).length ? inputs : defaultInputs(cap);
      // Measure against an in-memory approved candidate: nothing is persisted yet,
      // so a crash during measurement leaves the on-disk artifact unchanged (F10).
      const candidate = { ...cap, approval: { ...cap.approval, state: 'approved' as const, approvedBy: 'cli' } };
      console.log(`Measuring stability of ${id} over ${runs} runs...`);
      let report;
      try {
        report = await measureStability(candidate, runInputs, runs, { baseUrl: config.targetBaseUrl });
      } catch (err) {
        console.error(`✖ Approval aborted — stability measurement failed: ${(err as Error).message}`);
        console.error(`  Capability left unchanged (approval: ${cap.approval.state}).`);
        process.exit(1);
      }
      // Persist the final decision atomically, only after checks complete.
      const updated = withStability(cap, report);
      if (report.score >= min) {
        updated.approval = { ...updated.approval, state: 'approved', approvedBy: 'cli' };
        console.log(`✔ Approved (stability ${(report.score * 100).toFixed(0)}% over ${runs} runs).`);
      } else {
        updated.approval = { ...updated.approval, state: 'draft' };
        console.log(`✖ Not approved (${(report.score * 100).toFixed(0)}% < ${min * 100}%). Left as draft.`);
      }
      store.save(updated);
      break;
    }

    default:
      console.log(`understudy — record-once, replay-many computer use

Commands:
  discover <recipe>              Run the LLM discovery loop and record a capability
                                 recipes: ${Object.keys(RECIPES).join(', ')}
  replay <id> [--input k=v]...   Deterministically replay a capability (no model)
        [--tenant t] [--operator] [--fault '{"interstitial":true}'] [--allow-risky] [--auto-resume MS]
  invoke <id> [--input k=v]...   Replay and print the JSON result (agent-facing)
  catalog [--json]               List saved capabilities as callable tools
  serve                          Start the agent-facing catalog API
  stability <id> [--runs N]      Replay N times, report a stability score
  approve <id> [--runs N] [--min-stability 1.0]   Promote draft -> approved if stable

Flags: --headless   run browsers headless`);
  }
}

function defaultInputs(cap: ReturnType<CapabilityStore['load']>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of cap.inputs) if (i.example) out[i.name] = i.example;
  return out;
}

function printResult(result: Awaited<ReturnType<typeof runReplay>>): void {
  console.log('\n── Replay result ──');
  console.log(`  status: ${result.status.toUpperCase()}`);
  if (result.status === 'success') console.log(`  outputs: ${JSON.stringify(result.outputs)}`);
  if (result.status === 'business_outcome') console.log(`  outcome: ${result.outcome.code} — ${result.outcome.message}`);
  if (result.status === 'needs_intervention') console.log(`  intervention: ${result.intervention.condition} — ${result.intervention.reason} (resumed=${result.intervention.resumed})`);
  if (result.status === 'failure') console.log(`  failure: ${result.error.condition} @ ${result.error.stepId ?? '—'} — ${result.error.message}`);
  if (result.notes?.length) for (const n of result.notes) console.log(`  ⚑ ${n}`);
  console.log(`  evidence: ${result.evidenceDir}\n`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
