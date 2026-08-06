import { AppRole } from "@/domain/enums";

export const PERMISSION_ROLE_ORDER = [AppRole.ADMIN, AppRole.PROJECT_MANAGER, AppRole.MEMBER] as const;

/** 默认拥有全部权限的角色名（与 seed 中管理员账号的 assignedRoleNames 保持一致） */
export const ADMIN_ROLE_NAME = "管理员";

export type PermissionTreeNodeType = "group" | "page" | "section" | "action";

export interface PermissionTreeNode {
  key: string;
  label: string;
  type: PermissionTreeNodeType;
  children?: PermissionTreeNode[];
}

export interface PermissionRouteRule {
  pathname: string;
  queryParam?: string;
  queryValue?: string;
  permissionKey: string;
}

export const PERMISSION_TREE = [
  {
    key: "project-list",
    label: "项目列表",
    type: "group",
    children: [
      { key: "project-list:view", label: "查看项目列表", type: "page" },
      { key: "project-list:create", label: "创建项目", type: "action" },
      { key: "project-list:export", label: "导出项目列表", type: "action" },
      { key: "project-list:start", label: "启动项目", type: "action" },
      { key: "project-list:complete", label: "完成项目", type: "action" },
      { key: "project-list:void", label: "作废项目", type: "action" },
      { key: "project-list:restore", label: "恢复项目", type: "action" },
    ],
  },
  {
    key: "project-dashboard",
    label: "项目驾驶舱",
    type: "group",
    children: [
      {
        key: "project-info",
        label: "项目信息管理",
        type: "page",
        children: [
          { key: "project-info:view", label: "查看项目信息页", type: "section" },
          { key: "project-info:core-view", label: "查看项目核心信息卡", type: "section" },
          { key: "project-info:edit", label: "保存项目信息", type: "action" },
          { key: "project-info:status-request", label: "申请项目状态变更", type: "action" },
          { key: "project-info:start", label: "启动项目", type: "action" },
          { key: "project-info:complete", label: "完成项目", type: "action" },
          { key: "project-info:void", label: "作废项目", type: "action" },
          { key: "project-info:restore", label: "恢复项目", type: "action" },
          {
            key: "project-members",
            label: "项目组成员",
            type: "section",
            children: [
              { key: "project-members:view", label: "查看项目组成员", type: "section" },
              { key: "project-members:export", label: "导出项目组成员", type: "action" },
              { key: "project-members:create", label: "添加成员", type: "action" },
              { key: "project-members:delete", label: "删除成员", type: "action" },
            ],
          },
          {
            key: "project-budget",
            label: "项目预算管理",
            type: "section",
            children: [
              { key: "project-budget:view", label: "查看项目预算", type: "section" },
              { key: "project-budget:create", label: "新增预算条目", type: "action" },
              { key: "project-budget:edit", label: "编辑预算条目", type: "action" },
              { key: "project-budget:delete", label: "删除预算条目", type: "action" },
              { key: "project-budget:category-manage", label: "管理预算分类", type: "action" },
              { key: "project-budget:settings-manage", label: "管理预算费率参数", type: "action" },
            ],
          },
        ],
      },
    ],
  },
  {
    key: "project-performance",
    label: "项目绩效管理",
    type: "group",
    children: [
      {
        key: "earned-value",
        label: "挣值分析",
        type: "page",
        children: [
          { key: "earned-value:view", label: "查看挣值分析", type: "section" },
          { key: "earned-value:edit", label: "维护任务 BAC 与 AC", type: "action" },
        ],
      },
    ],
  },
  {
    key: "project-progress",
    label: "项目进度管理",
    type: "group",
    children: [
      {
        key: "project-wbs",
        label: "项目WBS管理",
        type: "page",
        children: [
          { key: "project-gantt:view", label: "查看项目WBS管理", type: "section" },
          { key: "project-gantt:create", label: "新增甘特任务", type: "action" },
          { key: "project-gantt:edit", label: "编辑甘特任务", type: "action" },
          { key: "project-gantt:delete", label: "删除甘特任务", type: "action" },
          { key: "project-gantt:baseline-request", label: "申请发布 WBS 基线", type: "action" },
        ],
      },
      {
        key: "weekly-items",
        label: "项目事项管理",
        type: "page",
        children: [
          { key: "weekly-items:view", label: "查看项目事项", type: "section" },
          { key: "weekly-items:create", label: "新增项目事项", type: "action" },
          { key: "weekly-items:edit", label: "编辑项目事项", type: "action" },
          { key: "weekly-items:delete", label: "删除项目事项", type: "action" },
          { key: "weekly-items:export", label: "导出项目事项", type: "action" },
        ],
      },
    ],
  },
  {
    key: "project-scope",
    label: "项目范围管理",
    type: "group",
    children: [
      {
        key: "project-documents",
        label: "文档清单管理",
        type: "page",
        children: [
          { key: "project-documents:view", label: "查看文档清单管理", type: "section" },
          { key: "project-documents:create", label: "上传项目文档", type: "action" },
          { key: "project-documents:delete", label: "删除项目文档", type: "action" },
        ],
      },
    ],
  },
  {
    key: "project-risk",
    label: "项目风险管理",
    type: "group",
    children: [
      {
        key: "risk-register",
        label: "风险登记册",
        type: "page",
        children: [
          { key: "risk-register:view", label: "查看风险登记册", type: "section" },
          { key: "risk-register:create", label: "新增风险", type: "action" },
          { key: "risk-register:edit", label: "编辑风险", type: "action" },
          { key: "risk-register:delete", label: "删除风险", type: "action" },
        ],
      },
    ],
  },
  {
    key: "project-collaboration",
    label: "项目协同管理",
    type: "group",
    children: [
      {
        key: "approval-center",
        label: "审批中心",
        type: "page",
        children: [
          { key: "approval-center:view", label: "查看审批中心", type: "section" },
          { key: "approval-center:process", label: "处理本人审批", type: "action" },
          { key: "approval-center:cancel", label: "撤销本人发起的审批", type: "action" },
          { key: "approval-center:retry", label: "重试失败的业务执行", type: "action" },
        ],
      },
      {
        key: "collaboration-center",
        label: "协同沟通",
        type: "page",
        children: [
          { key: "collaboration-center:view", label: "查看协同会话", type: "section" },
          { key: "collaboration-center:create", label: "创建协同会话", type: "action" },
          { key: "collaboration-center:message", label: "发送协同消息", type: "action" },
        ],
      },
    ],
  },
  {
    key: "system-settings",
    label: "系统设置",
    type: "group",
    children: [
      {
        key: "role-config",
        label: "项目角色与人员管理",
        type: "page",
        children: [
          { key: "role-config:view", label: "查看角色与人员管理", type: "section" },
          { key: "role-config:edit", label: "维护角色与人员管理", type: "action" },
        ],
      },
      {
        key: "permission-config",
        label: "权限矩阵",
        type: "page",
        children: [
          { key: "permission-config:view", label: "查看权限矩阵", type: "section" },
          { key: "permission-config:edit", label: "配置权限矩阵", type: "action" },
        ],
      },
      {
        key: "account-management",
        label: "后台账号管理",
        type: "page",
        children: [
          { key: "account-management:view", label: "查看后台账号管理", type: "section" },
          { key: "account-management:edit", label: "维护后台账号管理", type: "action" },
        ],
      },
      {
        key: "approval-workflow-config",
        label: "审批流程配置",
        type: "page",
        children: [
          { key: "approval-workflow-config:view", label: "查看审批流程配置", type: "section" },
          { key: "approval-workflow-config:edit", label: "编辑审批流程草稿", type: "action" },
          { key: "approval-workflow-config:publish", label: "发布审批流程版本", type: "action" },
          { key: "approval-workflow-config:delegate", label: "配置审批委托", type: "action" },
          { key: "approval-workflow-config:remind", label: "执行审批催办", type: "action" },
          { key: "approval-workflow-config:analytics", label: "查看审批统计", type: "section" },
        ],
      },
    ],
  },
] as const satisfies readonly PermissionTreeNode[];

