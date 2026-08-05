"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Lock, Power, PowerOff } from "lucide-react";
import { useConfirm } from "@/components/confirm-provider";
import { ModalDialog } from "@/components/modal-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api-client";
import { useAuth } from "@/contexts/auth-context";
import {
  buildAccountRoleChangeConfirmation,
  type ProjectRoleMembership,
} from "@/lib/role-assignments";

interface AccountItem {
  id: string;
  username: string;
  displayName: string;
  enabled: boolean;
  assignedRoleNames: string[];
  passwordResetRequired: boolean;
  passwordUpdatedAt: string | null;
  createdAt: string;
  projectMemberships: ProjectRoleMembership[];
}

interface RoleConfigItem {
  id: string;
  roleName: string;
}

function EditAccountDialog({
  open,
  onClose,
  account,
  availableRoles,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  account: AccountItem | null;
  availableRoles: RoleConfigItem[];
  onSave: (data: { username: string; displayName: string; assignedRoleNames: string[] }) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [selectedRoleNames, setSelectedRoleNames] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setUsername(account?.username ?? "");
      setDisplayName(account?.displayName ?? "");
      setSelectedRoleNames(account?.assignedRoleNames ?? []);
    }
  }, [open, account]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({ username, displayName, assignedRoleNames: selectedRoleNames });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const toggleRole = (roleName: string) => {
    setSelectedRoleNames((prev) =>
      prev.includes(roleName) ? prev.filter((r) => r !== roleName) : [...prev, roleName]
    );
  };

  const inputClass = "w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";

  return (
    <ModalDialog
      open={open}
      title={account ? "编辑账号" : "新增账号"}
      onClose={onClose}
      size="md"
      footer={
        <>
          <button type="button" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">取消</button>
          <button type="submit" form="account-form" disabled={saving} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40">
            {saving ? "保存中..." : "保存"}
          </button>
        </>
      }
    >
      <form id="account-form" className="space-y-3" onSubmit={handleSubmit}>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">登录账号 *</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} required className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">显示名称 *</label>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required className={inputClass} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">项目角色</label>
          <div className="mt-1 flex flex-wrap gap-2">
            {availableRoles.map((role) => (
              <label key={role.id} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-accent/40 px-2.5 py-1.5 text-xs hover:bg-accent/60">
                <input
                  type="checkbox"
                  checked={selectedRoleNames.includes(role.roleName)}
                  onChange={() => toggleRole(role.roleName)}
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
                <span>{role.roleName}</span>
              </label>
            ))}
            {availableRoles.length === 0 && (
              <span className="text-xs text-muted-foreground">暂无可用角色，请先在“项目角色与人员管理”中添加。</span>
            )}
          </div>
          <div className="mt-1.5 text-[11px] text-muted-foreground">
            同一账号可选多个角色，有效权限按全部角色取并集。
          </div>
        </div>
      </form>
    </ModalDialog>
  );
}

