import { describe, expect, it } from "vitest";

import { buildAssistantCapabilitySnapshot } from "@/lib/assistant-capabilities";

describe("assistant capability discovery", () => {
  it("discovers current modules and project-scoped schema fields without secrets", () => {
    const snapshot = buildAssistantCapabilitySnapshot(new Set(["project.export", "gantt.task.update"]));
    expect(snapshot.modules).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "project-wbs", label: "项目WBS管理" }),
    ]));
    expect(snapshot.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "project.export", version: 6 }),
    ]));
    expect(snapshot.projectModels.find((model) => model.name === "ProjectGanttTask")?.fields)
      .toEqual(expect.arrayContaining(["taskName", "taskDescription", "projectId"]));
    expect(snapshot.projectModels.flatMap((model) => model.fields).some((field) => /password|secret|token|apiKey|hash|encrypted/iu.test(field)))
      .toBe(false);
  });
});
