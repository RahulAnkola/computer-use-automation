import type { Page } from "playwright";
import type { PageObservation, PerceivedElement, RobustLocator, Locator } from "./types.js";

/**
 * Raw element facts collected in-page. Kept intentionally close to what an
 * accessibility tree exposes (role + accessible name) rather than DOM
 * internals, so the same shape could later be produced by a native
 * accessibility API instead of a browser DOM walk -- see REPORT.md.
 */
interface RawElement {
  tag: string;
  role: string;
  name: string;
  nameSource: "aria" | "label" | "row-label" | "placeholder" | "own-text" | "none";
  kind: "button" | "link" | "textbox" | "combobox" | "value" | "other";
  value?: string;
  options?: string[];
  testid?: string;
  cssPath: string;
  ownText: string;
}

const COLLECT_SCRIPT = `(() => {
  // Returns { name, source }. "source" matters for locator strategy: a name
  // that came from a real accessible-name mechanism (aria-label, <label>,
  // placeholder, or the element's own text) is something Playwright's
  // getByRole can independently verify. A name inferred from a *sibling*
  // table cell ("row-label") is NOT part of the accessibility tree -- using
  // it as a role-locator name would silently match nothing, so callers must
  // target it structurally (nearest containing row) instead.
  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return { name: aria.trim(), source: 'aria' };
    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl && lbl.textContent) return { name: lbl.textContent.trim(), source: 'label' };
    }
    const parentLabel = el.closest('label');
    if (parentLabel && parentLabel.textContent) return { name: parentLabel.textContent.trim(), source: 'label' };
    if (el.tagName === 'INPUT' && el.getAttribute('placeholder')) {
      return { name: el.getAttribute('placeholder'), source: 'placeholder' };
    }
    if ((el.tagName === 'BUTTON' || el.tagName === 'A') && el.textContent && el.textContent.trim()) {
      return { name: el.textContent.trim().slice(0, 80), source: 'own-text' };
    }
    // Legacy table-layout fallback: text of the nearest preceding table cell.
    // Real for a human reading the screen, invisible to the accessibility tree.
    const cell = el.closest('td');
    if (cell) {
      const row = cell.closest('tr');
      const cells = row ? Array.from(row.children) : [];
      const idx = cells.indexOf(cell);
      if (idx > 0) {
        const prev = cells[idx - 1];
        if (prev && prev.textContent && prev.textContent.trim()) return { name: prev.textContent.trim(), source: 'row-label' };
      }
    }
    if (el.textContent && el.textContent.trim()) return { name: el.textContent.trim().slice(0, 80), source: 'own-text' };
    return { name: '', source: 'none' };
  }

  function cssPathOf(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let selector = node.tagName.toLowerCase();
      if (node.id) {
        selector += '#' + CSS.escape(node.id);
        parts.unshift(selector);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          selector += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(selector);
      node = parent;
    }
    return parts.join(' > ');
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    return 'generic';
  }

  function kindOf(role, tag) {
    if (role === 'button') return 'button';
    if (role === 'link') return 'link';
    if (role === 'combobox') return 'combobox';
    if (role === 'textbox') return 'textbox';
    return 'other';
  }

  const interactiveSelector = 'a[href], button, input, select, textarea, [role]';
  const out = [];
  document.querySelectorAll(interactiveSelector).forEach((el) => {
    if (el.disabled) return;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return;
    const role = roleOf(el);
    const kind = kindOf(role, el.tagName.toLowerCase());
    const { name, source } = accessibleName(el);
    let value;
    let options;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') value = el.value;
    if (el.tagName === 'SELECT') {
      options = Array.from(el.options).map((o) => o.value);
      value = el.value;
    }
    out.push({
      tag: el.tagName.toLowerCase(),
      role,
      name,
      nameSource: source,
      kind,
      value,
      options,
      testid: el.getAttribute('data-testid') || undefined,
      cssPath: cssPathOf(el),
      ownText: (el.textContent || '').trim().slice(0, 120),
    });
  });

  // Second pass: labeled read-only "value" cells (legacy table-layout data
  // display, e.g. <tr><td>Balance</td><td>$500.00</td></tr>). These carry
  // information the agent needs to read/extract but aren't form controls,
  // so they're invisible to the interactive-element pass above.
  document.querySelectorAll('tr').forEach((row) => {
    const cells = Array.from(row.children).filter((c) => c.tagName === 'TD');
    if (cells.length < 2) return;
    const labelCell = cells[cells.length - 2];
    const valueCell = cells[cells.length - 1];
    if (valueCell.querySelector(interactiveSelector)) return; // already captured above
    const labelText = (labelCell.textContent || '').trim();
    const valueText = (valueCell.textContent || '').trim();
    if (!labelText || !valueText || labelText.length > 60) return;
    out.push({
      tag: 'td',
      role: 'text',
      name: labelText,
      nameSource: 'row-label',
      kind: 'value',
      value: undefined,
      options: undefined,
      testid: undefined,
      cssPath: cssPathOf(valueCell),
      ownText: valueText.slice(0, 160),
    });
  });

  return out;
})()`;