export type PermissionNodeKey = string;
export type PermissionTree = readonly PermissionTreeNode[];
export type PermissionTreeState = Record<string, PermissionNodeKey[]>;

export const FLAT_PERMISSION_NODES: PermissionTreeNode[] = [];

const flattenPermissionNodes = (nodes: readonly PermissionTreeNode[]) => {
  for (const node of nodes) {
    FLAT_PERMISSION_NODES.push(node);
    if (node.children?.length) {
      flattenPermissionNodes(node.children);
    }
  }
};

flattenPermissionNodes(PERMISSION_TREE);

export const PERMISSION_NODE_BY_KEY: Record<string, PermissionTreeNode> = Object.fromEntries(
  FLAT_PERMISSION_NODES.map((node) => [node.key, node]),
);

export const PERMISSION_NODE_KEYS = FLAT_PERMISSION_NODES.map((node) => node.key);

export const PERMISSION_CHILDREN_KEYS: Record<string, string[]> = Object.fromEntries(
  FLAT_PERMISSION_NODES.map((node) => [node.key, node.children?.map((child) => child.key) ?? []]),
);

export const PERMISSION_DESCENDANT_KEYS: Record<string, string[]> = {};
export const PERMISSION_PARENT_KEY: Record<string, string | null> = {};

const collectDescendants = (node: PermissionTreeNode, parentKey: string | null): string[] => {
  PERMISSION_PARENT_KEY[node.key] = parentKey;
  const descendants: string[] = [];
  for (const child of node.children ?? []) {
    descendants.push(child.key);
    descendants.push(...collectDescendants(child, node.key));
  }
  PERMISSION_DESCENDANT_KEYS[node.key] = descendants;
  return descendants;
};

