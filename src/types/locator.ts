import { z } from 'zod';

/**
 * How a control is identified on the surface.
 *
 * The core idea: a target is not one selector, it's an ordered ladder of
 * strategies, most-stable first. At replay time the resolver walks the ladder
 * and accepts the first strategy that resolves to exactly one element. This lets
 * replay survive legacy markup: the CSS/nth rung is only ever reached
 * if every semantic rung above it failed, and we record which rung actually won
 * (so drift is observable).
 *
 * Ordering rationale (best -> worst for legacy enterprise apps):
 *   role      accessibility role + accessible name. Stable across restyles,
 *             survives non-semantic wrappers, and is the one surface that also
 *             exists on desktop apps (UIAutomation / AX / AT-SPI). Primary rung.
 *   label     form control resolved via its <label>/aria-label. (role+name for
 *             inputs, called out separately because legacy label wiring varies.)
 *   placeholder / altText / title  weak accessible-name fallbacks.
 *   text      visible text content. Good for links/buttons with no role.
 *   relative  anchored to a nearby stable landmark, e.g. "the textbox in the
 *             same table row as the cell reading 'Member Number'". Essential for
 *             table-based legacy layouts with no per-field identity.
 *   css       raw selector. Brittle (ids here are randomized), last resort only.
 */

export const roleStrategy = z.object({
  kind: z.literal('role'),
  role: z.string().describe('ARIA role, e.g. "button", "textbox", "link", "combobox"'),
  name: z.string().optional().describe('Accessible name (visible label / aria-label)'),
  exact: z.boolean().default(false).describe('Exact name match vs. substring/normalized'),
});

export const labelStrategy = z.object({
  kind: z.literal('label'),
  label: z.string().describe('Associated label / aria-label of a form control'),
  exact: z.boolean().default(false),
});

export const textStrategy = z.object({
  kind: z.literal('text'),
  text: z.string().describe('Visible text content of the element'),
  exact: z.boolean().default(false),
  /** Bind the text to an input parameter (e.g. locate the link whose text is {accountId}). */
  fromInput: z.string().optional(),
});

export const placeholderStrategy = z.object({
  kind: z.literal('placeholder'),
  placeholder: z.string(),
});

export const testIdStrategy = z.object({
  kind: z.literal('testId'),
  testId: z.string(),
});

export const cssStrategy = z.object({
  kind: z.literal('css'),
  css: z.string().describe('Raw CSS selector — brittle, last resort'),
  nth: z.number().int().nonnegative().optional(),
});

/**
 * Anchor a target relative to a stable landmark. Resolves the anchor first, then
 * finds the requested control in relation to it. Purpose-built for table layouts.
 */
export const relativeStrategy = z.object({
  kind: z.literal('relative'),
  anchor: z.object({
    text: z.string().describe('Stable visible text of the landmark, e.g. a row header cell'),
    exact: z.boolean().default(false),
    /** Bind the anchor to an input parameter (e.g. the row for account {accountId}). */
    fromInput: z.string().optional(),
  }),
  relation: z
    .enum(['sameRow', 'following', 'parentRow', 'nearText'])
    .describe('sameRow: control in the same <tr>; parentRow: the row containing the anchor; nearText: the control inside the smallest block (card/section) that also contains the anchor text — works for non-table layouts'),
  target: z.object({
    role: z.string().optional(),
    text: z.string().optional(),
  }),
});

export const locatorStrategy = z.discriminatedUnion('kind', [
  roleStrategy,
  labelStrategy,
  textStrategy,
  placeholderStrategy,
  testIdStrategy,
  relativeStrategy,
  cssStrategy,
]);
export type LocatorStrategy = z.infer<typeof locatorStrategy>;

export const locatorSpec = z.object({
  description: z.string().describe('Human-readable description of the target control'),
  strategies: z.array(locatorStrategy).min(1).describe('Ordered ladder, most-stable first'),
  /** Frame hint for controls inside an iframe/frameset. Replay prefers a frame
   *  matching this hint, else searches all frames; not an ephemeral index. */
  frame: z
    .object({ name: z.string().optional(), urlIncludes: z.string().optional() })
    .optional(),
  /** The discoverer's stated confidence that this ladder is robust (0..1). */
  confidence: z.number().min(0).max(1).default(0.5),
  /** Free-form robustness reasoning, surfaced to human reviewers of the capability. */
  robustnessNotes: z.string().optional(),
});
export type LocatorSpec = z.infer<typeof locatorSpec>;