export default function AccountsPage() {
  const { user: currentUser } = useAuth();
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [availableRoles, setAvailableRoles] = useState<RoleConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<AccountItem | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const confirm = useConfirm();

  const fetchData = useCallback(async () => {
    try {
      const [acts, roles] = await Promise.all([
        api.get<AccountItem[]>("/api/accounts"),
        api.get<RoleConfigItem[]>("/api/role-config"),
      ]);
      setAccounts(acts);
      setAvailableRoles(roles.map((r) => ({ id: r.id, roleName: r.roleName })));
    } catch {
      // handled by api-client
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Toast 自动消失
  useEffect(() => {
    if (!toastMsg) return;
    const timer = setTimeout(() => setToastMsg(null), 1500);
    return () => clearTimeout(timer);
  }, [toastMsg]);

  const handleCreate = async (data: { username: string; displayName: string; assignedRoleNames: string[] }) => {
    try {
      await api.post("/api/accounts", { ...data, password: "88888888" });
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "创建失败");
    }
  };

  const handleUpdate = async (data: { username: string; displayName: string; assignedRoleNames: string[] }) => {
    if (!editAccount) return;
    try {
      const roleChangeMessage = buildAccountRoleChangeConfirmation({
        displayName: editAccount.displayName,
        previousRoleNames: editAccount.assignedRoleNames,
        nextRoleNames: data.assignedRoleNames,
        memberships: editAccount.projectMemberships ?? [],
      });
      if (roleChangeMessage && !(await confirm(roleChangeMessage))) return;
      await api.put(`/api/accounts/${editAccount.id}`, {
        ...data,
        confirmRoleChange: Boolean(roleChangeMessage),
      });
      await fetchData();
      if (roleChangeMessage) setToastMsg("账号角色已更新，项目成员和权限已同步");
    } catch (error) {
      alert(error instanceof Error ? error.message : "更新失败");
    }
  };

  const handleToggleEnabled = async (account: AccountItem) => {
    const action = account.enabled ? "停用" : "启用";
    if (!(await confirm(`确认${action}账号「${account.displayName}」？`))) return;
    try {
      await api.put(`/api/accounts/${account.id}`, { enabled: !account.enabled });
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : `${action}失败`);
    }
  };

  const handleResetPassword = async (account: AccountItem) => {
    if (!(await confirm(`确认将账号「${account.displayName}」的密码重置为 88888888？\n\n用户下次登录后需要自行修改密码。`))) return;
    try {
      await api.put(`/api/accounts/${account.id}/password`, { password: "88888888" });
      setToastMsg(`密码已重置为 88888888`);
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "重置失败");
    }
  };

  const handleDelete = async (account: AccountItem) => {
    if (!(await confirm(`确认删除账号「${account.displayName}」？此操作不可撤销。`))) return;
    try {
      await api.delete(`/api/accounts/${account.id}`);
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "删除失败");
    }
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground">加载中...</div>;
  }

  return (
    <div className="space-y-4">
      {/* Accounts Table */}
      <Card>
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">后台账号（{accounts.length}）</span>
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => { setEditAccount(null); setEditOpen(true); }}
          >
            <Plus className="size-3" />
            新增账号
          </Button>
        </div>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>登录账号</TableHead>
                <TableHead>显示名称</TableHead>
                <TableHead>项目角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>需改密</TableHead>
                <TableHead>密码更新</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-medium">{a.username}</TableCell>
                  <TableCell>{a.displayName}</TableCell>
                  <TableCell>{a.assignedRoleNames.join("、") || "-"}</TableCell>
                  <TableCell>
                    <Badge variant={a.enabled ? "success" : "secondary"}>
                      {a.enabled ? "正常" : "已停用"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {a.passwordResetRequired ? (
                      <Badge variant="warning">是</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">否</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.passwordUpdatedAt ? new Date(a.passwordUpdatedAt).toLocaleDateString("zh-CN") : "-"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost" size="sm" className="h-7 text-xs"
                        disabled={a.username === "admin"}
                        onClick={() => { setEditAccount(a); setEditOpen(true); }}
                      >
                        <Pencil className="size-3" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost" size="sm" className="h-7 text-xs"
                        disabled={a.username === "admin"}
                        onClick={() => handleToggleEnabled(a)}
                      >
                        {a.enabled ? <PowerOff className="size-3" /> : <Power className="size-3" />}
                        {a.enabled ? "停用" : "启用"}
                      </Button>
                      {currentUser?.username === "admin" && a.username !== "admin" && (
                        <Button
                          variant="ghost" size="sm" className="h-7 text-xs"
                          onClick={() => handleResetPassword(a)}
                        >
                          <Lock className="size-3" />
                          重置密码
                        </Button>
                      )}
                      <Button
                        variant="ghost" size="sm" className="h-7 text-xs text-destructive"
                        disabled={a.username === "admin"}
                        onClick={() => handleDelete(a)}
                      >
                        <Trash2 className="size-3" />
                        删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {accounts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-sm text-muted-foreground">
                    暂无账号
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <EditAccountDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        account={editAccount}
        availableRoles={availableRoles}
        onSave={editAccount ? handleUpdate : handleCreate}
      />
      {toastMsg && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs font-medium shadow-lg animate-in fade-in slide-in-from-bottom-2">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