PERMISSION_TREE.forEach((node) => collectDescendants(node, null));

export const PROJECT_DETAIL_GROUP_PERMISSION_KEYS = {
  project: "project-info:view",
  performance: "earned-value:view",
  gantt: "project-gantt:view",
  documents: "project-documents:view",
  budget: "project-budget:view",
} as const;

export const NAV_GROUP_PERMISSION_KEYS = {
  projectList: "project-list",
  projectDashboard: "project-dashboard",
  projectPerformance: "project-performance",
  projectProgress: "project-progress",
  projectScope: "project-scope",
  projectRisk: "project-risk",
  projectCollaboration: "project-collaboration",
  systemSettings: "system-settings",
} as const;

export const PERMISSION_ROUTE_RULES: PermissionRouteRule[] = [
  { pathname: "/projects", permissionKey: "project-list:view" },
  { pathname: "/projects/[projectId]", queryParam: "nav", queryValue: "project", permissionKey: "project-info:view" },
  { pathname: "/projects/[projectId]", queryParam: "nav", queryValue: "performance", permissionKey: "earned-value:view" },
  { pathname: "/projects/[projectId]", queryParam: "nav", queryValue: "gantt", permissionKey: "project-gantt:view" },
  { pathname: "/projects/[projectId]", queryParam: "nav", queryValue: "documents", permissionKey: "project-documents:view" },
  { pathname: "/projects/[projectId]", queryParam: "nav", queryValue: "budget", permissionKey: "project-budget:view" },
  { pathname: "/role-config", permissionKey: "role-config:view" },
  { pathname: "/admin/permissions", permissionKey: "permission-config:view" },
  { pathname: "/admin/accounts", permissionKey: "account-management:view" },
  { pathname: "/overview", permissionKey: "project-gantt:view" },
  { pathname: "/weekly-items", permissionKey: "weekly-items:view" },
  { pathname: "/risk-register", permissionKey: "risk-register:view" },
  { pathname: "/approvals", permissionKey: "approval-center:view" },
  { pathname: "/collaboration", permissionKey: "collaboration-center:view" },
  { pathname: "/admin/approval-workflows", permissionKey: "approval-workflow-config:view" },
];

const cloneKeys = (keys: readonly string[]) => [...keys];

const allNodeKeysFor = (nodeKey: string): string[] => [nodeKey, ...PERMISSION_DESCENDANT_KEYS[nodeKey]];

/**
 * 旧版本将甘特页面拆成“项目进度总揽”和“项目进度管理”两套节点。
 * 新版统一为项目 WBS 管理；保留映射避免已保存的角色配置失效。
 */
const LEGACY_PERMISSION_KEY_MIGRATIONS: Record<string, readonly string[]> = {
  "project-gantt": ["project-wbs", "project-gantt:view"],
  overview: ["project-wbs", "project-gantt:view"],
  "overview:view": ["project-gantt:view"],
};

const normalizePermissionKeys = (keys: unknown[]): string[] => keys
  .flatMap((key) => {
    if (typeof key !== "string") return [];
    return LEGACY_PERMISSION_KEY_MIGRATIONS[key] ?? [key];
  })
  .filter((key) => key in PERMISSION_NODE_BY_KEY);

export const DEFAULT_PERMISSION_TREE: PermissionTreeState = {
  [ADMIN_ROLE_NAME]: cloneKeys(PERMISSION_NODE_KEYS),
  "项目经理": [
    ...allNodeKeysFor("project-list"),
    ...allNodeKeysFor("project-dashboard"),
    ...allNodeKeysFor("project-performance"),
    ...allNodeKeysFor("project-progress"),
    ...allNodeKeysFor("project-scope"),
    ...allNodeKeysFor("project-risk"),
    ...allNodeKeysFor("project-collaboration"),
  ],
  "项目成员": [
    "project-list",
    "project-list:view",
    "project-list:export",
    "project-dashboard",
    "project-info",
    "project-info:view",
    "project-info:core-view",
    "project-performance",
    "earned-value",
    "earned-value:view",
    "project-budget",
    "project-budget:view",
    "project-members",
    "project-members:view",
    "project-progress",
    "project-wbs",
    "weekly-items",
    "weekly-items:view",
    "project-scope",
    "project-documents",
    "project-documents:view",
    "project-risk",
    "risk-register",
    "risk-register:view",
    "project-collaboration",
    "approval-center",
    "approval-center:view",
    "approval-center:process",
    "approval-center:cancel",
    "collaboration-center",
    "collaboration-center:view",
    "collaboration-center:create",
    "collaboration-center:message",
  ],
};

