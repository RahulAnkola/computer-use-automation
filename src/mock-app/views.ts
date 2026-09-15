// Deliberately "legacy enterprise" markup: nested tables, no test ids,
// no semantic landmarks, inline styles. This is the hostile surface the
// perception layer and locator strategy are designed against.
import type { Member } from "./data.js";

const shell = (title: string, body: string) => `<!doctype html>
<html><head><title>${title}</title></head>
<body bgcolor="#ffffff">
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#003366">
  <table cellpadding="6"><tr><td><font color="#ffffff" size="4"><b>BankOps Console</b></font></td></tr></table>
</td></tr></table>
<table width="100%" cellpadding="12" cellspacing="0" border="0"><tr><td>
${body}
</td></tr></table>
</body></html>`;

export function renderInterstitial(returnTo: string): string {
  return shell(
    "Session Check",
    `<table border="1" cellpadding="10"><tr><td>
      <p>For your security, please confirm this session is still active.</p>
      <form method="post" action="/interstitial/ack">
        <input type="hidden" name="returnTo" value="${returnTo}">
        <button type="submit">Continue</button>
      </form>
    </td></tr></table>`
  );
}

export function renderHome(message?: string): string {
  return shell(
    "BankOps Console - Search",
    `<p>Enter a member ID or name to look up an account.</p>
    <form method="get" action="/search">
      <table cellpadding="4"><tr>
        <td>Member ID or Name:</td>
        <td><input type="text" name="q" size="30"></td>
        <td><button type="submit">Search</button></td>
      </tr></table>
    </form>
    ${message ? `<p><i>${message}</i></p>` : ""}`
  );
}

export function renderSearchResults(query: string, results: Member[]): string {
  if (results.length === 0) {
    return shell(
      "Search Results",
      `<p>No members found matching &quot;${escapeHtml(query)}&quot;.</p>
      <p><a href="/">Back to search</a></p>`
    );
  }
  const rows = results
    .map(
      (m) => `<tr><td>${m.id}</td><td>${escapeHtml(m.name)}</td><td>${m.status}</td>
        <td><a href="/members/${m.id}">Open Record</a></td></tr>`
    )
    .join("\n");
  return shell(
    "Search Results",
    `<table border="1" cellpadding="6">
      <tr><td><b>ID</b></td><td><b>Name</b></td><td><b>Status</b></td><td></td></tr>
      ${rows}
    </table>`
  );
}

export function renderMember(m: Member, notice?: string): string {
  const restrictedNotice =
    m.status === "restricted"
      ? `<p><font color="red">Account actions restricted &mdash; contact compliance before proceeding.</font></p>`
      : `<p><a href="/members/${m.id}/open-account">Open Sub-Account</a></p>`;
  const subRows = m.subAccounts
    .map((s) => `<tr><td>${s.id}</td><td>${s.type}</td><td>$${s.balance.toFixed(2)}</td></tr>`)
    .join("\n");
  return shell(
    "Member Record",
    `<table cellpadding="4">
      <tr><td>Member ID:</td><td>${m.id}</td></tr>
      <tr><td>Name:</td><td>${escapeHtml(m.name)}</td></tr>
      <tr><td>Status:</td><td>${m.status}</td></tr>
    </table>
    <p><b>Accounts</b></p>
    <table border="1" cellpadding="6">
      <tr><td>Checking Balance</td><td>$${m.checking.toFixed(2)}</td></tr>
      <tr><td>Savings Balance</td><td>$${m.savings.toFixed(2)}</td></tr>
    </table>
    ${
      m.subAccounts.length
        ? `<p><b>Sub-Accounts</b></p><table border="1" cellpadding="6">${subRows}</table>`
        : ""
    }
    ${notice ? `<p><font color="red">${notice}</font></p>` : ""}
    ${restrictedNotice}
    <p><a href="/">Back to search</a></p>`
  );
}

export function renderForbidden(): string {
  return shell(
    "Action Not Permitted",
    `<p><font color="red">This action is not permitted for restricted accounts. Contact compliance.</font></p>`
  );
}

export function renderOpenAccountForm(
  m: Member,
  opts: { error?: string; accountType?: string; amount?: string } = {}
): string {
  return shell(
    "Open Sub-Account",
    `<p>Open a new sub-account for member ${m.id} (${escapeHtml(m.name)}).</p>
    ${opts.error ? `<p><font color="red">${opts.error}</font></p>` : ""}
    <form method="post" action="/members/${m.id}/open-account">
      <table cellpadding="4">
        <tr><td>Account Type:</td><td>
          <select name="accountType">
            <option value="Sub-Savings" ${opts.accountType === "Sub-Savings" ? "selected" : ""}>Sub-Savings</option>
            <option value="Sub-Checking" ${opts.accountType === "Sub-Checking" ? "selected" : ""}>Sub-Checking</option>
          </select>
        </td></tr>
        <tr><td>Initial Deposit ($):</td><td><input type="text" name="amount" value="${opts.amount ?? ""}"></td></tr>
      </table>
      <button type="submit">Continue</button>
    </form>
    <p><a href="/members/${m.id}">Cancel</a></p>`
  );
}

export function renderReview(
  m: Member,
  accountType: string,
  amount: number
): string {
  return shell(
    "Review Sub-Account",
    `<p>Please review the details before confirming.</p>
    <table border="1" cellpadding="6">
      <tr><td>Member</td><td>${m.id} - ${escapeHtml(m.name)}</td></tr>
      <tr><td>Account Type</td><td>${accountType}</td></tr>
      <tr><td>Initial Deposit</td><td>$${amount.toFixed(2)}</td></tr>
    </table>
    <form method="post" action="/members/${m.id}/open-account/confirm">
      <input type="hidden" name="accountType" value="${accountType}">
      <input type="hidden" name="amount" value="${amount}">
      <button type="submit">Confirm</button>
    </form>
    <p><a href="/members/${m.id}">Cancel</a></p>`
  );
}

export function renderManagerApproval(
  m: Member,
  accountType: string,
  amount: number
): string {
  return shell(
    "Manager Approval Required",
    `<p><font color="red">This deposit ($${amount.toFixed(2)}) exceeds the $10,000 self-service limit and
    requires manager approval before it can proceed.</font></p>
    <table border="1" cellpadding="6">
      <tr><td>Member</td><td>${m.id} - ${escapeHtml(m.name)}</td></tr>
      <tr><td>Account Type</td><td>${accountType}</td></tr>
      <tr><td>Initial Deposit</td><td>$${amount.toFixed(2)}</td></tr>
    </table>
    <form method="post" action="/members/${m.id}/open-account/manager-approve">
      <input type="hidden" name="accountType" value="${accountType}">
      <input type="hidden" name="amount" value="${amount}">
      <button type="submit">Approve as Manager</button>
    </form>
    <p><a href="/members/${m.id}">Cancel</a></p>`
  );
}

export function renderConfirmation(m: Member, sub: { id: string; type: string; balance: number }): string {
  return shell(
    "Sub-Account Opened",
    `<p>Sub-account opened successfully.</p>
    <table border="1" cellpadding="6">
      <tr><td>New Sub-Account ID</td><td>${sub.id}</td></tr>
      <tr><td>Type</td><td>${sub.type}</td></tr>
      <tr><td>Balance</td><td>$${sub.balance.toFixed(2)}</td></tr>
    </table>
    <p><a href="/members/${m.id}">Back to member record</a></p>`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
