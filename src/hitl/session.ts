import type { WebSurface } from '../surface/webSurface.js';
import type { Evidence } from '../evidence.js';
import type { OperatorHub, ResumeSignal } from './operatorHub.js';
import type { ControlOwner, InterventionContext, CapturedAction } from './types.js';
import type { Observation } from '../types/surface.js';
import { redactString } from '../safety/redaction.js';

/**
 * SessionControl owns the control-transfer state for one live run. It is the
 * only thing that flips ownership between automation and human, and it does the
 * capture/pause/resume dance on the same Playwright session the run is using.
 */
export class SessionControl {
  owner: ControlOwner = 'automation';
  private seq = 0;
  private captureSink: ((a: CapturedAction) => void) | null = null;
  private bindingReady = false;
  private captureWired = false;

  constructor(
    private readonly surface: WebSurface,
    private readonly hub: OperatorHub,
    private readonly evidence: Evidence,
    private readonly base: { goal: string; capabilityId: string; tenantId: string; runId: string },
  ) {}

  /**
   * Pause automation, hand the live session to a human, and block until they
   * return control. Everything the human does is captured and attached to the
   * intervention as evidence.
   */
  async escalate(partial: {
    reason: string;
    condition: InterventionContext['condition'];
    stepId?: string;
    stepIntent?: string;
  }): Promise<ResumeSignal & { interventionId: string }> {
    this.owner = 'human';
    const obs = await this.surface.observe();
    const screenshotPath = this.evidence.nextScreenshotPath('handoff');
    await this.surface.screenshot(screenshotPath);
    const snapshotPath = this.evidence.path(`handoff-${this.seq}.html`);
    await this.surface.htmlSnapshot(snapshotPath);

    const context: InterventionContext = {
      ...this.base,
      currentUrl: obs.url,
      stateSummary: summarize(obs),
      screenshotPath,
      snapshotPath,
      reason: partial.reason,
      condition: partial.condition,
      stepId: partial.stepId,
      stepIntent: partial.stepIntent,
    };

    const { id, wait } = this.hub.escalate(context, this.seq++);
    this.evidence.log('warn', `HANDOFF → human: ${partial.reason}`, {
      interventionId: id,
      condition: partial.condition,
      detail: `open operator console to take control`,
    });

    const stopCapture = await this.startHumanCapture((a) => this.hub.recordAction(id, a));
    const signal = await wait; // <-- pause gate: automation is idle while the human drives
    await stopCapture();

    this.owner = 'automation';
    this.evidence.log('info', `HANDBACK ← human (${signal.resolvedBy})`, {
      interventionId: id,
      capturedActions: signal.capturedActions.length,
      detail: signal.note ?? '',
    });
    this.evidence.writeJson(`handoff-${id}.json`, { context, resolution: signal });
    return { ...signal, interventionId: id };
  }

  /** Attach click/input/navigation capture to the current live session. */
  private async startHumanCapture(sink: (a: CapturedAction) => void): Promise<() => Promise<void>> {
    this.captureSink = (a) => sink({ ...a, detail: a.detail ? redactString(a.detail) : a.detail, target: a.target ? redactString(a.target) : a.target });
    const { page, context } = this.surface;

    if (!this.bindingReady) {
      await context.exposeBinding('__understudyHuman', (_src, payload: CapturedAction) => this.captureSink?.(payload)).catch(() => {});
      this.bindingReady = true;
    }

    const attach = () => {
      // runs in the browser; re-runs per document via addInitScript
      const w = window as unknown as { __uAttached?: boolean; __understudyHuman?: (a: unknown) => void };
      if (w.__uAttached) return;
      w.__uAttached = true;
      const desc = (el: Element | null): string => {
        if (!el) return 'unknown';
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const name = el.getAttribute('aria-label') || (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        return `${role} "${name}"`;
      };
      document.addEventListener(
        'click',
        (e) => {
          const t = (e.target as Element)?.closest('a,button,input,select,[role],[onclick]') || (e.target as Element);
          w.__understudyHuman?.({ type: 'click', target: desc(t) });
        },
        true,
      );
      document.addEventListener(
        'change',
        (e) => {
          const t = e.target as HTMLInputElement;
          w.__understudyHuman?.({ type: 'input', target: desc(t), detail: `value len=${(t.value || '').length}` });
        },
        true,
      );
    };

    // Attach DOM listeners at most once per document (guarded by __uAttached, which
    // we deliberately don't reset on stop). Between handoffs the listeners stay put
    // and simply route to `captureSink`, which is null when not capturing, so a
    // second handoff never double-attaches and never double-captures (F14).
    if (!this.captureWired) {
      await context.addInitScript(attach); // re-runs the guarded attach on future documents
      this.captureWired = true;
    }
    await page.evaluate(attach).catch(() => {});

    // Stable, exact handler reference so on()/off() actually pair up.
    const navHandler = (f: import('playwright').Frame) => {
      if (f === page.mainFrame()) this.captureSink?.({ type: 'navigate', url: page.url() });
    };
    page.on('framenavigated', navHandler);

    return async () => {
      page.off('framenavigated', navHandler);
      this.captureSink = null; // stop capturing; listeners remain but no-op until next handoff
    };
  }
}

function summarize(obs: Observation): string {
  const controls = obs.elements
    .filter((e) => ['button', 'link', 'textbox', 'combobox'].includes(e.role))
    .slice(0, 8)
    .map((e) => `${e.role}:"${e.name}"`)
    .join(', ');
  return `URL ${obs.url}\nTitle: ${obs.title}\nText: ${obs.textDigest.slice(0, 240)}\nControls: ${controls}`;
}