export const cloneDefaultPermissionTree = (): PermissionTreeState => JSON.parse(JSON.stringify(DEFAULT_PERMISSION_TREE));

const dedupe = (keys: string[]) => Array.from(new Set(keys));

export const normalizePermissionTree = (tree: Partial<PermissionTreeState> | undefined): PermissionTreeState => {
  const defaults = cloneDefaultPermissionTree();
  const normalized: PermissionTreeState = {};

  for (const [roleName, keys] of Object.entries(defaults)) {
    normalized[roleName] = keys;
  }

  for (const [roleName, value] of Object.entries(tree ?? {})) {
    if (!Array.isArray(value)) {
      normalized[roleName] = defaults[roleName] ?? [];
      continue;
    }

    const validKeys = normalizePermissionKeys(value);
    const expanded = new Set<string>();

    validKeys.forEach((key) => {
      expanded.add(key);
      const parentKey = PERMISSION_PARENT_KEY[key];
      if (parentKey) {
        expanded.add(parentKey);
      }
    });

    // Merge with default keys to ensure new permissions are always included
    const defaultKeys = defaults[roleName] ?? [];
    defaultKeys.forEach((key) => expanded.add(key));

    normalized[roleName] = closePermissionTree(Array.from(expanded));
  }

  return normalized;
};

export const closePermissionTree = (keys: string[]): string[] => {
  const next = new Set(keys.filter((key) => key in PERMISSION_NODE_BY_KEY));

  let changed = true;
  while (changed) {
    changed = false;

    for (const key of Array.from(next)) {
      let parentKey = PERMISSION_PARENT_KEY[key];
      while (parentKey) {
        if (!next.has(parentKey)) {
          next.add(parentKey);
          changed = true;
        }
        parentKey = PERMISSION_PARENT_KEY[parentKey];
      }
    }

    for (const node of FLAT_PERMISSION_NODES) {
      const childKeys = PERMISSION_CHILDREN_KEYS[node.key];
      if (childKeys.length > 0 && childKeys.every((childKey) => next.has(childKey)) && !next.has(node.key)) {
        next.add(node.key);
        changed = true;
      }
    }
  }

  return dedupe(Array.from(next));
};

export const togglePermissionNode = (
  tree: PermissionTreeState,
  roleName: string,
  nodeKey: string,
): PermissionTreeState => {
  if (roleName === ADMIN_ROLE_NAME) {
    return tree;
  }

  const next: PermissionTreeState = JSON.parse(JSON.stringify(tree));
  const selected = new Set(next[roleName] ?? []);
  const targetKeys = [nodeKey, ...PERMISSION_DESCENDANT_KEYS[nodeKey]];
  const shouldSelect = !selected.has(nodeKey);

  if (shouldSelect) {
    targetKeys.forEach((key) => selected.add(key));
    let parentKey = PERMISSION_PARENT_KEY[nodeKey];
    while (parentKey) {
      selected.add(parentKey);
      parentKey = PERMISSION_PARENT_KEY[parentKey];
    }
  } else {
    targetKeys.forEach((key) => selected.delete(key));
    let parentKey = PERMISSION_PARENT_KEY[nodeKey];
    while (parentKey) {
      const childKeys = PERMISSION_CHILDREN_KEYS[parentKey];
      if (childKeys.some((childKey) => selected.has(childKey))) {
        break;
      }
      selected.delete(parentKey);
      parentKey = PERMISSION_PARENT_KEY[parentKey];
    }
  }

  next[roleName] = closePermissionTree(Array.from(selected));
  return next;
};

export const hasPermission = (tree: PermissionTreeState, roleName: string, nodeKey: string): boolean => {
  if (!tree) return false;
  return (tree[roleName] ?? []).includes(nodeKey);
};

export const getPermissionCheckState = (tree: PermissionTreeState, roleName: string, nodeKey: string) => {
  const selected = new Set(tree[roleName] ?? []);
  const childKeys = PERMISSION_CHILDREN_KEYS[nodeKey];
  if (!childKeys.length) {
    return {
      checked: selected.has(nodeKey),
      indeterminate: false,
    };
  }

  const directChecked = selected.has(nodeKey);
  const checkedChildrenCount = childKeys.filter((childKey) => selected.has(childKey)).length;
  const checked = directChecked && checkedChildrenCount === childKeys.length;
  const indeterminate = checkedChildrenCount > 0 && checkedChildrenCount < childKeys.length;

  return { checked, indeterminate };
};

export const isAdminRole = (roleName: string) => roleName === ADMIN_ROLE_NAME;
