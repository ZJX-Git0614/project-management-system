import type { Project } from "@/domain/models";

export const DETAIL_NAV_GROUPS = [
  { key: "project", label: "项目信息管理" },
  { key: "performance", label: "挣值分析" },
  { key: "gantt", label: "项目WBS管理" },
  { key: "execution", label: "项目执行阶段" },
  { key: "documents", label: "文档清单管理" },
  { key: "budget", label: "项目预算管理" },
] as const;

export type DetailNavGroupKey = (typeof DETAIL_NAV_GROUPS)[number]["key"];

const DETAIL_NAV_KEYS = new Set<string>(DETAIL_NAV_GROUPS.map((item) => item.key));

const LEGACY_TAB_ALIAS: Record<string, DetailNavGroupKey> = {
  project: "project",
  gantt: "gantt",
  budget: "budget",
};

export const getDefaultProjectId = (projects: Project[]): string | undefined =>
  [...projects].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]?.id;

const extractProjectIdFromPathname = (pathname: string): string | undefined => {
  const match = pathname.match(/^\/projects\/([^/?#]+)/);
  return match?.[1];
};

export const resolveDetailGroup = (navParam?: string | null, legacyTabParam?: string | null): DetailNavGroupKey => {
  if (navParam && DETAIL_NAV_KEYS.has(navParam)) {
    return navParam as DetailNavGroupKey;
  }

  if (legacyTabParam && LEGACY_TAB_ALIAS[legacyTabParam]) {
    return LEGACY_TAB_ALIAS[legacyTabParam];
  }

  return "project";
};

export const buildDetailNavHref = (
  pathname: string,
  projects: Project[],
  groupKey: DetailNavGroupKey,
): string => {
  const projectId = extractProjectIdFromPathname(pathname) || getDefaultProjectId(projects);
  return projectId ? `/projects/${projectId}?nav=${groupKey}` : "/projects";
};

export const isDetailGroupActive = (pathnameWithQuery: string, groupKey: DetailNavGroupKey): boolean => {
  if (!pathnameWithQuery.startsWith("/projects/")) {
    return false;
  }

  const [pathname, queryString] = pathnameWithQuery.split("?");
  if (!extractProjectIdFromPathname(pathname)) {
    return false;
  }

  const searchParams = new URLSearchParams(queryString ?? "");
  return resolveDetailGroup(searchParams.get("nav"), searchParams.get("tab")) === groupKey;
};

export const getDetailGroupPermissionKey = (groupKey: DetailNavGroupKey) => PROJECT_DETAIL_GROUP_PERMISSION_KEYS[groupKey];

export const PROJECT_DETAIL_GROUP_PERMISSION_KEYS: Record<DetailNavGroupKey, string> = {
  project: "project-info:view",
  performance: "earned-value:view",
  gantt: "project-gantt:view",
  execution: "project-gantt:view",
  documents: "project-documents:view",
  budget: "project-budget:view",
};
