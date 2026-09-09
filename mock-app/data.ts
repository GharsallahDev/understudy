/**
 * Seed data for the mock "MeridianCU" servicing console.
 *
 * Domain note (credit unions): customers are "members"; deposit accounts are
 * "shares" (Regular Savings = the base share, plus Checking / Money Market /
 * Certificate sub-accounts). Opening a "sub-account" means adding another share
 * under an existing membership. Staff do this in an internal servicing console
 * that, in the real world, is a legacy core-banking screen (Symitar/Episys,
 * Corelation KeyStone, Fiserv DNA, ...) with no API.
 *
 * This data is entirely synthetic. No real PII.
 */

export type MemberStatus = 'active' | 'dormant' | 'restricted';
export type ShareType = 'Regular Savings' | 'Checking' | 'Money Market' | 'Certificate';

export interface Share {
  id: string;
  type: ShareType;
  number: string;
  balance: number; // cents
  status: 'open' | 'closed';
}

export interface Member {
  memberNumber: string;
  firstName: string;
  lastName: string;
  ssnLast4: string; // synthetic; treated as sensitive -> must be redacted in artifacts/logs
  status: MemberStatus;
  dateOpened: string;
  shares: Share[];
}

export const MIN_INITIAL_DEPOSIT_CENTS: Record<ShareType, number> = {
  'Regular Savings': 500, // $5 par value share
  Checking: 0,
  'Money Market': 250000, // $2,500 minimum
  Certificate: 50000, // $500 minimum
};

// Account types a member in each status is allowed to open. "restricted" members
// (e.g. account flagged for review) may not open new interest-bearing shares
// without a supervisor override -> drives the permission-denied scenario.
export const ALLOWED_TYPES_BY_STATUS: Record<MemberStatus, ShareType[]> = {
  active: ['Regular Savings', 'Checking', 'Money Market', 'Certificate'],
  dormant: ['Regular Savings', 'Checking'],
  restricted: [],
};

function makeMembers(): Member[] {
  return [
    {
      memberNumber: '100123',
      firstName: 'Dana',
      lastName: 'Whitfield',
      ssnLast4: '4417',
      status: 'active',
      dateOpened: '2015-03-11',
      shares: [
        { id: 's-1', type: 'Regular Savings', number: '100123-00', balance: 482355, status: 'open' },
        { id: 's-2', type: 'Checking', number: '100123-70', balance: 129900, status: 'open' },
      ],
    },
    {
      memberNumber: '100456',
      firstName: 'Marcus',
      lastName: 'Oyelaran',
      ssnLast4: '9021',
      status: 'restricted',
      dateOpened: '2019-07-22',
      shares: [
        { id: 's-3', type: 'Regular Savings', number: '100456-00', balance: 15000, status: 'open' },
      ],
    },
    {
      memberNumber: '100789',
      firstName: 'Priya',
      lastName: 'Nair',
      ssnLast4: '3388',
      status: 'active',
      dateOpened: '2021-01-05',
      shares: [
        { id: 's-4', type: 'Regular Savings', number: '100789-00', balance: 903112, status: 'open' },
        { id: 's-5', type: 'Money Market', number: '100789-80', balance: 5500000, status: 'open' },
      ],
    },
    {
      memberNumber: '100999',
      firstName: 'Theo',
      lastName: 'Brandt',
      ssnLast4: '1200',
      status: 'dormant',
      dateOpened: '2009-11-30',
      shares: [
        { id: 's-6', type: 'Regular Savings', number: '100999-00', balance: 500, status: 'open' },
      ],
    },
  ];
}

/**
 * A fresh, mutable copy of the seed data. Each server boot (and each test) gets
 * an isolated store so runs don't contaminate each other.
 */
export class MemberStore {
  private members: Map<string, Member>;
  private seq = 90;

  constructor() {
    this.members = new Map(makeMembers().map((m) => [m.memberNumber, structuredClone(m)]));
  }

  reset(): void {
    this.members = new Map(makeMembers().map((m) => [m.memberNumber, structuredClone(m)]));
    this.seq = 90;
  }

  get(memberNumber: string): Member | undefined {
    return this.members.get(memberNumber.trim());
  }

  /** Add a new share (sub-account) to a member, funding it with the initial deposit. */
  openSubAccount(memberNumber: string, type: ShareType, balanceCents = 0): Share {
    const member = this.members.get(memberNumber);
    if (!member) throw new Error('member not found');
    const suffix = String(this.seq++);
    const share: Share = {
      id: `s-${memberNumber}-${suffix}`,
      type,
      number: `${memberNumber}-${suffix}`,
      balance: balanceCents,
      status: 'open',
    };
    member.shares.push(share);
    return share;
  }
}

export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}
