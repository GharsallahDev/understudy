import express from 'express';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { OperatorHub } from './operatorHub.js';
import type { Intervention } from './types.js';

/**
 * Minimal-but-real operator console. It is deliberately not a co-browsing
 * surface (that's out of scope per the brief). The human takes control by
 * acting directly in the live, headed browser window the automation is already
 * using. This console is the control plane around that: it shows why the run
 * stopped, what the human needs to do, the live-session screenshot, and a single
 * "Resume automation" control that hands control back on the same session.
 */
export interface OperatorConsoleHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startOperatorConsole(hub: OperatorHub, port: number): Promise<OperatorConsoleHandle> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (_req, res) => res.send(renderList(hub.list())));

  app.get('/i/:id', (req, res) => {
    const iv = hub.get(req.params.id);
    if (!iv) return res.status(404).send(page('Not found', '<p>Unknown intervention.</p>'));
    res.send(renderDetail(iv));
  });

  app.get('/shot/:id', async (req, res) => {
    const iv = hub.get(req.params.id);
    if (!iv?.context.screenshotPath) return res.status(404).end();
    try {
      res.type('png').send(await readFile(iv.context.screenshotPath));
    } catch {
      res.status(404).end();
    }
  });

  app.post('/i/:id/resume', (req, res) => {
    hub.resume(req.params.id, { resolvedBy: String(req.body.operator || 'operator'), note: String(req.body.note || '') });
    res.redirect('/');
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s)); // loopback only, no auth on resume/screenshots
  });
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// --- rendering (self-contained, inline CSS) --------------------------------

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} · understudy operator</title>
<meta http-equiv="refresh" content="4">
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b0f14;color:#d7e0ea;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
  header{padding:14px 22px;border-bottom:1px solid #1c2733;display:flex;align-items:center;gap:10px}
  header b{color:#5ed0a8;font-size:15px} header span{color:#5a6b7b}
  main{padding:22px;max-width:1000px}
  .card{background:#111823;border:1px solid #1e2a37;border-radius:10px;padding:16px 18px;margin-bottom:14px}
  .pending{border-left:3px solid #f2b24b} .resolved{border-left:3px solid #3f7d5c;opacity:.7}
  .tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:20px;background:#1e2a37;color:#9fb2c4}
  .tag.warn{background:#3a2c14;color:#f2b24b}
  a{color:#6cc5ff;text-decoration:none} a:hover{text-decoration:underline}
  pre{background:#0b1017;border:1px solid #1e2a37;border-radius:8px;padding:12px;white-space:pre-wrap;color:#a9c7dc;font-size:12.5px}
  img{max-width:100%;border:1px solid #1e2a37;border-radius:8px;margin-top:8px}
  button{background:#2f8f6b;color:#eafff5;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:700;cursor:pointer}
  input,textarea{background:#0b1017;border:1px solid #26384a;color:#d7e0ea;border-radius:6px;padding:8px;font:inherit;width:100%;box-sizing:border-box}
  label{display:block;color:#7f93a6;font-size:12px;margin:10px 0 4px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  @media(max-width:760px){.grid{grid-template-columns:1fr}}
</style></head><body>
<header><b>understudy</b><span>· operator console</span></header>
<main>${body}</main></body></html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function renderList(items: Intervention[]): string {
  const pending = items.filter((i) => i.status === 'pending');
  const others = items.filter((i) => i.status !== 'pending');
  const body =
    (pending.length === 0
      ? `<div class="card"><b>No interventions awaiting a human.</b><br><span style="color:#5a6b7b">This page auto-refreshes. When a run gets stuck it will appear here.</span></div>`
      : pending.map(card).join('')) + (others.length ? `<h3 style="color:#5a6b7b;margin-top:26px">Resolved</h3>${others.map(card).join('')}` : '');
  return page('Interventions', body);
}

function card(iv: Intervention): string {
  const cls = iv.status === 'pending' ? 'pending' : 'resolved';
  return `<div class="card ${cls}">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div><span class="tag warn">${esc(iv.context.condition)}</span> <b>${esc(iv.context.capabilityId)}</b></div>
      <span class="tag">${iv.status}</span>
    </div>
    <p style="margin:10px 0 4px">${esc(iv.context.reason)}</p>
    <span style="color:#5a6b7b">tenant ${esc(iv.context.tenantId)} · step ${esc(iv.context.stepId ?? '—')} · ${esc(iv.id)}</span>
    <div style="margin-top:8px"><a href="/i/${iv.id}">${iv.status === 'pending' ? 'Take control →' : 'View →'}</a></div>
  </div>`;
}

function renderDetail(iv: Intervention): string {
  const c = iv.context;
  const captured =
    iv.capturedActions.length === 0
      ? '<span style="color:#5a6b7b">(none captured yet)</span>'
      : `<pre>${esc(iv.capturedActions.map((a) => `${a.type}  ${a.target ?? a.url ?? ''}  ${a.detail ?? ''}`).join('\n'))}</pre>`;
  const resumeForm =
    iv.status === 'pending'
      ? `<form method="POST" action="/i/${iv.id}/resume">
           <label>Operator ID</label><input name="operator" value="OP-4471">
           <label>What did you do? (recorded with the run)</label>
           <textarea name="note" rows="2" placeholder="e.g. dismissed the maintenance notice / re-authenticated"></textarea>
           <div style="margin-top:12px"><button type="submit">✓ I've done the manual steps — Resume automation</button></div>
         </form>`
      : `<div class="card resolved">Resolved by <b>${esc(iv.resolvedBy ?? 'operator')}</b>. ${iv.note ? 'Note: ' + esc(iv.note) : ''}</div>`;
  return page(`Intervention ${iv.id}`, `
    <p><a href="/">← all interventions</a></p>
    <div class="card ${iv.status === 'pending' ? 'pending' : 'resolved'}">
      <span class="tag warn">${esc(c.condition)}</span> <b>${esc(c.capabilityId)}</b> · tenant ${esc(c.tenantId)}
      <p style="margin:8px 0"><b>Why it stopped:</b> ${esc(c.reason)}</p>
    </div>
    <div class="grid">
      <div>
        <h3>How to take control</h3>
        <div class="card">
          <ol style="margin:0;padding-left:18px;color:#b9c8d6">
            <li>Switch to the <b>live browser window</b> the automation opened.</li>
            <li>Perform the manual step(s) described above. Your actions are captured.</li>
            <li>Come back here and click <b>Resume automation</b>.</li>
          </ol>
        </div>
        <h3>Goal & location</h3>
        <pre>${esc(c.goal)}\n\n${esc(c.stateSummary)}</pre>
        <h3>Captured human actions</h3>
        ${captured}
        ${resumeForm}
      </div>
      <div>
        <h3>Live session (at handoff)</h3>
        <img src="/shot/${iv.id}" alt="session screenshot">
      </div>
    </div>`);
}
