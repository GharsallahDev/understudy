import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSurface } from '../src/surface/webSurface.js';

/**
 * Real bank consoles hide the actual screen inside iframes/framesets, and modern
 * widgets hide controls in shadow DOM. These tests prove understudy perceives,
 * resolves, and acts on controls in BOTH — not just the top-level document.
 */
let surface: WebSurface;
beforeAll(async () => { surface = await WebSurface.launch({ baseUrl: 'http://localhost', headless: true }); });
afterAll(async () => { await surface?.close(); });

async function waitForFrames(n: number) {
  const until = Date.now() + 3000;
  while (surface.page.frames().length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
}

describe('iframe / frameset support', () => {
  it('perceives, targets, and acts on a control inside an iframe', async () => {
    await surface.page.setContent(
      `<h1>Outer console</h1>
       <iframe name="core" srcdoc="<button>Post Transaction</button> <input aria-label='Member Number'>"></iframe>`,
    );
    await waitForFrames(2);
    const obs = await surface.observe();

    const btn = obs.elements.find((e) => e.role === 'button' && e.name === 'Post Transaction');
    expect(btn).toBeTruthy();
    expect(btn!.ref).toMatch(/^f\d+:/); // lives in a child frame, not the main document

    const spec = await surface.describeTarget(btn!.ref);
    expect(spec.frame).toBeTruthy(); // durable frame hint recorded
    const r = await surface.resolve(spec);
    expect(r.ok).toBe(true); // resolves by searching frames

    // acting by ref routes to the owning frame
    const field = obs.elements.find((e) => e.role === 'textbox' && e.name === 'Member Number')!;
    await surface.typeRef(field.ref, '100123');
    const val = await surface.readSpec(await surface.describeTarget(field.ref), 'value');
    expect(val).toBe('100123');
  });
});

describe('shadow DOM support', () => {
  it('perceives and resolves a control inside an open shadow root', async () => {
    await surface.page.setContent('<div id="host"></div>');
    await surface.page.evaluate(() => {
      const host = document.getElementById('host')!;
      host.attachShadow({ mode: 'open' }).innerHTML = '<button>Approve Loan</button>';
    });
    const obs = await surface.observe();
    const btn = obs.elements.find((e) => e.role === 'button' && e.name === 'Approve Loan');
    expect(btn).toBeTruthy();
    const r = await surface.resolve(await surface.describeTarget(btn!.ref));
    expect(r.ok).toBe(true);
  });
});
