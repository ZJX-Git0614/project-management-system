"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { Upload } from "lucide-react";

import { downloadTextFile, toCsv } from "@/lib/utils";
import { usePermissionContext } from "@/contexts/permission-context"
import { usePermission } from "@/lib/use-permission"
import {
  DEFAULT_PERMISSION_TREE,
  getPermissionCheckState,
  isAdminRole,
  PERMISSION_TREE,
  togglePermissionNode,
  type PermissionTreeNode,
  type PermissionTreeState,
} from "@/lib/permissions";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ModalDialog } from "@/components/modal-dialog";
import { useConfirm } from "@/components/confirm-provider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface PermissionDialogState {
  open: boolean;
  mode: "view" | "edit";
  roleName: string;
  fromNewRole?: boolean;
}

interface RoleConfigItem {
  id: string;
  roleName: string;
  systemPreset: boolean;
  allowMultiple: boolean;
  persons: string[];
}

interface RoleReferenceImpact {
  roleId: string;
  roleName: string;
  accountCount: number;
  accounts: Array<{ id: string; displayName: string }>;
  projectCount: number;
  membershipCount: number;
  projects: Array<{
    projectId: string;
    projectName: string;
    personNames: string[];
  }>;
}

const describeRoleImpact = (impact: RoleReferenceImpact) => {
  const lines: string[] = [];
  if (impact.accounts.length > 0) {
    lines.push(`关联账号：${impact.accounts.map((account) => account.displayName).join("、")}`);
  }
  if (impact.projects.length > 0) {
    lines.push("关联项目：");
    impact.projects.forEach((project) => {
      lines.push(`《${project.projectName}》：${project.personNames.join("、") || "无指定人员"}`);
    });
  }
  return lines;
};

