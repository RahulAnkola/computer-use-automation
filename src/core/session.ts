import { chromium } from "playwright";
import type { Browser, BrowserContext, Page, BrowserServer } from "playwright";
import { writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";

const WS_FILE = path.resolve(process.cwd(), ".escalations", "session.ws");

/**
 * A "live session" the automation and a human operator can share. Backed by
 * a Playwright browser *server* (a real OS-level browser process) whose
 * WebSocket endpoint we persist to disk. Any process -- the discovery/replay
 * runner, or a separate `operator` CLI invocation -- can connect to that
 * same endpoint and get the same browser, same context, same open page.
 * This is what makes the human-in-the-loop handoff a transfer of control
 * over one live session rather than a description of one.
 */
export interface SharedSession {
  browserServer: BrowserServer;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export async function createSharedSession(opts: { headless: boolean }): Promise<SharedSession> {
  const browserServer = await chromium.launchServer({ headless: opts.headless });
  const wsEndpoint = browserServer.wsEndpoint();
  await writeFile(WS_FILE, wsEndpoint, "utf8").catch(async (err) => {
    // .escalations dir may not exist yet on a clean checkout
    await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(WS_FILE), { recursive: true }));
    await writeFile(WS_FILE, wsEndpoint, "utf8");
  });
  const browser = await chromium.connect(wsEndpoint);
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    browserServer,
    browser,
    context,
    page,
    async close() {
      await browser.close().catch(() => undefined);
      await browserServer.close().catch(() => undefined);
      await rm(WS_FILE, { force: true }).catch(() => undefined);
    },
  };
}

/** Used by a separate process (the operator CLI) to attach to a session
 *  another process created, and grab its live page. */
export async function attachToSharedSession(): Promise<{ browser: Browser; page: Page }> {
  const wsEndpoint = await readFile(WS_FILE, "utf8");
  const browser = await chromium.connect(wsEndpoint.trim());
  const contexts = browser.contexts();
  const context = contexts[contexts.length - 1];
  if (!context) throw new Error("No browser context found on the shared session");
  const pages = context.pages();
  const page = pages[pages.length - 1];
  if (!page) throw new Error("No open page found on the shared session");
  return { browser, page };
}

export async function hasActiveSession(): Promise<boolean> {
  try {
    await readFile(WS_FILE, "utf8");
    return true;
  } catch {
    return false;
  }
}
