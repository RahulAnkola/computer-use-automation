import type { Locator as ConcreteLocator, RobustLocator as ConcreteRobustLocator } from "./types.js";
import type { z } from "zod";
import type { LocatorSchema, RobustLocatorSchema } from "./artifact.js";

type TemplateLocator = z.infer<typeof LocatorSchema>;
type TemplateRobustLocator = z.infer<typeof RobustLocatorSchema>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Replace {{paramName}} placeholders in a template string with concrete param values. */
export function renderTemplate(template: string, params: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, name) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing param "${name}" required by template: ${template}`);
    return value;
  });
}

/** Like renderTemplate, but URI-encodes each substituted value (for use in URL templates). */
export function renderUrlTemplate(template: string, params: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, name) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing param "${name}" required by URL template: ${template}`);
    return encodeURIComponent(value);
  });
}

function renderLocator(loc: TemplateLocator, params: Record<string, string>): ConcreteLocator {
  switch (loc.strategy) {
    case "role":
      return { strategy: "role", role: loc.role, name: renderTemplate(loc.name, params), nth: loc.nth };
    case "label":
      return { strategy: "label", label: renderTemplate(loc.label, params), nth: loc.nth };
    case "text":
      return { strategy: "text", text: renderTemplate(loc.text, params), exact: loc.exact, nth: loc.nth };
    case "css":
      return { strategy: "css", css: loc.css };
    case "testid":
      return { strategy: "testid", testid: loc.testid };
    case "cell":
      return { strategy: "cell", label: renderTemplate(loc.label, params), nth: loc.nth };
  }
}

export function renderRobustLocator(robust: TemplateRobustLocator, params: Record<string, string>): ConcreteRobustLocator {
  return {
    primary: renderLocator(robust.primary, params),
    fallbacks: robust.fallbacks.map((f) => renderLocator(f, params)),
  };
}

/**
 * Inverse operation used when saving a discovery trace as an artifact:
 * replace any exact occurrence of a known parameter's concrete value inside
 * a string with its {{paramName}} placeholder. Longest values are matched
 * first so e.g. a memberId that is a substring of another value doesn't
 * clobber it incorrectly.
 */
export function templatizeString(raw: string, paramValues: Record<string, string>): string {
  const entries = Object.entries(paramValues)
    .filter(([, v]) => v && v.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  let out = raw;
  for (const [name, value] of entries) {
    if (out.includes(value)) {
      out = out.split(value).join(`{{${name}}}`);
    }
  }
  return out;
}

function templatizeLocator(loc: ConcreteLocator, paramValues: Record<string, string>): TemplateLocator {
  switch (loc.strategy) {
    case "role":
      return { strategy: "role", role: loc.role, name: templatizeString(loc.name, paramValues), nth: loc.nth };
    case "label":
      return { strategy: "label", label: templatizeString(loc.label, paramValues), nth: loc.nth };
    case "text":
      return { strategy: "text", text: templatizeString(loc.text, paramValues), exact: loc.exact, nth: loc.nth };
    case "css":
      return { strategy: "css", css: loc.css };
    case "testid":
      return { strategy: "testid", testid: loc.testid };
    case "cell":
      return { strategy: "cell", label: templatizeString(loc.label, paramValues), nth: loc.nth };
  }
}

export function templatizeRobustLocator(robust: ConcreteRobustLocator, paramValues: Record<string, string>): TemplateRobustLocator {
  return {
    primary: templatizeLocator(robust.primary, paramValues),
    fallbacks: robust.fallbacks.map((f) => templatizeLocator(f, paramValues)),
  };
}
