import type { ActionKind, Capability, Step } from '../types/capability.js';

/**
 * Guardrail model.
 *
 * Two enforcement points share one policy:
 *   - discovery: every action the model proposes is checked before it runs; a
 *     blocked action is fed back to the model as an error, not executed.
 *   - replay: every step is checked before it runs; a violation is a hard
 *     POLICY_BLOCKED failure (we never silently proceed).
 *
 * The effective policy is the intersection of the global policy (operator-set)
 * and the capability's declared `scope`: a capability can only ever narrow what
 * it's allowed to touch, never widen it.
 */

export interface GlobalPolicy {
  /** Hostnames the agent may navigate to. */
  allowedHosts: string[];
  /** Route glob patterns (path only), e.g. "/members", "/members/*". */
  allowedRoutes: string[];
  allowedActions: ActionKind[];
  /** How to treat steps marked risky (irreversible). */
  riskyActionHandling: 'block' | 'require_confirmation' | 'flag';
}

export const DEFAULT_POLICY: GlobalPolicy = {
  allowedHosts: ['localhost', '127.0.0.1'],
  allowedRoutes: ['/login', '/members', '/members/**'],
  allowedActions: ['navigate', 'click', 'type', 'select', 'press', 'read', 'assert', 'waitFor'],
  riskyActionHandling: 'require_confirmation',
};

export type PolicyDecision =
  | { allowed: true; requiresConfirmation?: boolean; note?: string }
  | { allowed: false; reason: string };

/** Convert a route/host glob ("**" = any, "*" = one segment, ":x" = param) to a RegExp. */
function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = esc
    .replace(/\*\*/g, '§DBL§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DBL§/g, '.*')
    .replace(/:[A-Za-z0-9_]+/g, '[^/]+');
  return new RegExp(`^${body}$`);
}

export class PolicyEngine {
  private readonly allowedHosts: Set<string>;
  /** Global (operator-set) route matchers: the outer bound. */
  private readonly globalRouteMatchers: RegExp[];
  /** Capability scope matchers (null if no scope): narrows within the global. */
  private readonly scopeRouteMatchers: RegExp[] | null;
  private readonly allowedActions: Set<ActionKind>;

  constructor(
    private readonly global: GlobalPolicy = DEFAULT_POLICY,
    scope?: Capability['scope'],
  ) {
    this.allowedHosts = new Set(global.allowedHosts);
    // True intersection: a route must satisfy the global policy and (if present)
    // the capability scope. The two matcher sets are kept separate and both must
    // pass: a capability can only ever narrow what the operator allowed, never
    // widen it. (Previously these were concatenated, which is a union bug.)
    this.globalRouteMatchers = global.allowedRoutes.map(globToRegExp);
    this.scopeRouteMatchers = scope?.allowedRoutes ? scope.allowedRoutes.map(globToRegExp) : null;
    const scopeActions = scope?.allowedActions;
    this.allowedActions = new Set(
      scopeActions ? global.allowedActions.filter((a) => scopeActions.includes(a)) : global.allowedActions,
    );
  }

  hostAllowed(url: string): boolean {
    try {
      return this.allowedHosts.has(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  routeAllowed(pathname: string): boolean {
    const globalOk = this.globalRouteMatchers.some((re) => re.test(pathname));
    const scopeOk = this.scopeRouteMatchers ? this.scopeRouteMatchers.some((re) => re.test(pathname)) : true;
    return globalOk && scopeOk;
  }

  /** Check a navigation target (URL or path). */
  checkNavigation(target: string): PolicyDecision {
    let pathname = target;
    let host: string | null = null;
    try {
      if (/^https?:\/\//.test(target)) {
        const u = new URL(target);
        pathname = u.pathname;
        host = u.hostname;
      }
    } catch {
      return { allowed: false, reason: `Malformed navigation target: ${target}` };
    }
    if (host && !this.allowedHosts.has(host)) return { allowed: false, reason: `Host not allowlisted: ${host}` };
    if (!this.routeAllowed(pathname)) return { allowed: false, reason: `Route not allowlisted: ${pathname}` };
    return { allowed: true };
  }

  /** Check an action + (optional) risk classification for a step. */
  checkAction(kind: ActionKind, risk: 'safe' | 'risky' = 'safe'): PolicyDecision {
    if (!this.allowedActions.has(kind)) return { allowed: false, reason: `Action not allowlisted: ${kind}` };
    if (risk === 'risky') {
      switch (this.global.riskyActionHandling) {
        case 'block':
          return { allowed: false, reason: 'Risky/irreversible action blocked by policy' };
        case 'require_confirmation':
          return { allowed: true, requiresConfirmation: true, note: 'Risky action requires confirmation/approval' };
        case 'flag':
          return { allowed: true, note: 'Risky action flagged' };
      }
    }
    return { allowed: true };
  }

  checkStep(step: Step): PolicyDecision {
    const act = this.checkAction(step.action, step.risk);
    if (!act.allowed) return act;
    if (step.action === 'navigate' && step.route) {
      const nav = this.checkNavigation(step.route);
      if (!nav.allowed) return nav;
    }
    return act;
  }
}

/**
 * Classify whether an action is inherently risky/irreversible. Used by the
 * recorder as a default when the model didn't explicitly mark a step. The
 * conservative heuristic: a click whose intent/checkpoint implies creation,
 * confirmation, deletion, transfer, or submission is risky.
 */
const RISKY_INTENT = /(confirm|open account|submit|create|delete|remove|transfer|post|approve|pay|withdraw|close account|issue)/i;
export function inferRisk(step: Pick<Step, 'action' | 'intent'>): 'safe' | 'risky' {
  if (step.action === 'click' && RISKY_INTENT.test(step.intent)) return 'risky';
  return 'safe';
}
