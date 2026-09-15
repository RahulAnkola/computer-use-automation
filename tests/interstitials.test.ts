import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { dismissKnownInterstitials, type KnownInterstitial } from "../src/core/interstitials.js";

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

const sessionCheck: KnownInterstitial = {
  code: "SESSION_CHECK",
  detect: { textContains: "please confirm this session is still active" },
  dismiss: { primary: { strategy: "role", role: "button", name: "Continue" }, fallbacks: [] },
};

describe("dismissKnownInterstitials", () => {
  it("dismisses a matching interstitial and reports that it did", async () => {
    await page.setContent(
      `<p>For your security, please confirm this session is still active.</p>
       <button onclick="document.body.innerHTML='<p>Real content.</p>'">Continue</button>`
    );
    const codes: string[] = [];
    const dismissed = await dismissKnownInterstitials(page, [sessionCheck], (code) => codes.push(code));
    expect(dismissed).toBe(true);
    expect(codes).toEqual(["SESSION_CHECK"]);
    expect(await page.getByText("Real content.").isVisible()).toBe(true);
  });

  it("is a no-op when no known interstitial is showing", async () => {
    await page.setContent(`<p>Ordinary page content.</p>`);
    const dismissed = await dismissKnownInterstitials(page, [sessionCheck]);
    expect(dismissed).toBe(false);
  });

  it("stops once dismissed even if the same interstitial's text briefly reappears", async () => {
    // Bounded rounds: a page that never actually clears the interstitial
    // must not hang replay/discovery forever.
    await page.setContent(
      `<p>please confirm this session is still active</p>
       <button id="btn">Continue</button>
       <script>
         document.getElementById('btn').onclick = () => {
           document.body.innerHTML = '<p>please confirm this session is still active</p><button id="btn2">Continue</button>';
         };
       </script>`
    );
    const dismissed = await dismissKnownInterstitials(page, [sessionCheck], undefined, 2);
    expect(dismissed).toBe(true); // dismissed at least once within the bounded rounds
  });
});
