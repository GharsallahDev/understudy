import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Locator } from 'playwright';
import type { Surface, Observation, ObservedElement, ResolveResult } from '../types/surface.js';
import type { LocatorSpec, LocatorStrategy } from '../types/locator.js';
import { perceive, type RichElement } from './perception.js';
import { resolveLadder, strategyStability } from './locator.js';
import { redactString } from '../safety/redaction.js';

export interface WebSurfaceOptions {
  baseUrl: string;
  headless?: boolean;
  /** slow motion for human-observable discovery/handoff, ms */
  slowMo?: number;
}

/**
 * Playwright-backed Surface that perceives via a computed accessibility tree and
 * targets controls by role/name/relative-anchor rather than ids/test-ids.
 *
 * The browser is headed by default: the discovery run is meant to be watchable,
 * and the human-in-the-loop handoff hands a real, live browser
 * window to a person. Same window, same session.
 */
export class WebSurface implements Surface {
  private lastRich: Array<RichElement & { frameId: string; frameUrl: string; frameName: string }> = [];
  private lastFramesById = new Map<string, Frame>();
  private lastStatus?: number;
  /** Optional navigation guard: after any action that can navigate, the resolved
   *  URL is checked here. Centralizes destination enforcement so link clicks,
   *  form submits and redirects can't slip past the policy. */
  private navGuard?: (url: string) => { allowed: boolean; reason?: string };

  private constructor(
    private readonly browser: Browser,
    readonly context: BrowserContext,
    readonly page: Page,
    private readonly baseUrl: string,
  ) {}

