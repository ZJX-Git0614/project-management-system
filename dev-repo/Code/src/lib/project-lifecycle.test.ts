import { describe, expect, it } from "vitest";

import { ProjectStatus } from "@/domain/enums";
import {
  assertProjectStatusTransition,
  canTransitionProjectStatus,
  projectStatusActionPermission,
} from "@/lib/project-lifecycle";

describe("project lifecycle", () => {
  it("allows only explicit lifecycle transitions", () => {
    expect(canTransitionProjectStatus(ProjectStatus.DRAFT, ProjectStatus.IN_PROGRESS)).toBe(true);
    expect(canTransitionProjectStatus(ProjectStatus.IN_PROGRESS, ProjectStatus.COMPLETED)).toBe(true);
    expect(canTransitionProjectStatus(ProjectStatus.COMPLETED, ProjectStatus.DRAFT)).toBe(false);
    expect(() => assertProjectStatusTransition(ProjectStatus.DRAFT, ProjectStatus.COMPLETED))
      .toThrow("项目状态不允许");
  });

  it("maps every lifecycle action to its dedicated permission", () => {
    expect(projectStatusActionPermission(ProjectStatus.DRAFT, ProjectStatus.IN_PROGRESS)).toBe("project-info:start");
    expect(projectStatusActionPermission(ProjectStatus.COMPLETED, ProjectStatus.IN_PROGRESS)).toBe("project-info:restore");
    expect(projectStatusActionPermission(ProjectStatus.IN_PROGRESS, ProjectStatus.COMPLETED)).toBe("project-info:complete");
    expect(projectStatusActionPermission(ProjectStatus.IN_PROGRESS, ProjectStatus.VOIDED)).toBe("project-info:void");
    expect(projectStatusActionPermission(ProjectStatus.VOIDED, ProjectStatus.DRAFT)).toBe("project-info:edit");
  });
});
