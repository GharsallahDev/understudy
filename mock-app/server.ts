/**
 * MeridianCU: mock legacy credit-union servicing console.
 *
 * Deliberately "legacy": server-rendered, table-based layout, unstable
 * per-render element IDs, NO test IDs, non-semantic wrappers. Controls DO expose
 * stable accessible names (role + name), because the accessibility tree is the
 * one surface that survives this kind of markup, which is the whole thesis of
 * `understudy`. CSS/id targeting is intentionally hostile; role+name targeting
 * is intentionally viable.
 *
 * It also models the runtime realities the brief cares about: a login/session,
 * a real multi-step flow (search -> detail -> open sub-account -> review ->
 * confirm), and INJECTABLE FAULTS (not-found, validation, permission-denied,
 * session-timeout, interstitial dialog, slow load, app error, and a control
 * RENAME to simulate genuine UI drift) so replay error handling and self-healing
 * can be exercised deterministically.
 *
 * `createApp(tenant)` returns a fresh, isolated app (used by tests). Running the
 * file directly starts a server:
 *   npm run mock                       (meridian on :3100)
 *   TENANT=cascade PORT=3101 npm run mock
 */
import express, { type Express, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MemberStore, MIN_INITIAL_DEPOSIT_CENTS, ALLOWED_TYPES_BY_STATUS, formatUsd, type ShareType } from './data.js';
import { getTenant, type TenantProfile } from './tenants.js';

const CREDS = { user: 'operator', pass: 'demo-pass' }; // mock only; never real creds

interface FaultState {
  slowMs: number; // artificial latency on every request
  interstitial: boolean; // inject a blocking "System Notice" on member detail
  expireSessions: boolean; // treat all sessions as timed out
  appError: boolean; // return a 500 on member detail
  renameControls: boolean; // rename a control to simulate UI drift (breaks recorded locators)
}

interface Session {
  id: string;
  authed: boolean;
  pending?: { memberNumber: string; type: ShareType; verified?: boolean; depositCents?: number };
}

