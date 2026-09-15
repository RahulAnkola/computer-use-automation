import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";

const CDP_FILE = path.resolve(process.cwd(), ".escalations", "session.cdp");
const DEFAULT_CDP_PORT = 9955;

/**
 * A "live session" the automation and a human operator can share.
 *
 * This has to be genuine cross-*process* shared state, not just an
 * in-memory handle -- the whole point of the escalation handoff is that a
 * *different* process (the `operator` CLI, run from a separate terminal)
 * takes control of the exact browser tab the automation was using.
 *
 * Playwright's own `browserType.connect()` to a `launchServer()` endpoint
 * does NOT give you this: each `connect()` call gets an isolated client
 * session that can't see contexts/pages created by another connection (it's
 * designed for spreading independent test workers across one browser
 * process, not for two clients sharing one page). Real Chrome DevTools
 * Protocol (`connectOverCDP`) is a single global namespace on the browser
 * process itself, so a second process connecting to the same CDP port
 * really does see the same contexts and pages. Hence: launch with a fixed
 * remote-debugging port, persist that port, and have the operator process
 * `connectOverCDP` to it.
 */
export interface SharedSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export async function createSharedSession(opts: { headless: boolean; cdpPort?: number }): Promise<SharedSession> {
  const port = opts.cdpPort ?? DEFAULT_CDP_PORT;
  const browser = await chromium.launch({ headless: opts.headless, args: [`--remote-debugging-port=${port}`] });
  await mkdir(path.dirname(CDP_FILE), { recursive: true });
  await writeFile(CDP_FILE, String(port), "utf8");
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    async close() {
      await browser.close().catch(() => undefined);
      await rm(CDP_FILE, { force: true }).catch(() => undefined);
    },
  };
}

/** Used by a separate process (the operator CLI) to attach to a session
 *  another process created, and grab its live page. */
export async function attachToSharedSession(): Promise<{ browser: Browser; page: Page }> {
  const port = (await readFile(CDP_FILE, "utf8")).trim();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
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
    await readFile(CDP_FILE, "utf8");
    return true;
  } catch {
    return false;
  }
}
