import type { LocatorSpec } from './locator.js';

/**
 * The Surface abstraction: the single seam between "how we perceive and act on
 * a UI" and "the recorded flow." Everything above this interface (the agent
 * loop, the recorder, the replay engine, conditions, safety) is surface-
 * agnostic and speaks only in accessibility terms: roles, names, text.
 *
 * Today there is one implementation, `WebSurface` (Playwright, perceiving via a
 * computed accessibility tree). The design claim in the write-up, that this
 * extends to a legacy web app or a native desktop app, rests entirely on this
 * interface: a `DesktopSurface` backed by Windows UIAutomation / macOS AX /
 * AT-SPI would expose the same `ObservedElement[]` (those platforms already
 * publish role + name), and nothing above this seam would change. The artifact,
 * the locator ladders, and the replay engine are all expressed in terms the
 * accessibility tree provides on every platform.
 */

export interface ObservedElement {
  /** Ephemeral handle valid only for the current observation (never persisted). */
  ref: string;
  role: string;
  name: string;
  value?: string;
  /** short visible text (may equal name for buttons/links) */
  text?: string;
  enabled: boolean;
  editable: boolean;
  /** Stable-ish text of the table row the element sits in, for relative locators. */
  rowText?: string;
}

export interface Observation {
  url: string;
  title: string;
  /** HTTP status of the last main-frame navigation, if known. */
  lastResponseStatus?: number;
  /** Actionable / labeled elements the agent may target, each with a `ref`. */
  elements: ObservedElement[];
  /** A truncated digest of visible page text, for condition detection + LLM context. */
  textDigest: string;
}

export interface ResolveResult {
  ok: boolean;
  /** Which rung of the ladder resolved (for evidence / drift detection). */
  strategyKind?: string;
  strategyIndex?: number;
  matchCount: number;
  reason?: string;
}

/**
 * The operations the layers above need. Implemented per surface technology.
 */
export interface Surface {
  /** Perceive current state as roles/names/text. */
  observe(): Promise<Observation>;

  /** Navigate to a concrete URL (route already resolved against the base URL). */
  navigate(url: string): Promise<void>;

  // --- discovery-time acts (by ephemeral ref) ---
  clickRef(ref: string): Promise<void>;
  typeRef(ref: string, text: string): Promise<void>;
  selectRef(ref: string, value: string): Promise<void>;
  readRef(ref: string): Promise<string>;
  /** Synthesize a durable locator ladder for the element behind a ref. */
  describeTarget(ref: string): Promise<LocatorSpec>;

  // --- replay-time acts (by durable LocatorSpec) ---
  resolve(spec: LocatorSpec): Promise<ResolveResult>;
  clickSpec(spec: LocatorSpec): Promise<void>;
  typeSpec(spec: LocatorSpec, text: string): Promise<void>;
  selectSpec(spec: LocatorSpec, value: string): Promise<void>;
  readSpec(spec: LocatorSpec, attribute: 'text' | 'value'): Promise<string>;

  pressKey(key: string): Promise<void>;

  /** Optional: install a guard checked after any navigating action (policy enforcement). */
  setNavigationGuard?(fn: (url: string) => { allowed: boolean; reason?: string }): void;

  // --- evidence ---
  screenshot(path: string): Promise<void>;
  htmlSnapshot(path: string): Promise<void>;

  close(): Promise<void>;
}
