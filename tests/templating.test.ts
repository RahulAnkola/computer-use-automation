import { describe, it, expect } from "vitest";
import { renderTemplate, renderUrlTemplate, templatizeString } from "../src/core/templating.js";

describe("templating: render", () => {
  it("substitutes a single placeholder", () => {
    expect(renderTemplate("member {{memberId}}", { memberId: "10023" })).toBe("member 10023");
  });

  it("substitutes multiple placeholders", () => {
    expect(renderTemplate("{{a}}-{{b}}", { a: "x", b: "y" })).toBe("x-y");
  });

  it("throws on a missing param", () => {
    expect(() => renderTemplate("{{missing}}", {})).toThrow(/Missing param/);
  });

  it("URI-encodes substituted values in URL templates", () => {
    expect(renderUrlTemplate("/search?q={{q}}", { q: "jane doe" })).toBe("/search?q=jane%20doe");
  });
});

describe("templating: templatize (artifact authoring direction)", () => {
  it("replaces a literal occurrence of a known param value with its placeholder", () => {
    expect(templatizeString("Click record 10023", { memberId: "10023" })).toBe("Click record {{memberId}}");
  });

  it("prefers the longest matching value to avoid partial-substring clobbering", () => {
    const out = templatizeString("10023-A", { memberId: "10023", suffix: "10023-A" });
    expect(out).toBe("{{suffix}}");
  });

  it("leaves strings with no matching param values untouched", () => {
    expect(templatizeString("Continue", { memberId: "10023" })).toBe("Continue");
  });
});
