export type ProjectModuleDefinition = {
  key: string;
  label: string;
  route?: string;
  permissionKey: string;
  assistantDomains: readonly string[];
  source: "core";
};

/**
 * The shared vocabulary for navigation, permissions, and assistant discovery.
 * This is metadata only: it never creates business records or sample data.
 */
export const PROJECT_MODULE_REGISTRY = [
  {
    key: "project",
    label: "项目信息管理",
    route: "project",
    permissionKey: "project-info:view",
    assistantDomains: ["PROJECT", "MEMBER"],
    source: "core",
  },
  {
    key: "performance",
    label: "挣值分析",
    route: "performance",
    permissionKey: "earned-value:view",
    assistantDomains: ["EARNED_VALUE"],
    source: "core",
  },
  {
    key: "gantt",
    label: "项目WBS管理",
    route: "gantt",
    permissionKey: "project-gantt:view",
    assistantDomains: ["TASK", "SCHEDULE_ANALYSIS", "RESOURCE"],
    source: "core",
  },
  {
    key: "execution",
    label: "项目执行驾驶舱",
    route: "execution",
    permissionKey: "project-gantt:view",
    assistantDomains: ["TASK", "SCHEDULE_ANALYSIS", "RESOURCE"],
    source: "core",
  },
  {
    key: "matters",
    label: "项目事项管理",
    route: "/weekly-items",
    permissionKey: "weekly-items:view",
    assistantDomains: ["MATTER"],
    source: "core",
  },
  {
    key: "documents",
    label: "文档清单管理",
    route: "documents",
    permissionKey: "project-documents:view",
    assistantDomains: ["DOCUMENT"],
    source: "core",
  },
  {
    key: "budget",
    label: "项目预算管理",
    route: "budget",
    permissionKey: "project-budget:view",
    assistantDomains: ["BUDGET", "COST"],
    source: "core",
  },
  {
    key: "risk",
    label: "风险登记册",
    route: "/risk-register",
    permissionKey: "risk-register:view",
    assistantDomains: ["RISK"],
    source: "core",
  },
  {
    key: "approvals",
    label: "审批中心",
    route: "/approvals",
    permissionKey: "approval:view",
    assistantDomains: ["APPROVAL"],
    source: "core",
  },
  {
    key: "collaboration",
    label: "协同沟通",
    route: "/collaboration",
    permissionKey: "collaboration:view",
    assistantDomains: ["COLLABORATION"],
    source: "core",
  },
] as const satisfies readonly ProjectModuleDefinition[];

export const getProjectModuleRegistry = (): ProjectModuleDefinition[] => PROJECT_MODULE_REGISTRY.map((module) => ({
  ...module,
  assistantDomains: [...module.assistantDomains],
}));

export const formatProjectModuleRegistry = (modules: readonly ProjectModuleDefinition[] = PROJECT_MODULE_REGISTRY) => (
  modules.map((module) => `${module.label}(${module.key})`).join("、") || "无"
);
