/**
 * Browser-side perception. Runs inside the page via page.evaluate. It computes a
 * pragmatic accessibility view of the DOM: role + accessible name for every
 * actionable/labeled element, which is exactly the information a desktop
 * accessibility API (UIAutomation/AX/AT-SPI) would hand us for a native app.
 *
 * We intentionally do not rely on ids/classes/test-ids here: the mock app (like
 * real legacy apps) randomizes ids and has no test-ids. Role + name + nearby row
 * text is the stable signal, so that's what we surface.
 *
 * Kept in its own module as a plain function so its logic is documented and
 * reviewable; `WebSurface` passes it to page.evaluate.
 */

export interface RichElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  text?: string;
  enabled: boolean;
  editable: boolean;
  rowText?: string;
  // extra signal used only to synthesize durable locators (not shown to the LLM):
  tag: string;
  placeholder?: string;
  nameAttr?: string;
  hasLabel: boolean;
  /** Distinctive nearby label (nearest card/section heading) for proximity anchoring. */
  groupAnchor?: string;
  /** href path for links: a stable handle for icon links with no accessible name. */
  href?: string;
  /** data-test/testid/cy attribute: the best handle when a modern app provides one. */
  testId?: string;
}

export interface PerceptionResult {
  title: string;
  textDigest: string;
  elements: RichElement[];
}

