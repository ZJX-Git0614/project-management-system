import { describe, expect, it } from "vitest";

import { sanitizeSystemLogDetails } from "@/lib/system-event-log";

describe("system event log redaction", () => {
  it("redacts credentials, tokens, keys and document content recursively", () => {
    expect(sanitizeSystemLogDetails({
      username: "admin",
      password: "secret",
      nested: { authorization: "Bearer abc", apiKey: "key", documentContent: "full document" },
    })).toEqual({
      username: "admin",
      password: "[已脱敏]",
      nested: { authorization: "[已脱敏]", apiKey: "[已脱敏]", documentContent: "[已脱敏]" },
    });
  });
});
