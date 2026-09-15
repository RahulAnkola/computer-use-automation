import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { observe } from "../src/core/perception.js";
import { resolveLocator } from "../src/core/actions.js";

// A miniature version of the legacy table-layout the mock app uses: no
// <label for>, no test ids, the "label" is just a preceding table cell.
const LEGACY_FORM_HTML = `<!doctype html><html><body>
  <table><tr><td>Member ID or Name:</td><td><input type="text" name="q"></td><td><button>Search</button></td></tr></table>
  <table>
    <tr><td>Member ID:</td><td>10023</td></tr>
    <tr><td>Savings Balance</td><td>$12500.00</td></tr>
  </table>
</body></html>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent(LEGACY_FORM_HTML);
});

afterAll(async () => {
  await browser.close();
});

describe("perception on a legacy table-layout page", () => {
  it("surfaces the search input as a textbox targetable by its table-cell label", async () => {
    const obs = await observe(page);
    const input = obs.elements.find((e) => e.kind === "textbox");
    expect(input).toBeTruthy();
    expect(input!.locator.primary.strategy).toBe("label");

    // The bug this guards against: a naive getByText/getByRole(name) fallback
    // resolves to the <td> label itself, not the <input> -- filling it throws
    // instead of typing into the field.
    const resolved = await resolveLocator(page, input!.locator);
    const tag = await resolved.locator.first().evaluate((el) => el.tagName);
    expect(tag).toBe("INPUT");
  });

  it("surfaces read-only labeled data cells as extractable 'value' elements", async () => {
    const obs = await observe(page);
    const balance = obs.elements.find((e) => e.name === "Savings Balance");
    expect(balance).toBeTruthy();
    expect(balance!.kind).toBe("value");
    expect(balance!.value).toBe("$12500.00");
    expect(balance!.locator.primary.strategy).toBe("cell");

    const resolved = await resolveLocator(page, balance!.locator);
    const text = await resolved.locator.first().textContent();
    expect(text?.trim()).toBe("$12500.00");
  });
});