/** The function evaluated in the browser. Self-contained; no external refs. */
export function perceive(): PerceptionResult {
  const collapse = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

  const isVisible = (el: Element): boolean => {
    const he = el as HTMLElement;
    if (he.getClientRects().length === 0) return false;
    const st = window.getComputedStyle(he);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'hidden') return 'none';
      return 'textbox';
    }
    if (el.hasAttribute('onclick')) return 'button';
    return 'generic';
  };

  const labelFor = (el: Element): string => {
    const id = el.getAttribute('id');
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab) return collapse(lab.textContent);
    }
    const wrap = el.closest('label');
    if (wrap) return collapse(wrap.textContent);
    return '';
  };

  const accName = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return collapse(aria);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const txt = labelledby
        .split(/\s+/)
        .map((i) => document.getElementById(i)?.textContent ?? '')
        .join(' ');
      if (collapse(txt)) return collapse(txt);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const l = labelFor(el);
      if (l) return l;
    }
    if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'option') {
      const t = collapse(el.textContent);
      if (t) return t;
    }
    const ph = el.getAttribute('placeholder');
    if (ph) return collapse(ph);
    const title = el.getAttribute('title');
    if (title) return collapse(title);
    if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'submit' || t === 'button') return collapse(el.getAttribute('value'));
    }
    return collapse(el.textContent).slice(0, 60);
  };

  // The distinctive label of the nearest enclosing card/section, used to anchor
  // controls that share an accessible name with siblings (e.g. one of many
  // "Add to cart" buttons is disambiguated by its product name). Works for
  // card/div layouts where table-row anchoring doesn't apply.
  const groupAnchorOf = (el: Element, ownName: string): string | undefined => {
    let node: Element | null = el.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      // scan all candidates in this ancestor (not just the first) and take the
      // first with a usable, distinctive label. A card's long wrapper text
      // shouldn't mask the clean product name inside it.
      const cands = node.querySelectorAll('h1,h2,h3,h4,h5,h6,[class*="name"],[class*="title"],[class*="label"]');
      for (const cand of Array.from(cands)) {
        const t = collapse(cand.textContent);
        if (t && t.length >= 3 && t.length <= 48 && t !== ownName) return t;
      }
    }
    return undefined;
  };
  const hrefPath = (el: Element): string | undefined => {
    const raw = el.getAttribute('href');
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:')) return undefined;
    try {
      return new URL(raw, document.baseURI).pathname.replace(/^\//, '') || undefined;
    } catch {
      return raw.replace(/^\//, '') || undefined;
    }
  };

  // Deep query that pierces open shadow roots: modern enterprise widgets hide
  // their controls in shadow DOM, which document.querySelectorAll won't reach.
  // (Playwright's own locators pierce open shadow DOM, so acting/resolving already
  // works; this is only so the model can see the controls to point at them.)
  const deepQueryAll = (selectorStr: string): Element[] => {
    const out: Element[] = [];
    const seenNodes = new Set<Element>();
    const visit = (root: Document | ShadowRoot) => {
      root.querySelectorAll('*').forEach((el) => {
        if (el.matches(selectorStr) && !seenNodes.has(el)) { seenNodes.add(el); out.push(el); }
        const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (sr) visit(sr);
      });
    };
    visit(document);
    return out;
  };

  // reset previous refs (across shadow roots too)
  deepQueryAll('[data-understudy-ref]').forEach((e) => e.removeAttribute('data-understudy-ref'));

  const selector = 'a[href], button, input, select, textarea, summary, [role], [onclick]';
  const seen = new Set<Element>();
  const elements: RichElement[] = [];
  let idx = 0;

  deepQueryAll(selector).forEach((el) => {
    if (seen.has(el)) return;
    seen.add(el);
    const role = roleOf(el);
    if (role === 'none') return;
    if (!isVisible(el)) return;

    const tag = el.tagName.toLowerCase();
    const name = accName(el);
    const ref = `e${idx++}`;
    el.setAttribute('data-understudy-ref', ref);

    const he = el as HTMLInputElement;
    const inputType = (he.type || '').toLowerCase();
    const editable = tag === 'textarea' || (tag === 'input' && !['submit', 'button', 'reset', 'checkbox', 'radio'].includes(inputType)) || el.getAttribute('contenteditable') === 'true';
    const row = el.closest('tr');
    // Never surface the value of a password/secret field to the model or evidence.
    const isSecret = tag === 'input' && (inputType === 'password' || /pass|secret|otp|cvv|pin/i.test(el.getAttribute('name') || '' + (el.getAttribute('aria-label') || '')));
    const rawValue = 'value' in he && typeof he.value === 'string' ? he.value : undefined;

    elements.push({
      ref,
      role,
      name,
      value: isSecret ? (rawValue ? '[REDACTED]' : undefined) : rawValue,
      text: collapse(el.textContent).slice(0, 80) || undefined,
      enabled: !(el as HTMLButtonElement).disabled,
      editable,
      rowText: row ? collapse(row.textContent).slice(0, 120) : undefined,
      tag,
      placeholder: el.getAttribute('placeholder') ?? undefined,
      nameAttr: el.getAttribute('name') ?? undefined,
      hasLabel: !!labelFor(el) || !!el.getAttribute('aria-label'),
      groupAnchor: groupAnchorOf(el, name),
      href: tag === 'a' ? hrefPath(el) : undefined,
      testId: el.getAttribute('data-test') ?? el.getAttribute('data-testid') ?? el.getAttribute('data-cy') ?? undefined,
    });
  });

  // Also surface data rows (>=3 cells) so the agent can read values (balances,
  // statuses) that live in table cells, not just actionable controls. A row's
  // stable handle is its leading label cell (e.g. "Regular Savings"), which is
  // parameter-independent, unlike the value it contains.
  let rowCount = 0;
  deepQueryAll('tr').forEach((tr) => {
    if (rowCount >= 15 || seen.has(tr)) return;
    const cells = tr.querySelectorAll(':scope > td, :scope > th');
    if (cells.length < 3) return; // skip layout/header-bar rows
    const text = collapse(tr.textContent);
    const label = collapse(cells[0]?.textContent).slice(0, 40);
    if (!text || !label) return;
    seen.add(tr);
    const ref = `e${idx++}`;
    tr.setAttribute('data-understudy-ref', ref);
    rowCount++;
    elements.push({
      ref,
      role: 'row',
      name: label,
      text: text.slice(0, 120),
      enabled: true,
      editable: false,
      rowText: text,
      tag: 'tr',
      hasLabel: false,
    });
  });

  const textDigest = collapse(document.body?.innerText).slice(0, 2000);
  return { title: document.title, textDigest, elements };
}