export default function RoleConfigPage() {
  const { can } = usePermission();
  const { refreshPermissionTree } = usePermissionContext();
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [roleConfigs, setRoleConfigs] = useState<RoleConfigItem[]>([]);
  const [permissionTree, setPermissionTree] = useState<PermissionTreeState>(() =>
    JSON.parse(JSON.stringify(DEFAULT_PERMISSION_TREE)),
  );
  const [roleName, setRoleName] = useState("");
  const [allowMultiple, setAllowMultiple] = useState(true);
  const [permissionDialog, setPermissionDialog] = useState<PermissionDialogState>({
    open: false,
    mode: "view",
    roleName: "",
  });
  const [editDialog, setEditDialog] = useState<{ open: boolean; role: RoleConfigItem | null }>({
    open: false,
    role: null,
  });
  const [editRoleName, setEditRoleName] = useState("");
  const [editAllowMultiple, setEditAllowMultiple] = useState(true);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const confirm = useConfirm();

  const canMaintainRoleConfig = can("role-config:edit");
  const canViewPermissionConfig = can("permission-config:view");
  const canEditPermissionConfig = can("permission-config:edit");

  const fetchData = useCallback(async () => {
    try {
      const [roles, treeResult] = await Promise.all([
        api.get<RoleConfigItem[]>("/api/role-config"),
        api.get<{ data: PermissionTreeState }>("/api/permission-tree").catch(() => null),
      ]);
      setRoleConfigs(
        roles.map((r) => ({
          ...r,
          persons: typeof r.persons === "string" ? JSON.parse(r.persons as string) : r.persons,
        })),
      );
      if (treeResult?.data && Object.keys(treeResult.data).length > 0) {
        setPermissionTree(treeResult.data);
      }
    } catch {
      // error handled by api-client
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Toast 自动消失
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1500);
    return () => clearTimeout(timer);
  }, [toast]);

  const exportRoleConfig = () => {
    const csv = toCsv(
      ["项目角色", "是否一角多人", "人员库", "操作"],
      roleConfigs.map((item) => [
        item.roleName,
        item.allowMultiple ? "是" : "否",
        item.persons.join("/") || "-",
        [
          canViewPermissionConfig ? "权限查看" : null,
          canEditPermissionConfig ? "权限修改" : null,
          canMaintainRoleConfig ? "编辑" : null,
          canMaintainRoleConfig && !item.systemPreset ? "删除" : null,
        ]
          .filter(Boolean)
          .join(" / ") || "-",
      ]),
    );
    downloadTextFile(`Ceastar项目管理系统_项目角色人员配置_${Date.now()}.csv`, csv);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const result = await api.post<RoleConfigItem>("/api/role-config", {
        roleName,
        allowMultiple,
        persons: [],
      });
      setRoleName("");
      setAllowMultiple(true);
      setAddDialogOpen(false);
      await fetchData();
      // 弹出权限编辑弹窗
      setPermissionDialog({ open: true, mode: "edit", roleName: roleName, fromNewRole: true });
      void result;
    } catch (error) {
      alert(error instanceof Error ? error.message : "添加失败");
    } finally {
      setSubmitting(false);
    }
  };

  const resetAddForm = () => {
    setRoleName("");
    setAllowMultiple(true);
  };

  const handleCloseAdd = () => {
    if (submitting) return;
    setAddDialogOpen(false);
    resetAddForm();
  };

  const handleDeleteRoleConfig = async (item: RoleConfigItem) => {
    try {
      const impact = await api.get<RoleReferenceImpact>(`/api/role-config/${item.id}`);
      const message = [
        `确认删除角色「${item.roleName}」？`,
        ...describeRoleImpact(impact),
        "删除后，账号绑定和项目成员中的该角色会同步解除。",
        "其他角色及其权限不受影响。",
      ].join("\n");
      if (!(await confirm(message))) return;
      await api.delete(`/api/role-config/${item.id}?confirmed=true`);
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    }
  };

  const openEditDialog = (item: RoleConfigItem) => {
    setEditRoleName(item.roleName);
    setEditAllowMultiple(item.allowMultiple);
    setEditDialog({ open: true, role: item });
  };

  const closeEditDialog = () => {
    setEditDialog({ open: false, role: null });
  };

  const handleEditSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editDialog.role) return;
    try {
      const nextRoleName = editRoleName.trim();
      const roleNameChanged = nextRoleName !== editDialog.role.roleName;
      if (roleNameChanged) {
        const impact = await api.get<RoleReferenceImpact>(`/api/role-config/${editDialog.role.id}`);
        const message = [
          `确认将角色「${editDialog.role.roleName}」改名为「${nextRoleName}」？`,
          ...describeRoleImpact(impact),
          "账号绑定、项目成员和该角色的权限配置将同步更新。",
        ].join("\n");
        if (!(await confirm(message))) return;
      }
      await api.put(`/api/role-config/${editDialog.role.id}`, {
        roleName: nextRoleName,
        allowMultiple: editAllowMultiple,
        confirmRoleChange: roleNameChanged,
      });
      closeEditDialog();
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "编辑失败");
    }
  };

  const openPermissionDialog = (targetRoleName: string, mode: "view" | "edit") => {
    setPermissionDialog({ open: true, mode, roleName: targetRoleName, fromNewRole: false });
  };

  const closePermissionDialog = () => {
    setPermissionDialog((prev) => ({ ...prev, open: false }));
  };

  const closePermissionWithToast = (message: string) => {
    setPermissionDialog((prev) => ({ ...prev, open: false }));
    setToast(message);
  };

  const handleSavePermission = async () => {
    try {
      await api.put("/api/permission-tree", { data: permissionTree });
      await refreshPermissionTree();
      closePermissionWithToast("保存成功");
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
    }
  };

  const handlePermissionToggle = (roleName: string, nodeKey: string) => {
    if (permissionDialog.mode !== "edit") return;
    setPermissionTree((prev) => togglePermissionNode(structuredClone(prev), roleName, nodeKey));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-sm text-muted-foreground">加载中...</div>
      </div>
    );
  }

  return (
    <>
      {/* Toast 提示 */}
      {toast && (
        <div className="fixed left-1/2 top-4 z-[60] -translate-x-1/2 animate-in fade-in slide-in-from-top-2 rounded-md border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-lg">
          {toast}
        </div>
      )}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle>项目角色与人员管理</CardTitle>
            <div className="flex items-center gap-1.5">
              {canMaintainRoleConfig && (
                <Button
                  type="button"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setAddDialogOpen(true)}
                >
                  添加项目角色
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={exportRoleConfig}
              >
                <Upload className="size-3" />
                导出
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>项目角色</TableHead>
                <TableHead>是否存在一角多人</TableHead>
                <TableHead>人员库</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roleConfigs.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.roleName}</TableCell>
                    <TableCell>{item.allowMultiple ? "是" : "否"}</TableCell>
                    <TableCell>{item.persons.join("、") || "-"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {canViewPermissionConfig ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => openPermissionDialog(item.roleName, "view")}
                          >
                            权限查看
                          </Button>
                        ) : (
                          <span className="text-xs text-slate-300">权限查看</span>
                        )}
                        {canEditPermissionConfig ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => openPermissionDialog(item.roleName, "edit")}
                          >
                            权限修改
                          </Button>
                        ) : (
                          <span className="text-xs text-slate-300">权限修改</span>
                        )}
                        {canMaintainRoleConfig ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => openEditDialog(item)}
                          >
                            编辑
                          </Button>
                        ) : (
                          <span className="text-xs text-slate-300">编辑</span>
                        )}
                        {canMaintainRoleConfig && !item.systemPreset ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-destructive hover:text-destructive"
                            onClick={() => handleDeleteRoleConfig(item)}
                          >
                            删除
                          </Button>
                        ) : !item.systemPreset ? (
                          <span className="text-xs text-slate-300">删除</span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
              ))}
              {roleConfigs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-slate-500">
                    暂无项目角色，点击「添加项目角色」开始维护
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

        <ModalDialog
          open={addDialogOpen}
          title="添加项目角色"
          size="sm"
          onClose={handleCloseAdd}
          footer={
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={handleCloseAdd}
                disabled={submitting}
              >
                取消
              </Button>
              <Button
                type="submit"
                form="role-add-form"
                size="sm"
                className="h-7 text-xs"
                disabled={submitting}
              >
                {submitting ? "提交中..." : "确认添加"}
              </Button>
            </>
          }
        >
          <form id="role-add-form" className="space-y-3" onSubmit={handleSubmit}>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-slate-700">角色名称<span className="text-red-500">*</span></label>
              <input
                value={roleName}
                onChange={(event) => setRoleName(event.target.value)}
                placeholder="如：项目经理"
                required
                className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-slate-700">一角多人</label>
              <select
                value={allowMultiple ? "YES" : "NO"}
                onChange={(event) => setAllowMultiple(event.target.value === "YES")}
                className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-xs"
              >
                <option value="YES">是（同一项目可分配多人）</option>
                <option value="NO">否（同一项目仅一人）</option>
              </select>
            </div>
            <div className="text-[10px] text-slate-500">添加后将自动打开权限编辑弹窗，可继续配置该角色的权限点。</div>
          </form>
        </ModalDialog>

      {/* 编辑角色弹窗 */}
      {editDialog.open && editDialog.role && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-6 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          onClick={closeEditDialog}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div className="text-lg font-semibold text-slate-900">编辑角色</div>
              <button type="button" className="rounded-lg border border-slate-200 px-3 py-1 text-sm text-slate-600 hover:bg-slate-50" onClick={closeEditDialog}>
                取消
              </button>
            </div>
            <form onSubmit={handleEditSubmit} className="space-y-4 p-6">
              <div>
                <label className="mb-1 block text-sm text-slate-600">角色名称</label>
                <input
                  value={editRoleName}
                  onChange={(e) => setEditRoleName(e.target.value)}
                  required
                  disabled={editDialog.role.systemPreset}
                  className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                />
                {editDialog.role.systemPreset && <div className="mt-1 text-xs text-amber-600">系统预置角色，名称只读</div>}
              </div>
              <div>
                <label className="mb-1 block text-sm text-slate-600">一角多人</label>
                <select
                  value={editAllowMultiple ? "YES" : "NO"}
                  onChange={(e) => setEditAllowMultiple(e.target.value === "YES")}
                  className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="YES">是（允许同一角色有多人）</option>
                  <option value="NO">否（同一角色只能一人）</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50" onClick={closeEditDialog}>
                  取消
                </button>
                <button type="submit" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {permissionDialog.open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-6 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-label={permissionDialog.mode === "view" ? "权限查看窗口" : "权限修改窗口"}
          onClick={() => closePermissionDialog()}
        >
          <div
            className="flex h-[78vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-slate-200 px-6 py-5">
              <div>
                <div className="text-xl font-semibold text-slate-900">
                  {permissionDialog.mode === "view" ? "权限查看" : permissionDialog.fromNewRole ? "配置角色权限（可选）" : "权限修改"}
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  当前角色：{permissionDialog.roleName}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {permissionDialog.mode === "edit" && !permissionDialog.fromNewRole && (
                  <button
                    type="button"
                    className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                    onClick={handleSavePermission}
                  >
                    保存
                  </button>
                )}
                {permissionDialog.fromNewRole && (
                  <>
                    <button
                      type="button"
                      className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                      onClick={handleSavePermission}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                      onClick={() => closePermissionWithToast("添加成功")}
                    >
                      跳过
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                  onClick={() => permissionDialog.fromNewRole ? closePermissionWithToast("添加成功") : closePermissionDialog()}
                >
                  {permissionDialog.fromNewRole ? "关闭" : "关闭"}
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              {permissionDialog.roleName ? (
                <div className="space-y-5">
                  <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-5 py-4">
                      <div>
                        <div className="text-sm font-semibold text-slate-800">{permissionDialog.roleName}</div>
                        <div className="mt-1 text-xs text-slate-500">
                          {permissionDialog.mode === "view"
                            ? "当前为只读浏览模式，可展开或收起节点。"
                            : "当前为编辑模式，勾选将即时写入现有权限树。"}
                        </div>
                      </div>
                    </div>
                    <div className="overflow-hidden rounded-b-2xl">
                      <div className="p-2">
                        {PERMISSION_TREE.map((node) => (
                          <DialogPermissionNodeItem
                            key={`${permissionDialog.roleName}-${node.key}`}
                            roleName={permissionDialog.roleName}
                            node={node}
                            tree={permissionTree}
                            editable={permissionDialog.mode === "edit"}
                            onToggle={(nodeKey) => handlePermissionToggle(permissionDialog.roleName, nodeKey)}
                          />
                        ))}
                      </div>
                    </div>
                  </section>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-8 text-sm text-slate-500">
                  当前角色暂未接入系统权限树编辑能力。
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function DialogPermissionNodeItem({
  roleName,
  node,
  tree,
  depth = 0,
  editable,
  onToggle,
}: {
  roleName: string;
  node: PermissionTreeNode;
  tree: PermissionTreeState;
  depth?: number;
  editable: boolean;
  onToggle: (nodeKey: string) => void;
}) {
  const { checked, indeterminate } = getPermissionCheckState(tree, roleName, node.key);
  const disabled = isAdminRole(roleName);
  const [expanded, setExpanded] = useState(depth === 0);
  const hasChildren = Boolean(node.children?.length);

  return (
    <div className={depth === 0 ? "rounded-lg border border-slate-100 bg-slate-50" : ""}>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-50"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => hasChildren && setExpanded((value) => !value)}
      >
        <input
          ref={(element) => {
            if (element) element.indeterminate = indeterminate;
          }}
          type="checkbox"
          checked={checked}
          disabled={!editable || disabled}
          onChange={() => onToggle(node.key)}
          onClick={(event) => event.stopPropagation()}
          className="h-4 w-4 rounded border-slate-300"
        />
        {hasChildren && <span className="w-4 text-slate-400">{expanded ? "▾" : "▸"}</span>}
        {!hasChildren && <span className="w-4" />}
        <span className="font-medium text-slate-700">{node.label}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-500">{node.type}</span>
      </button>
      {hasChildren && expanded && (
        <div className="pb-1">
          {node.children!.map((child) => (
            <DialogPermissionNodeItem
              key={`${roleName}-${child.key}`}
              roleName={roleName}
              node={child}
              tree={tree}
              depth={depth + 1}
              editable={editable}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