const SUMMARY_SCRIPT = `(() => {
  const title = document.title;
  const heading = document.querySelector('b, h1, h2, h3');
  const bodyText = document.body ? document.body.innerText : '';
  const trimmed = bodyText.replace(/\\s+/g, ' ').trim().slice(0, 1200);
  return { title, heading: heading ? heading.textContent.trim() : '', text: trimmed };
})()`;

function buildLocator(raw: RawElement, sameNameCount: number, index: number): RobustLocator {
  const fallbacks: Locator[] = [];
  if (raw.testid) {
    return { primary: { strategy: "testid", testid: raw.testid }, fallbacks: [{ strategy: "css", css: raw.cssPath }] };
  }
  const nth = sameNameCount > 1 ? index : undefined;

  if (!raw.name) {
    return { primary: { strategy: "css", css: raw.cssPath }, fallbacks: [] };
  }

  // A name sourced from real accessible-name mechanisms (aria-label, <label>,
  // placeholder, or the element's own visible text) is exactly what
  // Playwright's getByRole/getByText independently compute -- safe to use
  // as role/text locators. A "row-label" name is our own heuristic reading
  // of a *different* element's text (the preceding table cell); the
  // accessibility tree has no idea about it, so role/text locators would
  // silently match the wrong thing (the label cell itself). For those we
  // target the control structurally: "the input/select in the row that
  // contains this label text".
  if (raw.kind === "value") {
    return {
      primary: { strategy: "cell", label: raw.name, nth },
      fallbacks: [{ strategy: "css", css: raw.cssPath }],
    };
  }

  if (raw.nameSource === "row-label") {
    return {
      primary: { strategy: "label", label: raw.name, nth },
      fallbacks: [{ strategy: "css", css: raw.cssPath }],
    };
  }

  const primary: Locator = { strategy: "role", role: raw.role, name: raw.name, nth };
  fallbacks.push({ strategy: "text", text: raw.name, exact: false, nth });
  fallbacks.push({ strategy: "css", css: raw.cssPath });
  return { primary, fallbacks };
}

export async function observe(page: Page, screenshotPath?: string): Promise<PageObservation> {
  const raw = (await page.evaluate(COLLECT_SCRIPT)) as RawElement[];
  const summary = (await page.evaluate(SUMMARY_SCRIPT)) as { title: string; heading: string; text: string };

  const nameCounts = new Map<string, number>();
  for (const r of raw) {
    const key = `${r.role}:${r.name}`;
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const seenSoFar = new Map<string, number>();

  const elements: PerceivedElement[] = raw.map((r, i) => {
    const key = `${r.role}:${r.name}`;
    const count = nameCounts.get(key) ?? 1;
    const idx = seenSoFar.get(key) ?? 0;
    seenSoFar.set(key, idx + 1);
    return {
      ref: `e${i}`,
      role: r.role,
      name: r.name || r.ownText,
      tag: r.tag,
      kind: r.kind,
      value: r.kind === "value" ? r.ownText : r.value,
      options: r.options,
      locator: buildLocator(r, count, idx),
    };
  });

  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  }

  return {
    url: page.url(),
    title: summary.title,
    summary: `${summary.heading ? summary.heading + " -- " : ""}${summary.text}`,
    elements,
    screenshotPath,
  };
}
