import type { Page, Frame, Locator } from 'playwright';
import type { LocatorSpec, LocatorStrategy } from '../types/locator.js';
import type { ResolveResult } from '../types/surface.js';

/**
 * Turn one strategy into a Playwright Locator. Pure mapping, no I/O. Keeping
 * this a plain function makes the ladder unit-testable against real DOM.
 */
export function strategyToLocator(page: Page | Frame, s: LocatorStrategy): Locator {
  switch (s.kind) {
    case 'role':
      // role name is validated at author time; cast to Playwright's AriaRole union.
      return page.getByRole(s.role as Parameters<Page['getByRole']>[0], s.name ? { name: s.name, exact: s.exact } : {});
    case 'label':
      return page.getByLabel(s.label, { exact: s.exact });
    case 'text':
      return page.getByText(s.text, { exact: s.exact });
    case 'placeholder':
      return page.getByPlaceholder(s.placeholder);
    case 'testId':
      return page.getByTestId(s.testId);
    case 'css':
      return s.nth != null ? page.locator(s.css).nth(s.nth) : page.locator(s.css);
    case 'relative': {
      // nearText: the target inside the smallest block that also contains the
      // anchor text. Works for card/section layouts (no <tr> required): among all
      // elements containing both the anchor text and the target control, the last
      // in document order is the innermost (the card), so we scope to it.
      if (s.relation === 'nearText') {
        const inner = s.target.role
          ? page.getByRole(s.target.role as Parameters<Page['getByRole']>[0], s.target.text ? { name: s.target.text } : {})
          : page.getByText(s.target.text ?? '');
        const container = page.locator('*').filter({ hasText: s.anchor.text }).filter({ has: inner }).last();
        if (s.target.role) return container.getByRole(s.target.role as Parameters<Page['getByRole']>[0], s.target.text ? { name: s.target.text } : {});
        return s.target.text ? container.getByText(s.target.text) : container;
      }
      // Anchor on the cell bearing the anchor text, then take its immediate parent
      // row (ancestor::tr[1]), not any <tr> that merely contains it as a
      // descendant, which in nested-table legacy layouts would also match the outer
      // layout rows and manufacture false ambiguity. Exact anchors match a cell
      // whose text equals the anchor exactly (so "13344" never hits "133440"). We
      // never collapse with .first(): resolveLadder sees the true count and rejects
      // genuine ambiguity.
      const anchorCell = s.anchor.exact
        ? page.getByRole('cell', { name: s.anchor.text, exact: true })
        : page.getByText(s.anchor.text, { exact: false });
      const rows = anchorCell.locator('xpath=ancestor-or-self::tr[1]');
      if (s.relation === 'parentRow') return rows;
      if (s.target.role) {
        return rows.getByRole(
          s.target.role as Parameters<Page['getByRole']>[0],
          s.target.text ? { name: s.target.text, exact: false } : {},
        );
      }
      if (s.target.text) return rows.getByText(s.target.text);
      return rows.locator('input, select, textarea, button, a');
    }
  }
}

const STRATEGY_STABILITY: Record<LocatorStrategy['kind'], number> = {
  role: 0.95,
  label: 0.9,
  testId: 0.9,
  relative: 0.8,
  placeholder: 0.6,
  text: 0.6,
  css: 0.25,
};

export function strategyStability(kind: LocatorStrategy['kind']): number {
  return STRATEGY_STABILITY[kind];
}

/**
 * Walk the ladder, most-stable rung first. A rung wins only if it resolves to
 * exactly one visible element. An ambiguous (>1) match is treated as a miss and
 * we fall through, because acting on the wrong one of several matches is worse
 * than failing loudly. We report which rung won so drift is observable: if a
 * capability that used to resolve on `role` starts resolving on `css`, that's a
 * signal the semantic layer shifted.
 */
export async function resolveLadder(
  page: Page | Frame,
  spec: LocatorSpec,
  timeoutMs = 4000,
): Promise<ResolveResult & { locator?: Locator }> {
  let sawAmbiguous = false;
  const deadline = Date.now() + timeoutMs;

  // one quick retry pass to absorb transient rendering, without a fixed sleep
  for (let attempt = 0; ; attempt++) {
    for (let i = 0; i < spec.strategies.length; i++) {
      const strat = spec.strategies[i]!;
      const loc = strategyToLocator(page, strat);
      let count = 0;
      try {
        count = await loc.count();
      } catch {
        continue;
      }
      if (count === 1) {
        // A hidden singleton must not win over a visible fallback (some strategies,
        // unlike ARIA-role, happily match display:none elements). Fall through.
        const visible = await loc.first().isVisible().catch(() => false);
        if (visible) return { ok: true, strategyKind: strat.kind, strategyIndex: i, matchCount: 1, locator: loc };
        continue;
      }
      if (count > 1) {
        // prefer the first *visible* one only if a single one is visible
        const visible = await firstUniqueVisible(loc, count);
        if (visible) {
          return { ok: true, strategyKind: strat.kind, strategyIndex: i, matchCount: 1, locator: visible };
        }
        sawAmbiguous = true;
      }
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, Math.min(250, Math.max(0, deadline - Date.now()))));
  }

  return {
    ok: false,
    matchCount: sawAmbiguous ? 2 : 0,
    reason: sawAmbiguous ? 'AMBIGUOUS_TARGET' : 'LOCATOR_UNRESOLVED',
  };
}

async function firstUniqueVisible(loc: Locator, count: number): Promise<Locator | null> {
  let found: Locator | null = null;
  for (let i = 0; i < count; i++) {
    const nth = loc.nth(i);
    if (await nth.isVisible().catch(() => false)) {
      if (found) return null; // more than one visible -> genuinely ambiguous
      found = nth;
    }
  }
  return found;
}
