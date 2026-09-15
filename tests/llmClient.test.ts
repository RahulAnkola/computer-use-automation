import { describe, it, expect } from "vitest";
import { extractRetryDelaySeconds } from "../src/agent/llmClient.js";

// Regression coverage for a real free-tier rate-limit outage hit during
// development: Gemini's 429 responses need their retry delay parsed
// correctly so the client waits the *right* amount instead of guessing.
describe("extractRetryDelaySeconds", () => {
  it("parses the free-text 'retry in Ns' message shape", () => {
    const err = { message: 'Quota exceeded. Please retry in 11.394658577s.' };
    expect(extractRetryDelaySeconds(err)).toBe(13); // ceil(11.39) + 1
  });

  it("parses the structured RetryInfo detail shape", () => {
    const err = {
      error: {
        message: "quota exceeded",
        details: [
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "58s" },
        ],
      },
    };
    expect(extractRetryDelaySeconds(err)).toBe(59); // ceil(58) + 1
  });

  it("prefers the free-text message when both shapes are present", () => {
    const err = {
      error: {
        message: "Please retry in 5s.",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "58s" }],
      },
    };
    expect(extractRetryDelaySeconds(err)).toBe(6);
  });

  it("returns undefined when neither shape is present, so the caller can fall back to backoff", () => {
    expect(extractRetryDelaySeconds({ message: "some other error" })).toBeUndefined();
    expect(extractRetryDelaySeconds({})).toBeUndefined();
  });
});