  static async launch(opts: WebSurfaceOptions): Promise<WebSurface> {
    const browser = await chromium.launch({ headless: opts.headless ?? false, slowMo: opts.slowMo ?? 0 });
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    // tsx/esbuild transpiles page.evaluate'd functions with a `__name` name-keeper
    // helper that doesn't exist in the browser realm; shim it as identity so
    // perception (and human-capture) init scripts run cleanly.
    await context.addInitScript(() => {
      (globalThis as unknown as { __name?: (f: unknown) => unknown }).__name ??= (f: unknown) => f;
    });
    const page = await context.newPage();
    const surface = new WebSurface(browser, context, page, opts.baseUrl.replace(/\/$/, ''));
    page.on('response', (r) => {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) surface.lastStatus = r.status();
    });
    return surface;
  }

  get browserContext(): BrowserContext { return this.context; }

  private resolveUrl(routeOrUrl: string): string {
    if (/^https?:\/\//.test(routeOrUrl)) return routeOrUrl;
    return this.baseUrl + (routeOrUrl.startsWith('/') ? routeOrUrl : '/' + routeOrUrl);
  }

  async navigate(url: string): Promise<void> {
    const resp = await this.page.goto(this.resolveUrl(url), { waitUntil: 'domcontentloaded' });
    if (resp) this.lastStatus = resp.status();
    await this.settle();
  }

  /**
   * Let the page settle after an action that may navigate. domcontentloaded is
   * the correctness signal; a short, bounded networkidle absorbs async apps
   * without hanging on ones that poll. Never a fixed sleep.
   */
  private async settle(): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    await this.page.waitForLoadState('networkidle', { timeout: 1200 }).catch(() => {});
    this.enforceNav();
  }

  /** Install the navigation guard (typically wired to the PolicyEngine). */
  setNavigationGuard(fn: (url: string) => { allowed: boolean; reason?: string }): void {
    this.navGuard = fn;
  }

  /** Throw if the current resolved URL is outside policy: catches link/form/redirect nav. */
  private enforceNav(): void {
    if (!this.navGuard) return;
    const url = this.page.url();
    if (url === 'about:blank') return;
    const d = this.navGuard(url);
    if (!d.allowed) throw new PolicyError(url, d.reason ?? 'destination not allowlisted');
  }

  async observe(): Promise<Observation> {
    // let the DOM settle without a blind sleep
    await this.page.waitForLoadState('domcontentloaded').catch(() => {});
    // Perceive every frame (main + iframes/framesets), not just the top document.
    // Refs are namespaced by frame ("f2:e5") and routed back to the owning frame
    // when acted on. Cross-origin frames throw on evaluate and are skipped.
    const frames = this.page.frames();
    this.lastFramesById = new Map();
    const rich: typeof this.lastRich = [];
    const elements: ObservedElement[] = [];
    const digests: string[] = [];
    let title = '';
    for (let fi = 0; fi < frames.length; fi++) {
      const frame = frames[fi];
      if (!frame) continue;
      let result;
      try {
        result = await frame.evaluate(perceive);
      } catch {
        continue; // detached or cross-origin frame, cannot perceive
      }
      const frameId = `f${fi}`;
      this.lastFramesById.set(frameId, frame);
      if (fi === 0) title = result.title;
      if (result.textDigest) digests.push(fi === 0 ? result.textDigest : `[frame ${frame.name() || fi}] ${result.textDigest}`);
      for (const e of result.elements) {
        const ref = `${frameId}:${e.ref}`;
        rich.push({ ...e, ref, frameId, frameUrl: frame.url(), frameName: frame.name() });
        elements.push({ ref, role: e.role, name: e.name, value: e.value, text: e.text, enabled: e.enabled, editable: e.editable, rowText: e.rowText });
      }
    }
    this.lastRich = rich;
    return {
      url: this.page.url(),
      title,
      lastResponseStatus: this.lastStatus,
      elements,
      textDigest: digests.join('\n').slice(0, 3000),
    };
  }

  /** Parse a namespaced ref "f{i}:e{n}" into its frame + local ref. */
  private frameFor(ref: string): { frame: Page | Frame; local: string } {
    const i = ref.indexOf(':');
    if (i > 0) {
      const frameId = ref.slice(0, i);
      const frame = this.lastFramesById.get(frameId);
      if (frame) return { frame, local: ref.slice(i + 1) };
    }
    return { frame: this.page, local: ref };
  }

  // --- discovery-time acts (by ref) ---
  private refSel(ref: string): string { return `[data-understudy-ref="${ref}"]`; }

  async clickRef(ref: string): Promise<void> {
    const { frame, local } = this.frameFor(ref);
    await frame.locator(this.refSel(local)).first().click({ timeout: 8000 });
    await this.settle();
  }
  async typeRef(ref: string, text: string): Promise<void> {
    const { frame, local } = this.frameFor(ref);
    await frame.locator(this.refSel(local)).first().fill(text, { timeout: 8000 });
    await this.settle();
  }
  async selectRef(ref: string, value: string): Promise<void> {
    const { frame, local } = this.frameFor(ref);
    await frame.locator(this.refSel(local)).first().selectOption({ label: value }).catch(async () => {
      await frame.locator(this.refSel(local)).first().selectOption(value);
    });
    await this.settle();
  }
  async readRef(ref: string): Promise<string> {
    const { frame, local } = this.frameFor(ref);
    return (await frame.locator(this.refSel(local)).first().textContent())?.trim() ?? '';
  }

  /**
   * Synthesize a durable locator ladder for a ref, from the element's computed
   * accessibility properties + surrounding structure. This is the bridge from
   * "the model pointed at element e5" to "here is how to find it forever."
   */
  async describeTarget(ref: string): Promise<LocatorSpec> {
    const el = this.lastRich.find((e) => e.ref === ref);
    if (!el) throw new Error(`describeTarget: unknown ref ${ref}`);
    const strategies: LocatorStrategy[] = [];
    // Record a durable frame hint (name/url path) if the control lives in an
    // iframe/frameset, not the ephemeral frame index.
    const frameHint =
      el.frameId && el.frameId !== 'f0'
        ? { ...(el.frameName ? { name: el.frameName } : {}), ...(framePath(el.frameUrl) ? { urlIncludes: framePath(el.frameUrl) } : {}) }
        : undefined;

    // Data rows: anchor by the row's stable leading label, not its (variable)
    // value, so extraction stays correct for any input parameter.
    if (el.role === 'row' && el.name) {
      return {
        // Exact cell anchor: the row's leading cell is a full value (e.g. an
        // account number), so exact matching prevents "13344" hitting "133440".
        description: `row "${el.name}"`,
        strategies: [{ kind: 'relative', anchor: { text: el.name, exact: true }, relation: 'parentRow', target: {} }],
        confidence: 0.85,
        robustnessNotes: `Row anchored on its stable leading cell "${el.name}" (exact); the value it contains is read from the row text and is parameter-independent.`,
        ...(frameHint && Object.keys(frameHint).length ? { frame: frameHint } : {}),
      };
    }

    // 1. role + accessible name: the primary, most durable rung
    if (el.name && el.role !== 'generic') {
      strategies.push({ kind: 'role', role: el.role, name: el.name, exact: false });
    }
    // 2. form control by label
    if (el.hasLabel && el.name && (el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea')) {
      strategies.push({ kind: 'label', label: el.name, exact: false });
    }
    // 3. placeholder (weak accessible name)
    if (el.placeholder) strategies.push({ kind: 'placeholder', placeholder: el.placeholder });
    // 4. visible text for text-bearing controls with no role/name match
    if (el.text && (el.role === 'link' || el.role === 'button' || el.role === 'generic')) {
      strategies.push({ kind: 'text', text: el.text, exact: false });
    }
    // 5. relative anchor via the table row: essential for table layouts
    if (el.rowText && el.role) {
      const anchor = deriveRowAnchor(el);
      if (anchor) strategies.push({ kind: 'relative', anchor: { text: anchor, exact: false }, relation: 'sameRow', target: { role: el.role } });
    }
    // 6. proximity anchor: the control inside the card/section whose distinctive
    //    label is `groupAnchor`. Disambiguates repeated names (e.g. one of many
    //    "Add to cart" buttons) on non-table, card-based layouts.
    if (el.groupAnchor && el.role && el.name) {
      strategies.push({ kind: 'relative', anchor: { text: el.groupAnchor, exact: false }, relation: 'nearText', target: { role: el.role, text: el.name } });
    }
    // 7. href-based CSS for links: the stable handle for icon links that have no
    //    accessible name (a common real-world a11y gap). Uses the path, not ids.
    if (el.tag === 'a' && el.href) {
      const frag = el.href.split('?')[0]!.split('#')[0]!;
      if (frag) strategies.push({ kind: 'css', css: `a[href*="${frag}"]` });
    }
    // 8. name-attribute CSS: more stable than randomized ids, but still a fallback
    if (el.nameAttr) strategies.push({ kind: 'css', css: `[name="${el.nameAttr}"]` });

    if (strategies.length === 0) {
      // last resort: text or a very weak css
      if (el.text) strategies.push({ kind: 'text', text: el.text, exact: false });
      else strategies.push({ kind: 'css', css: el.tag });
    }

    const confidence = Math.max(...strategies.map((s) => strategyStability(s.kind)));
    return {
      description: describe(el),
      strategies,
      confidence,
      robustnessNotes: robustnessNote(strategies),
      ...(frameHint && Object.keys(frameHint).length ? { frame: frameHint } : {}),
    };
  }

  /**
   * Resolve a spec across all frames (main + iframes/framesets). If the spec
   * carries a frame hint, matching frames are tried first; otherwise every frame
   * is searched. A resolution wins only if exactly one frame yields a unique
   * match: multiple frames matching is ambiguity, not a silent pick. The frame
   * index is never baked into the artifact, so this stays durable across runs.
   */
  private async resolveAcrossFrames(spec: LocatorSpec): Promise<ResolveResult & { locator?: Locator }> {
    const frames = this.page.frames();
    const hint = spec.frame;
    const preferred = hint
      ? frames.filter((f) => (hint.name ? f.name() === hint.name : true) && (hint.urlIncludes ? f.url().includes(hint.urlIncludes) : true))
      : [];
    const ordered = preferred.length ? [...preferred, ...frames.filter((f) => !preferred.includes(f))] : frames;
    const wins: Array<ResolveResult & { locator?: Locator }> = [];
    for (const frame of ordered) {
      const r = await resolveLadder(frame, spec, 1500);
      if (r.ok) {
        wins.push(r);
        // With a frame hint, the first preferred-frame hit is authoritative.
        if (hint && preferred.includes(frame)) return r;
      }
    }
    if (wins.length === 1) return wins[0]!;
    if (wins.length > 1) return { ok: false, matchCount: wins.length, reason: 'AMBIGUOUS_TARGET' };
    return { ok: false, matchCount: 0, reason: 'LOCATOR_UNRESOLVED' };
  }

  // --- replay-time acts (by spec) ---
  async resolve(spec: LocatorSpec): Promise<ResolveResult> {
    const r = await this.resolveAcrossFrames(spec);
    return { ok: r.ok, strategyKind: r.strategyKind, strategyIndex: r.strategyIndex, matchCount: r.matchCount, reason: r.reason };
  }
  async clickSpec(spec: LocatorSpec): Promise<void> {
    const r = await this.resolveAcrossFrames(spec);
    if (!r.ok || !r.locator) throw new LocatorError(spec, r.reason ?? 'LOCATOR_UNRESOLVED');
    // Pre-check link destinations before navigating (prevention, not just detection).
    if (this.navGuard) {
      const href = await r.locator.getAttribute('href').catch(() => null);
      if (href) {
        let dest = href;
        try { dest = new URL(href, this.page.url()).toString(); } catch { /* keep raw */ }
        const d = this.navGuard(dest);
        if (!d.allowed) throw new PolicyError(dest, d.reason ?? 'destination not allowlisted');
      }
    }
    await r.locator.click({ timeout: 8000 });
    await this.settle();
  }
  async typeSpec(spec: LocatorSpec, text: string): Promise<void> {
    const r = await this.resolveAcrossFrames(spec);
    if (!r.ok || !r.locator) throw new LocatorError(spec, r.reason ?? 'LOCATOR_UNRESOLVED');
    await r.locator.fill(text, { timeout: 8000 });
    await this.settle();
  }
  async selectSpec(spec: LocatorSpec, value: string): Promise<void> {
    const r = await this.resolveAcrossFrames(spec);
    if (!r.ok || !r.locator) throw new LocatorError(spec, r.reason ?? 'LOCATOR_UNRESOLVED');
    await r.locator.selectOption({ label: value }).catch(async () => { await r.locator!.selectOption(value); });
    await this.settle();
  }
  async readSpec(spec: LocatorSpec, attribute: 'text' | 'value'): Promise<string> {
    const r = await this.resolveAcrossFrames(spec);
    if (!r.ok || !r.locator) throw new LocatorError(spec, r.reason ?? 'LOCATOR_UNRESOLVED');
    if (attribute === 'value') return (await r.locator.inputValue().catch(() => '')) ?? '';
    return (await r.locator.textContent())?.trim() ?? '';
  }

  async pressKey(key: string): Promise<void> { await this.page.keyboard.press(key); await this.settle(); }
  async screenshot(path: string): Promise<void> { await this.page.screenshot({ path, fullPage: false }).catch(() => {}); }
  async htmlSnapshot(path: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    let html = await this.page.content();
    // Redact secret-field values and pattern-matched secrets before persisting.
    html = html
      .replace(/(<input\b[^>]*\btype=["']?password["']?[^>]*\bvalue=["'])[^"']*(["'])/gi, '$1[REDACTED]$2')
      .replace(/(<input\b[^>]*\bvalue=["'])[^"']*(["'][^>]*\btype=["']?password)/gi, '$1[REDACTED]$2');
    html = redactString(html);
    await writeFile(path, html, 'utf8').catch(() => {});
  }
  async close(): Promise<void> { await this.browser.close().catch(() => {}); }
}

export class LocatorError extends Error {
  constructor(readonly spec: LocatorSpec, readonly reason: string) {
    super(`${reason}: ${spec.description}`);
    this.name = 'LocatorError';
  }
}

/** Thrown when an action resolves to / navigates to a destination outside policy. */
export class PolicyError extends Error {
  constructor(readonly url: string, readonly reason: string) {
    super(`POLICY_BLOCKED: ${reason} (${url})`);
    this.name = 'PolicyError';
  }
}

/** Derive a stable row-anchor label from a row like "Member Number  [input]". */
function deriveRowAnchor(el: RichElement): string | undefined {
  if (!el.rowText) return undefined;
  // take the leading label-ish text of the row (before the control's own value)
  const head = el.rowText.replace(el.name, '').trim();
  const firstCell = head.split(/\s{2,}|\t/)[0]?.trim();
  return firstCell && firstCell.length >= 3 ? firstCell : head.slice(0, 40) || undefined;
}

/** A stable, comparable fragment of a frame URL (path) for the frame hint. */
function framePath(url: string): string | undefined {
  if (!url || url === 'about:blank') return undefined;
  try {
    return new URL(url).pathname.replace(/\/$/, '') || undefined;
  } catch {
    return undefined;
  }
}

function describe(el: RichElement): string {
  const n = el.name ? ` "${el.name}"` : el.text ? ` "${el.text}"` : '';
  return `${el.role}${n}`.trim();
}

function robustnessNote(strategies: LocatorStrategy[]): string {
  const top = strategies[0]?.kind;
  const rungs = strategies.map((s) => s.kind).join(' > ');
  if (top === 'role') return `Primary rung is accessibility role+name (survives restyles & non-semantic wrappers); ladder: ${rungs}.`;
  if (top === 'label') return `Primary rung is the control's label; ladder: ${rungs}.`;
  return `No stable accessible name; relying on ${top}. Ladder: ${rungs}. Review recommended.`;
}
