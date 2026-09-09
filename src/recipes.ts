import type { DeclaredInput } from './agent/discover.js';
import type { RecordMeta } from './agent/recorder.js';
import type { GlobalPolicy } from './safety/policy.js';

/**
 * Predefined discovery recipes so the demo is a single, reproducible command.
 * Each pairs a natural-language goal + typed inputs with the metadata used to
 * compile the resulting capability. Custom goals are still possible via the CLI.
 */
export interface Recipe {
  key: string;
  goal: string;
  inputs: DeclaredInput[];
  entryRoute: string;
  meta: RecordMeta;
  /** Override the target base URL (e.g. a public site). */
  baseUrl?: string;
  /** false when login is part of the flow (agent logs in itself). */
  preAuth?: boolean;
  /** Widen the guardrail policy for this target (e.g. allow the public host/routes). */
  policyOverride?: Partial<GlobalPolicy>;
  maxSteps?: number;
}

export const RECIPES: Record<string, Recipe> = {
  'savings-balance': {
    key: 'savings-balance',
    goal: 'Look up member 100123 and read their current Regular Savings balance. Then finish, returning the balance as an output named "savingsBalance".',
    inputs: [{ name: 'memberNumber', value: '100123', description: 'The member number to look up' }],
    entryRoute: '/members',
    meta: {
      id: 'lookup-member-savings-balance',
      name: 'Look up member savings balance',
      description: 'Search a member by number and return their current Regular Savings balance.',
      appId: 'meridian-servicing',
      vendorProduct: 'CoreServicing',
      tenantId: 'meridian',
      conditionProfile: 'lookup',
      outputNames: ['savingsBalance'],
    },
  },

  'open-subaccount': {
    key: 'open-subaccount',
    goal: 'Open a new Checking sub-account for member 100123 with an initial deposit of 25.00, and reach the confirmation screen. When you reach it, finish and return the new account number as an output named "newAccountNumber".',
    inputs: [
      { name: 'memberNumber', value: '100123', description: 'The member number' },
      { name: 'accountType', value: 'Checking', description: 'The share type to open' },
      { name: 'initialDeposit', value: '25.00', description: 'Opening deposit amount' },
    ],
    entryRoute: '/members',
    meta: {
      id: 'open-member-subaccount',
      name: 'Open member sub-account',
      description: 'Open a new sub-account (share) for a member and reach the confirmation screen.',
      appId: 'meridian-servicing',
      vendorProduct: 'CoreServicing',
      tenantId: 'meridian',
      conditionProfile: 'create',
      outputNames: ['newAccountNumber'],
    },
  },

  // A real, third-party, public banking app (Parasoft's ParaBank demo). This is
  // the on-domain proof: legacy server-rendered markup, table layouts, no
  // test-ids: the same reality as interface.ai's back-office targets, but a live
  // untested surface we don't control. Flow: log in (credentials injected
  // securely) -> open a new savings account -> reach the confirmation screen.
  'parabank-balance': {
    key: 'parabank-balance',
    goal:
      'Log in with the provided username and password. You will land on the Accounts Overview, which lists accounts and balances in a table. Find the row for the account whose number equals the "accountId" input, read that account\'s current Balance, and finish, returning it as an output named "accountBalance". The distinctive success text is "Accounts Overview".',
    inputs: [
      { name: 'username', value: 'john', description: 'ParaBank login username', sensitive: true },
      { name: 'password', value: 'demo', description: 'ParaBank login password', sensitive: true },
      // ParaBank is a shared public demo that periodically resets, so john's
      // account numbers drift. Set this to a currently-valid account before recording;
      // replay then reads that account by input. (Input-bound targeting is proven
      // deterministically on the mock, which we control.)
      { name: 'accountId', value: '40650', description: 'the account number to read the balance of' },
    ],
    entryRoute: '/parabank/index.htm',
    baseUrl: 'https://parabank.parasoft.com',
    preAuth: false,
    maxSteps: 20,
    policyOverride: {
      allowedRoutes: ['/parabank/**', '/**'],
      allowedActions: ['navigate', 'click', 'type', 'select', 'press', 'read', 'assert', 'waitFor'],
    },
    meta: {
      id: 'parabank-account-balance',
      name: 'Look up an account balance (public bank)',
      description: 'On the ParaBank public demo bank: log in and read the current balance of a given account number.',
      appId: 'parabank',
      tenantId: 'parabank',
      conditionProfile: 'lookup',
      outputNames: ['accountBalance'],
    },
  },
};
