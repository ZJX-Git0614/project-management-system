"use client";

import type { Project } from "@/domain/models";
import type { ProjectStatus } from "@/domain/enums";

/**
 * Utility: filter projects by keyword and status.
 * Used by the projects list page.
 */
export const useProjectFilter = (
  projects: Project[],
  keyword: string,
  status: "ALL" | ProjectStatus,
): Project[] => {
  const normalized = keyword.trim().toLowerCase();
  return projects.filter((project) => {
    const hitKeyword = !normalized || project.name.toLowerCase().includes(normalized);
    const hitStatus = status === "ALL" || project.status === status;
    return hitKeyword && hitStatus;
  });
};
