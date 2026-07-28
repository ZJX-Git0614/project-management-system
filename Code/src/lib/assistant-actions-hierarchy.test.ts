import { describe, expect, it } from "vitest";

import { parseHierarchyIntent } from "@/lib/assistant-actions";

describe("parseHierarchyIntent", () => {
  it("recognizes an indent request only when a concrete task code is provided", () => {
    expect(parseHierarchyIntent("把 Task2 变为上一条任务的子任务")).toEqual({
      taskCodes: ["Task2"],
      direction: "INDENT",
    });
    expect(parseHierarchyIntent("把这个任务变为子任务")).toBeNull();
  });

  it("recognizes multiple selected task codes for outdent", () => {
    expect(parseHierarchyIntent("将 Task2.1 和 Task2.2 上移一个层级")).toEqual({
      taskCodes: ["Task2.1", "Task2.2"],
      direction: "OUTDENT",
    });
  });
});
