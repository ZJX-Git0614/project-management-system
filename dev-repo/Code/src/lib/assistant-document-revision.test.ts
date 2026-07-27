import { describe, expect, it } from "vitest";

import { isDocumentRevisionRequest, splitDocumentForSmallModel } from "@/lib/assistant-document-revision";

describe("assistant document revision", () => {
  it("routes explicit document refinement requests", () => {
    expect(isDocumentRevisionRequest("请将这份附件的逻辑梳理清楚")).toBe(true);
    expect(isDocumentRevisionRequest("项目进度是多少")).toBe(false);
  });

  it("splits long content without dropping paragraphs", () => {
    const source = ["A".repeat(20), "B".repeat(20), "C".repeat(20)].join("\n\n");
    const chunks = splitDocumentForSmallModel(source, 30);
    expect(chunks.length).toBe(3);
    expect(chunks.join("\n\n")).toBe(source);
  });
});
