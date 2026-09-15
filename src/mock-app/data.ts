// In-memory "core banking" data for the mock BankOps Console.
// Stand-in for a real (API-less) legacy back-office system. Never real PII.

export type MemberStatus = "active" | "restricted";

export interface SubAccount {
  id: string;
  type: "Sub-Savings" | "Sub-Checking";
  balance: number;
}

export interface Member {
  id: string;
  name: string;
  status: MemberStatus;
  checking: number;
  savings: number;
  subAccounts: SubAccount[];
}

export const members = new Map<string, Member>([
  [
    "10023",
    {
      id: "10023",
      name: "Jane Doe",
      status: "active",
      checking: 4210.55,
      savings: 12500.0,
      subAccounts: [],
    },
  ],
  [
    "10045",
    {
      id: "10045",
      name: "John Smith",
      status: "active",
      checking: 800.0,
      savings: 300.0,
      subAccounts: [],
    },
  ],
  [
    "90011",
    {
      id: "90011",
      name: "Alicia Reyes",
      status: "restricted",
      checking: 15200.0,
      savings: 2000.0,
      subAccounts: [],
    },
  ],
]);

let subAccountCounter = 500;
export function nextSubAccountId(): string {
  subAccountCounter += 1;
  return `SUB-${subAccountCounter}`;
}

export function findMembers(query: string): Member[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return [...members.values()].filter(
    (m) => m.id === q || m.name.toLowerCase().includes(q)
  );
}
