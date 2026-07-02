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
            key: "project-gantt",
            label: "项目进度甘特图",
            type: "section",
            children: [
              { key: "project-gantt:view", label: "查看项目进度甘特图", type: "section" },
              { key: "project-gantt:create", label: "新增甘特任务", type: "action" },
              { key: "project-gantt:edit", label: "编辑甘特任务", type: "action" },
              { key: "project-gantt:delete", label: "删除甘特任务", type: "action" },
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
    key: "project-progress",
    label: "项目进度追踪",
    type: "group",
    children: [
      {
        key: "overview",
        label: "项目进度总揽",
        type: "page",
        children: [
          { key: "overview:view", label: "查看项目进度总揽", type: "section" },
        ],
      },
      {
        key: "monthly-items",
        label: "本月事项",
        type: "page",
        children: [
          { key: "monthly-items:view", label: "查看本月事项", type: "section" },
          { key: "monthly-items:create", label: "新增本月事项", type: "action" },
          { key: "monthly-items:edit", label: "编辑本月事项", type: "action" },
          { key: "monthly-items:delete", label: "删除本月事项", type: "action" },
          { key: "monthly-items:export", label: "导出本月事项", type: "action" },
        ],
      },
      {
        key: "weekly-items",
        label: "本周事项",
        type: "page",
        children: [
          { key: "weekly-items:view", label: "查看本周事项", type: "section" },
          { key: "weekly-items:create", label: "新增本周事项", type: "action" },
          { key: "weekly-items:edit", label: "编辑本周事项", type: "action" },
          { key: "weekly-items:delete", label: "删除本周事项", type: "action" },
          { key: "weekly-items:export", label: "导出本周事项", type: "action" },
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
  gantt: "project-gantt:view",
  budget: "project-budget:view",
} as const;

export const NAV_GROUP_PERMISSION_KEYS = {
  projectList: "project-list",
  projectDashboard: "project-dashboard",
  projectProgress: "project-progress",
  projectRisk: "project-risk",
  systemSettings: "system-settings",
} as const;

export const PERMISSION_ROUTE_RULES: PermissionRouteRule[] = [
  { pathname: "/projects", permissionKey: "project-list:view" },
  { pathname: "/projects/[projectId]", queryParam: "nav", queryValue: "project", permissionKey: "project-info:view" },
  { pathname: "/projects/[projectId]", queryParam: "nav", queryValue: "gantt", permissionKey: "project-gantt:view" },
  { pathname: "/projects/[projectId]", queryParam: "nav", queryValue: "budget", permissionKey: "project-budget:view" },
  { pathname: "/role-config", permissionKey: "role-config:view" },
  { pathname: "/admin/permissions", permissionKey: "permission-config:view" },
  { pathname: "/admin/accounts", permissionKey: "account-management:view" },
  { pathname: "/overview", permissionKey: "overview:view" },
  { pathname: "/monthly-items", permissionKey: "monthly-items:view" },
  { pathname: "/weekly-items", permissionKey: "weekly-items:view" },
  { pathname: "/risk-register", permissionKey: "risk-register:view" },
];

const cloneKeys = (keys: readonly string[]) => [...keys];

const allNodeKeysFor = (nodeKey: string): string[] => [nodeKey, ...PERMISSION_DESCENDANT_KEYS[nodeKey]];

export const DEFAULT_PERMISSION_TREE: PermissionTreeState = {
  [ADMIN_ROLE_NAME]: cloneKeys(PERMISSION_NODE_KEYS),
  "项目经理": [
    ...allNodeKeysFor("project-list"),
    ...allNodeKeysFor("project-dashboard"),
    ...allNodeKeysFor("project-progress"),
    ...allNodeKeysFor("project-risk"),
  ],
  "项目成员": [
    "project-list",
    "project-list:view",
    "project-list:export",
    "project-dashboard",
    "project-info",
    "project-info:view",
    "project-info:core-view",
    "project-gantt",
    "project-gantt:view",
    "project-budget",
    "project-budget:view",
    "project-members",
    "project-members:view",
    "project-progress",
    "overview",
    "overview:view",
    "monthly-items",
    "monthly-items:view",
    "weekly-items",
    "weekly-items:view",
    "project-risk",
    "risk-register",
    "risk-register:view",
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

    const validKeys = value.filter((key): key is string => typeof key === "string" && key in PERMISSION_NODE_BY_KEY);
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
