import { describe, it, expect } from 'vitest';
import { PolicyEngine, DEFAULT_POLICY, inferRisk } from '../src/safety/policy.js';

describe('policy / allowlist', () => {
  const p = new PolicyEngine(DEFAULT_POLICY);

  it('allows allowlisted routes and blocks others', () => {
    expect(p.checkNavigation('/members').allowed).toBe(true);
    expect(p.checkNavigation('/members/100123/subaccounts/new').allowed).toBe(true);
    expect(p.checkNavigation('/admin/secret').allowed).toBe(false);
  });

  it('blocks non-allowlisted hosts', () => {
    expect(p.checkNavigation('http://evil.example.com/members').allowed).toBe(false);
    expect(p.checkNavigation('http://localhost/members').allowed).toBe(true);
  });

  it('flags risky actions per the handling mode', () => {
    const decision = p.checkAction('click', 'risky');
    expect(decision.allowed).toBe(true);
    expect('requiresConfirmation' in decision && decision.requiresConfirmation).toBe(true);
  });

  it('blocks risky actions when configured to block', () => {
    const strict = new PolicyEngine({ ...DEFAULT_POLICY, riskyActionHandling: 'block' });
    expect(strict.checkAction('click', 'risky').allowed).toBe(false);
  });

  it('narrows to the intersection with capability scope', () => {
    const scoped = new PolicyEngine(DEFAULT_POLICY, { allowedRoutes: ['/members'], allowedActions: ['navigate', 'click'] });
    expect(scoped.checkAction('type').allowed).toBe(false); // type not in capability scope
    expect(scoped.checkAction('click').allowed).toBe(true);
  });

  it('infers risk from intent', () => {
    expect(inferRisk({ action: 'click', intent: 'Confirm & open the account' })).toBe('risky');
    expect(inferRisk({ action: 'click', intent: 'click the Search button' })).toBe('safe');
  });

  // regression (F02 / review R01): scope must NOT widen the global allowlist.
  it('is a true INTERSECTION: scope cannot admit a route the global policy forbids', () => {
    const scopeDeclaresAdmin = new PolicyEngine(DEFAULT_POLICY, { allowedRoutes: ['/admin'], allowedActions: ['navigate'] });
    expect(scopeDeclaresAdmin.checkNavigation('/admin').allowed).toBe(false); // global forbids /admin
    const scopeNarrows = new PolicyEngine(DEFAULT_POLICY, { allowedRoutes: ['/members/100123'], allowedActions: ['navigate'] });
    expect(scopeNarrows.checkNavigation('/members/999999').allowed).toBe(false); // outside the scope
    expect(scopeNarrows.checkNavigation('/members/100123').allowed).toBe(true);
  });
});
