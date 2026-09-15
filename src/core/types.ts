// Shared types for perception, locators, actions, and the artifact schema.
// Kept deliberately surface-agnostic where possible: today's implementation
// is Playwright-over-a-web-page, but nothing here assumes DOM/CSS as the
// only way to identify a control -- see REPORT.md ("Heterogeneity") for how
// this seam extends to desktop/accessibility-tree surfaces.

export type LocatorStrategy = "role" | "label" | "text" | "css" | "testid";

export interface RoleLocator {
  strategy: "role";
  role: string; // ARIA/Playwright role, e.g. "button", "link", "textbox", "combobox"
  name: string; // accessible name (visible label/text)
  nth?: number;
}

export interface LabelLocator {
  strategy: "label";
  label: string; // text of an associated <label> or preceding cell/text
  nth?: number;
}

export interface TextLocator {
  strategy: "text";
  text: string;
  exact?: boolean;
  nth?: number;
}

export interface CssLocator {
  strategy: "css";
  css: string;
}

export interface TestIdLocator {
  strategy: "testid";
  testid: string;
}

/** A read-only "value" cell in a labeled table row, e.g. <tr><td>Balance</td><td>$500.00</td></tr>.
 *  Common in legacy/table-based UIs for data that isn't inside a form control at all. */
export interface CellLocator {
  strategy: "cell";
  label: string;
  nth?: number;
}

export type Locator = RoleLocator | LabelLocator | TextLocator | CssLocator | TestIdLocator | CellLocator;

/** A locator plus ordered fallbacks, in the order they should be tried. */
export interface RobustLocator {
  primary: Locator;
  fallbacks: Locator[];
}

/** One element surfaced to the LLM (and to a human reviewer) during perception. */
export interface PerceivedElement {
  ref: string; // stable-for-this-observation id, e.g. "e3"
  role: string;
  name: string;
  tag: string;
  kind: "button" | "link" | "textbox" | "combobox" | "text" | "value" | "other";
  value?: string;
  options?: string[]; // for comboboxes/selects
  locator: RobustLocator; // how we would target it if chosen
}

export interface PageObservation {
  url: string;
  title: string;
  /** Short human/LLM-readable summary of salient page content (headings, table text, messages). */
  summary: string;
  elements: PerceivedElement[];
  screenshotPath?: string;
}

export type ActionType = "navigate" | "click" | "type" | "select" | "extract" | "wait_for" | "assert_text" | "escalate";

export interface ActionResult {
  ok: boolean;
  observed?: string; // what we actually saw (for extract / assert / debugging)
  error?: string;
}