export function createApp(tenant: TenantProfile = getTenant(process.env.TENANT)): Express {
  const TENANT = tenant;
  const faults: FaultState = { slowMs: 0, interstitial: false, expireSessions: false, appError: false, renameControls: false };
  const resetFaults = () => Object.assign(faults, { slowMs: 0, interstitial: false, expireSessions: false, appError: false, renameControls: false });
  const sessions = new Map<string, Session>();
  const store = new MemberStore();

  function parseCookies(req: Request): Record<string, string> {
    const raw = req.headers.cookie ?? '';
    const out: Record<string, string> = {};
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function getSession(req: Request, res: Response): Session {
    const sid = parseCookies(req)['SID'];
    if (sid && sessions.has(sid)) return sessions.get(sid)!;
    const id = randomBytes(12).toString('hex');
    const s: Session = { id, authed: false };
    sessions.set(id, s);
    res.setHeader('Set-Cookie', `SID=${id}; Path=/; HttpOnly; SameSite=Lax`);
    return s;
  }

  const rid = (prefix = 'ctl') => `${prefix}_${randomBytes(4).toString('hex')}`;
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

  function page(title: string, body: string, opts: { interstitial?: boolean } = {}): string {
    const notice = opts.interstitial
      ? `<div id="${rid('overlay')}" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999">
           <div role="dialog" aria-label="System Notice" style="max-width:460px;margin:120px auto;background:#fff;border:2px solid #999;padding:18px;font-family:Verdana">
             <table width="100%"><tr><td><b>System Notice</b></td></tr>
             <tr><td style="padding:10px 0">A scheduled maintenance window is approaching. Acknowledge to continue.</td></tr>
             <tr><td align="right"><button onclick="this.closest('div[role=dialog]').parentElement.remove()">Acknowledge</button></td></tr></table>
           </div></div>`
      : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="font-family:Verdana,Arial,sans-serif;font-size:13px;margin:0;background:#eef1f4">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${TENANT.color};color:#fff">
  <tr><td style="padding:10px 16px;font-size:16px;font-weight:bold">${esc(TENANT.brand)}</td>
      <td align="right" style="padding:10px 16px;font-size:11px">Operator: OP-4471 &nbsp;|&nbsp; Tenant: ${esc(TENANT.id)}</td></tr>
</table>
<table width="100%"><tr><td style="padding:16px 24px">${body}</td></tr></table>
${notice}
</body></html>`;
  }

  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.use(async (_req, _res, next) => {
    if (faults.slowMs > 0) await new Promise((r) => setTimeout(r, faults.slowMs));
    next();
  });

  // --- fault admin (out-of-band control plane for tests/evidence injection) ---
  app.post('/_admin/faults', express.json(), (req: Request, res: Response) => {
    Object.assign(faults, req.body ?? {});
    res.json({ ok: true, faults });
  });
  app.post('/_admin/reset', (_req: Request, res: Response) => {
    resetFaults(); store.reset(); sessions.clear(); res.json({ ok: true });
  });
  app.get('/_admin/health', (_req: Request, res: Response) => res.json({ ok: true, tenant: TENANT.id }));

  function requireAuth(req: Request, res: Response): Session | null {
    const s = getSession(req, res);
    if (faults.expireSessions || !s.authed) {
      res.status(faults.expireSessions && s.authed ? 440 : 200);
      res.send(loginPage(faults.expireSessions && s.authed));
      return null;
    }
    return s;
  }

  function loginPage(expired = false): string {
    const u = rid('u'), p = rid('p');
    return page('Sign In', `
      ${expired ? '<p style="color:#b00"><b>Your session has expired. Please sign in again.</b></p>' : ''}
      <h3>Operator Sign In</h3>
      <form method="POST" action="/login">
        <table cellpadding="6">
          <tr><td>Username</td><td><input id="${u}" name="username" aria-label="Username"></td></tr>
          <tr><td>Password</td><td><input id="${p}" name="password" type="password" aria-label="Password"></td></tr>
          <tr><td></td><td><button type="submit">Sign In</button></td></tr>
        </table>
      </form>
      <p style="color:#888;font-size:11px">Demo credentials: operator / demo-pass</p>`);
  }

  app.get('/login', (req, res) => { getSession(req, res); res.send(loginPage()); });
  app.post('/login', (req, res) => {
    const s = getSession(req, res);
    if (req.body.username === CREDS.user && req.body.password === CREDS.pass) {
      s.authed = true;
      res.redirect('/members');
    } else {
      res.status(200).send(page('Sign In', `<p style="color:#b00">Invalid credentials.</p>${loginPage()}`));
    }
  });

  app.get('/', (req, res) => { if (!requireAuth(req, res)) return; res.redirect('/members'); });

  function searchPage(error?: string): string {
    return page('Member Search', `
      <h3>Member Search</h3>
      ${error ? `<p style="color:#b00">${esc(error)}</p>` : ''}
      <form method="POST" action="/members/find">
        <table cellpadding="6" style="background:#fff;border:1px solid #ccd">
          <tr>
            <td style="font-weight:bold">${esc(TENANT.labels.memberNumberField)}</td>
            <td><input id="${rid()}" name="memberNumber" aria-label="${esc(TENANT.labels.memberNumberField)}" style="width:180px"></td>
            <td><button type="submit">${esc(TENANT.labels.searchButton)}</button></td>
          </tr>
        </table>
      </form>`);
  }
  app.get('/members', (req, res) => { if (!requireAuth(req, res)) return; res.send(searchPage()); });
  app.post('/members/find', (req, res) => {
    if (!requireAuth(req, res)) return;
    const num = String(req.body.memberNumber ?? '').trim();
    if (!num) return res.send(searchPage('Please enter a member number.'));
    const m = store.get(num);
    if (!m) {
      return res.status(200).send(page('Not Found', `
        <h3>Member Search</h3>
        <div role="alert" style="background:#fff3f3;border:1px solid #e0b4b4;padding:12px">
          <b>No member found</b> for ${esc(TENANT.labels.memberNumberField.toLowerCase())} "${esc(num)}".
        </div>
        <p><a href="/members">Back to search</a></p>`));
    }
    res.redirect(`/members/${m.memberNumber}`);
  });

  app.get('/members/:id', (req, res) => {
    const s = requireAuth(req, res); if (!s) return;
    if (faults.appError) {
      return res.status(500).send(page('Error', `<h3>Application Error</h3>
        <div role="alert">An unexpected error occurred (ref ${rid('err')}). Please try again later.</div>`));
    }
    const m = store.get(req.params.id);
    if (!m) return res.status(404).send(page('Not Found', `<div role="alert">Member not found.</div>`));

    const rows = m.shares.map((sh) => `
      <tr>
        <td>${esc(sh.type)}</td>
        <td>${esc(sh.number)}</td>
        <td align="right">${esc(formatUsd(sh.balance))}</td>
        <td>${esc(sh.status)}</td>
      </tr>`).join('');

    // UI-drift fault: the "Open Sub-Account" control is RENAMED and a decoy link
    // is added. This breaks every recorded rung: role+name (renamed), text
    // (renamed), and relative "the link in this section" (now ambiguous: 2 links).
    // Only semantic re-resolution (self-heal) can recover it.
    const openLabel = faults.renameControls ? 'Create Share' : TENANT.labels.openSubAccount;
    const driftDecoy = faults.renameControls ? `<a href="/members/${esc(m.memberNumber)}" style="margin-right:16px">Print Statement</a>` : '';

    res.send(page(`Member ${m.memberNumber}`, `
      <h3>Member ${esc(m.memberNumber)} — ${esc(m.firstName)} ${esc(m.lastName)}</h3>
      <table cellpadding="4" style="margin-bottom:10px">
        <tr><td style="color:#666">Status</td><td><b>${esc(m.status)}</b></td>
            <td style="color:#666;padding-left:20px">Opened</td><td>${esc(m.dateOpened)}</td>
            <td style="color:#666;padding-left:20px">SSN</td><td>***-**-${esc(m.ssnLast4)}</td></tr>
      </table>
      <table cellpadding="6" cellspacing="0" style="background:#fff;border:1px solid #ccd;min-width:520px">
        <tr style="background:#f0f3f7;font-weight:bold"><td>Share Type</td><td>Account #</td><td align="right">Balance</td><td>Status</td></tr>
        ${rows}
      </table>
      <p style="margin-top:14px">${driftDecoy}<a href="/members/${esc(m.memberNumber)}/subaccounts/new">${esc(openLabel)}</a></p>
    `, { interstitial: faults.interstitial }));
  });

  function subForm(memberNumber: string, error?: string): string {
    const opts = (['Regular Savings', 'Checking', 'Money Market', 'Certificate'] as ShareType[])
      .map((t) => `<option value="${t}">${t}</option>`).join('');
    return page('Open Sub-Account', `
      <h3>${esc(TENANT.labels.openSubAccount)} — Member ${esc(memberNumber)}</h3>
      ${error ? `<div role="alert" style="color:#b00;margin-bottom:8px">${esc(error)}</div>` : ''}
      <form method="POST" action="/members/${esc(memberNumber)}/subaccounts/new">
        <table cellpadding="6" style="background:#fff;border:1px solid #ccd">
          <tr><td style="font-weight:bold">${esc(TENANT.labels.accountTypeField)}</td>
              <td><select name="type" aria-label="${esc(TENANT.labels.accountTypeField)}">${opts}</select></td></tr>
          <tr><td style="font-weight:bold">${esc(TENANT.labels.initialDepositField)}</td>
              <td><input name="deposit" aria-label="${esc(TENANT.labels.initialDepositField)}" placeholder="0.00" style="width:120px"></td></tr>
          <tr><td></td><td><button type="submit">${faults.renameControls ? 'Proceed' : esc(TENANT.labels.continueButton)}</button></td></tr>
        </table>
      </form>
      <p><a href="/members/${esc(memberNumber)}">Cancel</a></p>`);
  }
  app.get('/members/:id/subaccounts/new', (req, res) => {
    const s = requireAuth(req, res); if (!s) return;
    if (!store.get(req.params.id)) return res.status(404).send(page('Not Found', `<div role="alert">Member not found.</div>`));
    res.send(subForm(req.params.id));
  });
  app.post('/members/:id/subaccounts/new', (req, res) => {
    const s = requireAuth(req, res); if (!s) return;
    const m = store.get(req.params.id);
    if (!m) return res.status(404).send(page('Not Found', `<div role="alert">Member not found.</div>`));
    const type = String(req.body.type ?? '') as ShareType;
    const depositRaw = String(req.body.deposit ?? '').trim();

    if (!(type in MIN_INITIAL_DEPOSIT_CENTS)) return res.send(subForm(m.memberNumber, 'Please choose an account type.'));

    const depositNum = Number(depositRaw.replace(/[$,]/g, ''));
    if (depositRaw === '' || Number.isNaN(depositNum) || depositNum < 0) {
      return res.send(subForm(m.memberNumber, 'Initial deposit must be a valid non-negative amount.'));
    }
    const cents = Math.round(depositNum * 100);
    const min = MIN_INITIAL_DEPOSIT_CENTS[type];
    if (cents < min) {
      return res.send(subForm(m.memberNumber, `The minimum opening deposit for ${type} is ${formatUsd(min)}.`));
    }

    if (!ALLOWED_TYPES_BY_STATUS[m.status].includes(type)) {
      return res.status(200).send(page('Not Permitted', `
        <h3>${esc(TENANT.labels.openSubAccount)} — Member ${esc(m.memberNumber)}</h3>
        <div role="alert" style="background:#fff3f3;border:1px solid #e0b4b4;padding:12px">
          <b>Permission denied.</b> A member in status "${esc(m.status)}" is not permitted to open a ${esc(type)} account without a supervisor override.
        </div>
        <p><a href="/members/${esc(m.memberNumber)}/subaccounts/new">Back</a></p>`));
    }

    s.pending = { memberNumber: m.memberNumber, type, verified: false, depositCents: cents };
    res.redirect(`/members/${m.memberNumber}/subaccounts/review`);
  });

  // cascade-only extra step: identity verification, performed ON the review page.
  app.post('/members/:id/subaccounts/verify', (req, res) => {
    const s = requireAuth(req, res); if (!s) return;
    if (s.pending) s.pending.verified = true;
    res.redirect(`/members/${req.params.id}/subaccounts/review`);
  });

  app.get('/members/:id/subaccounts/review', (req, res) => {
    const s = requireAuth(req, res); if (!s) return;
    if (!s.pending || s.pending.memberNumber !== req.params.id) return res.redirect(`/members/${req.params.id}/subaccounts/new`);
    const { type, verified } = s.pending;
    const verifyBlock = TENANT.extraVerifyStep
      ? `<div style="margin:12px 0;padding:10px;background:#fff8ec;border:1px solid #e6d3a3">
           ${verified
             ? '<b style="color:#127a12">✓ Identity Verified</b>'
             : `<b>Member identity must be verified before opening a share.</b>
                <form method="POST" action="/members/${esc(req.params.id)}/subaccounts/verify" style="margin-top:6px">
                  <button type="submit">Identity Verified</button>
                </form>`}
         </div>`
      : '';
    res.send(page('Review', `
      <h3>Review New Sub-Account</h3>
      <table cellpadding="6" style="background:#fff;border:1px solid #ccd">
        <tr><td style="color:#666">Member</td><td><b>${esc(req.params.id)}</b></td></tr>
        <tr><td style="color:#666">${esc(TENANT.labels.accountTypeField)}</td><td><b>${esc(type)}</b></td></tr>
      </table>
      ${verifyBlock}
      <form method="POST" action="/members/${esc(req.params.id)}/subaccounts/confirm" style="margin-top:12px">
        <button type="submit">${esc(TENANT.labels.confirmButton)}</button>
      </form>
      <p><a href="/members/${esc(req.params.id)}/subaccounts/new">Back</a></p>`));
  });

  app.post('/members/:id/subaccounts/confirm', (req, res) => {
    const s = requireAuth(req, res); if (!s) return;
    if (!s.pending || s.pending.memberNumber !== req.params.id) return res.redirect(`/members/${req.params.id}/subaccounts/new`);
    if (TENANT.extraVerifyStep && !s.pending.verified) return res.redirect(`/members/${req.params.id}/subaccounts/review`);
    const share = store.openSubAccount(s.pending.memberNumber, s.pending.type, s.pending.depositCents ?? 0);
    const created = s.pending;
    s.pending = undefined;
    res.send(page('Confirmation', `
      <h3 style="color:#127a12">Sub-Account Opened</h3>
      <div role="status" style="background:#f2fff2;border:1px solid #bde5bd;padding:12px;min-width:420px">
        A new <b>${esc(created.type)}</b> sub-account has been opened for member <b>${esc(req.params.id)}</b>.
        <table cellpadding="4" style="margin-top:8px">
          <tr><td style="color:#666">New Account #</td><td><b>${esc(share.number)}</b></td></tr>
          <tr><td style="color:#666">Status</td><td>${esc(share.status)}</td></tr>
        </table>
      </div>
      <p style="margin-top:12px"><a href="/members/${esc(req.params.id)}">Return to member</a></p>`));
  });

  return app;
}

// Start a server when run directly (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const PORT = Number(process.env.PORT ?? 3100);
  const tenant = getTenant(process.env.TENANT);
  createApp(tenant).listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[mock] ${tenant.brand} on http://localhost:${PORT}  (tenant=${tenant.id})`);
  });
}
