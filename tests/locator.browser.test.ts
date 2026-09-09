import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSurface } from '../src/surface/webSurface.js';

/**
 * The robustness claim, proven end-to-end against hostile legacy markup:
 * table layout, RANDOMIZED ids, NO test-ids, non-semantic wrappers. We assert
 * that (a) accessibility role+name targeting resolves uniquely, (b) it still
 * resolves after ids change (drift), and (c) a control with no accessible name
 * is reached via a relative row-anchor.
 */
const legacy = (idSalt: string) => `
<table><tr>
  <td>Member Number</td>
  <td><input aria-label="Member Number" id="ctl_${idSalt}_a" name="memberNumber"></td>
  <td><button id="ctl_${idSalt}_b">Search</button></td>
</tr></table>
<table><tr>
  <td>Initial Deposit</td>
  <td><input id="ctl_${idSalt}_c" name="deposit" placeholder="0.00"></td>
</tr></table>
<div onclick="void 0" style="cursor:pointer">Legacy Action</div>`;

let surface: WebSurface;
beforeAll(async () => {
  surface = await WebSurface.launch({ baseUrl: 'http://localhost', headless: true });
});
afterAll(async () => {
  await surface?.close();
});

describe('accessibility-tree locators vs legacy DOM', () => {
  it('synthesizes a role+name ladder and resolves it uniquely', async () => {
    await surface.page.setContent(legacy('X1'));
    const obs = await surface.observe();
    const field = obs.elements.find((e) => e.role === 'textbox' && e.name === 'Member Number')!;
    expect(field).toBeTruthy();

    const spec = await surface.describeTarget(field.ref);
    expect(spec.strategies[0]!.kind).toBe('role'); // primary rung is role+name
    const r = await surface.resolve(spec);
    expect(r.ok).toBe(true);
    expect(r.matchCount).toBe(1);
    expect(r.strategyKind).toBe('role');
  });

  it('still resolves after element ids change (drift resilience)', async () => {
    await surface.page.setContent(legacy('FIRST'));
    const obs = await surface.observe();
    const field = obs.elements.find((e) => e.role === 'textbox' && e.name === 'Member Number')!;
    const spec = await surface.describeTarget(field.ref);

    // ids all change; role+name is unchanged -> ladder must still win
    await surface.page.setContent(legacy('TOTALLY_DIFFERENT'));
    const r = await surface.resolve(spec);
    expect(r.ok).toBe(true);
    expect(r.strategyKind).toBe('role');
  });

  // regression (F04 / review R07): an exact row anchor must not hit a prefix-colliding row.
  it('exact row anchor selects the precise row, not a prefix-colliding one', async () => {
    await surface.page.setContent('<table><tr><td>133440</td><td>$99.00</td><td>open</td></tr><tr><td>13344</td><td>$10.00</td><td>open</td></tr></table>');
    const spec = { description: 'account 13344', strategies: [{ kind: 'relative' as const, anchor: { text: '13344', exact: true }, relation: 'parentRow' as const, target: {} }], confidence: 1 };
    const r = await surface.resolve(spec);
    expect(r.ok).toBe(true);
    expect(await surface.readSpec(spec, 'text')).toContain('$10.00'); // the 13344 row, not 133440
  });

  // regression (F20 / review R20): a hidden single match must not beat a visible fallback.
  it('skips a hidden singleton and falls back to a visible rung', async () => {
    await surface.page.setContent('<input name="hidden" style="display:none"><input aria-label="Visible">');
    const r = await surface.resolve({ description: 'input', strategies: [{ kind: 'css', css: 'input[name=hidden]' }, { kind: 'role', role: 'textbox', name: 'Visible', exact: false }], confidence: 1 });
    expect(r.ok).toBe(true);
    expect(r.strategyKind).toBe('role'); // not the hidden css
  });

  it('reaches a control with no accessible name via a relative row-anchor', async () => {
    await surface.page.setContent(legacy('X2'));
    const obs = await surface.observe();
    // the deposit input has no aria-label; its stable handle is its row
    const deposit = obs.elements.find((e) => e.role === 'textbox' && e.rowText?.includes('Initial Deposit'))!;
    expect(deposit).toBeTruthy();
    const spec = await surface.describeTarget(deposit.ref);
    const kinds = spec.strategies.map((s) => s.kind);
    expect(kinds).toContain('relative');
    const r = await surface.resolve(spec);
    expect(r.ok).toBe(true);
  });
});
