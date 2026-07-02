"use client";

import { ReactNode } from "react";
import type { Project } from "@/domain/models";
import type { ProjectStatus } from "@/domain/enums";

/**
 * RpmsProvider — retained as an empty wrapper for layout backward compatibility.
 * All database state and actions have been migrated to API calls.
 * Can be removed entirely once the layout no longer wraps with it.
 */
export const RpmsProvider = ({ children }: { children: ReactNode }) => {
  return <>{children}</>;
};

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
