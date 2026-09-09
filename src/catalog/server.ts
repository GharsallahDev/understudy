import express from 'express';
import type { Server } from 'node:http';
import { CapabilityStore } from './store.js';
import { toCatalogEntry } from './registry.js';
import { runReplay } from '../runner.js';

/**
 * Agent-facing capability catalog (stretch goal). Exposes saved capabilities as
 * a catalog of callable tools an AI agent can discover and invoke by name with
 * typed args. This is the production entry point: the agent-facing product calls
 * POST /capabilities/:id/invoke, and understudy runs the deterministic replay.
 */
export async function startCatalogServer(store: CapabilityStore, port: number): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());

  // discovery: list callable capabilities as tool specs
  app.get('/capabilities', (_req, res) => {
    res.json(store.list().map(toCatalogEntry));
  });

  app.get('/capabilities/:id', (req, res) => {
    try {
      res.json(toCatalogEntry(store.load(req.params.id)));
    } catch {
      res.status(404).json({ error: 'not_found' });
    }
  });

  // invoke: run the deterministic replay (no model in the loop)
  app.post('/capabilities/:id/invoke', async (req, res) => {
    let cap;
    try {
      cap = store.load(req.params.id);
    } catch {
      return res.status(404).json({ error: 'not_found' });
    }
    const inputs = (req.body?.inputs ?? {}) as Record<string, string>;
    const tenantId = req.body?.tenantId as string | undefined;
    try {
      const result = await runReplay({
        capability: cap,
        inputs,
        tenantId,
        headless: true,
        allowUnattendedRisky: cap.approval.state === 'approved' && Boolean(req.body?.allowUnattendedRisky),
        runLabel: 'invoke',
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: 'invoke_failed', message: (err as Error).message });
    }
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s)); // loopback only, no auth on invoke
  });
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
