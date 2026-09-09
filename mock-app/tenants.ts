/**
 * Tenant profiles. Many institutions run the SAME underlying vendor product,
 * branded/labelled/configured differently. Two tenants here stand in for that:
 *
 *   meridian: the "base" configuration a capability is first recorded against.
 *   cascade:  a second tenant on the same vendor product, with different
 *               branding and a few relabelled controls + one extra confirm step.
 *
 * The point: a capability recorded on `meridian` should replay on `cascade`
 * with small, declared per-tenant overrides, not a full re-record. The label
 * differences below are exactly the kind of drift that overrides absorb.
 */

export interface TenantProfile {
  id: string;
  brand: string;
  color: string;
  /** Accessible-name / visible-text overrides for shared controls. */
  labels: {
    memberNumberField: string;
    searchButton: string;
    openSubAccount: string;
    accountTypeField: string;
    initialDepositField: string;
    continueButton: string;
    confirmButton: string;
  };
  /** cascade inserts an extra "verify identity" acknowledgement before review. */
  extraVerifyStep: boolean;
}

export const TENANTS: Record<string, TenantProfile> = {
  meridian: {
    id: 'meridian',
    brand: 'MeridianCU — Servicing Console',
    color: '#1f4e79',
    labels: {
      memberNumberField: 'Member Number',
      searchButton: 'Search',
      openSubAccount: 'Open Sub-Account',
      accountTypeField: 'Account Type',
      initialDepositField: 'Initial Deposit',
      continueButton: 'Continue to Review',
      confirmButton: 'Confirm & Open Account',
    },
    extraVerifyStep: false,
  },
  cascade: {
    id: 'cascade',
    brand: 'Cascade Financial — Member Servicing',
    color: '#6d4c9f',
    labels: {
      // same vendor product, different wording -> handled by per-tenant overrides
      memberNumberField: 'Account Number',
      searchButton: 'Find Member',
      openSubAccount: 'New Sub-Account',
      accountTypeField: 'Share Type',
      initialDepositField: 'Opening Deposit',
      continueButton: 'Review',
      confirmButton: 'Open Account',
    },
    extraVerifyStep: true,
  },
};

export function getTenant(id: string | undefined): TenantProfile {
  return TENANTS[id ?? 'meridian'] ?? TENANTS.meridian!;
}
