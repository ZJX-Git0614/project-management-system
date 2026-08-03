"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ProjectStatus } from "@/domain/enums";
import { PROJECT_STATUS_LABEL } from "@/lib/constants";
import { resolveDetailGroup } from "@/lib/navigation";
import { useCurrentProject } from "@/contexts/current-project-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useConfirm } from "@/components/confirm-provider";
import { usePermission } from "@/lib/use-permission";
import { api } from "@/lib/api-client";
import { ProjectGanttPanel } from "@/components/project-gantt-panel";
import { ProjectBudgetPanel } from "@/components/project-budget-panel";
import { ProjectDocumentListPanel } from "@/components/project-document-list-panel";
import { ProjectEarnedValuePanel } from "@/components/project-earned-value-panel";

interface Project {
  id: string;
  name: string;
  code: string;
  clientName: string;
  amountWan: number;
  deviceCount: number;
  repairCycleDays: number;
  startDate: string;
  expectedEndDate: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

interface ProjectMember {
  id: string;
  projectId: string;
  accountId?: string | null;
  roleName: string;
  personName: string;
  createdAt: string;
}

interface AccountItem {
  id: string;
  displayName: string;
  enabled: boolean;
  assignedRoleNames: string[];
}

export default function ProjectDetailPage() {
  return (
    <Suspense fallback={<div className="text-sm text-slate-500">加载中...</div>}>
      <ProjectDetailContent />
    </Suspense>
  );
}

const ProjectDetailContent = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [project, setProject] = useState<Project | null>(null);
  const [projectLoading, setProjectLoading] = useState(true);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectMissing, setProjectMissing] = useState(false);
  const { currentProjectId, setCurrentProject } = useCurrentProject();

  const navParam = searchParams.get("nav");
  const legacyTabParam = searchParams.get("tab");
  const activeGroup = resolveDetailGroup(navParam, legacyTabParam);

  const fetchProject = useCallback(async () => {
    try {
      setProjectLoading(true);
      setProjectError(null);
      const data = await api.get<Project & { projectMembers: ProjectMember[] }>(
        `/api/projects/${projectId}`
      );
      setProject(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载项目失败";
      setProjectError(message);
      // 项目不存在（404）→ 自动跳回项目列表；其他错误停留在原页允许重试
      if (/不存在|404|not\s*found/i.test(message)) {
        setProjectMissing(true);
        router.replace("/projects");
      }
    } finally {
      setProjectLoading(false);
    }
  }, [projectId, router]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  useEffect(() => {
    if (!project || currentProjectId === project.id) return;
    setCurrentProject(project.id);
  }, [currentProjectId, project, setCurrentProject]);

  if (projectLoading) {
    return <div className="text-sm text-slate-500">加载中...</div>;
  }

  if (projectError) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-destructive">加载项目失败：{projectError}</div>
        {projectMissing ? (
          <div className="text-xs text-muted-foreground">已跳转到项目列表...</div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => fetchProject()}>
            重试
          </Button>
        )}
      </div>
    );
  }

  if (!project) {
    return <div>项目不存在</div>;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div className="text-lg font-semibold">{project.name}</div>
        <div className="text-xs text-slate-500">
          编号 {project.code || "-"} | 客户 {project.clientName || "-"} | 状态 {PROJECT_STATUS_LABEL[project.status]}
        </div>
      </div>

      {activeGroup === "project" && <ProjectInfoTab projectId={projectId} onRefresh={fetchProject} />}
      {activeGroup === "performance" && <ProjectEarnedValuePanel projectId={projectId} projectStatus={project.status} />}
      {activeGroup === "gantt" && <ProjectGanttPanel projectId={projectId} projectStatus={project.status} />}
      {activeGroup === "documents" && (
        <ProjectDocumentListPanel projectId={projectId} projectStatus={project.status} />
      )}
      {activeGroup === "budget" && <ProjectBudgetPanel projectId={projectId} projectStatus={project.status} projectAmountWan={project.amountWan} />}
    </div>
  );
};

const ProjectInfoTab = ({ projectId, onRefresh }: { projectId: string; onRefresh: () => void }) => {
  const [project, setProject] = useState<Project | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const confirm = useConfirm();
  const { can, canAny } = usePermission();
  const [editOpen, setEditOpen] = useState(false);
  const [memberDialogOpen, setMemberDialogOpen] = useState(false);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [clientName, setClientName] = useState("");
  const [amount, setAmount] = useState(0);
  const [startDate, setStartDate] = useState("");

  const fetchProject = useCallback(async () => {
    try {
      const data = await api.get<Project & { projectMembers: ProjectMember[] }>(
        `/api/projects/${projectId}`
      );
      setProject(data);
      setMembers(data.projectMembers || []);
      setName(data.name);
      setCode(data.code);
      setClientName(data.clientName);
      setAmount(data.amountWan);
      setStartDate(data.startDate);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  if (loading || !project) {
    return <div className="text-sm text-slate-500">加载中...</div>;
  }

  const canEdit = can("project-info:edit");
  const canManageStatus = canAny(["project-info:start", "project-info:complete", "project-info:void", "project-info:restore"]);
  const canManageMembers = can("project-members:create") && can("project-members:delete");

  const handleUpdate = async () => {
    try {
      await api.put(`/api/projects/${projectId}`, {
        name,
        code,
        clientName,
        amountWan: amount,
        startDate,
      });
      setEditOpen(false);
      await fetchProject();
      onRefresh();
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存失败");
    }
  };

  const handleStatusAction = async (action: "start" | "complete" | "void" | "restore") => {
    const confirmMessages: Record<string, string> = {
      start: `确认启动项目「${project.name}」？`,
      complete: `确认标记项目「${project.name}」为已完成？`,
      void: `确认作废项目「${project.name}」？`,
      restore: `确认恢复项目「${project.name}」为进行中？`,
    };
    if (!(await confirm(confirmMessages[action]))) return;

    const statusMap: Record<string, ProjectStatus> = {
      start: ProjectStatus.IN_PROGRESS,
      complete: ProjectStatus.COMPLETED,
      void: ProjectStatus.VOIDED,
      restore: ProjectStatus.IN_PROGRESS,
    };

    try {
      await api.put(`/api/projects/${projectId}`, { status: statusMap[action] });
      await fetchProject();
      onRefresh();
    } catch (error) {
      alert(error instanceof Error ? error.message : "操作失败");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">项目信息</CardTitle>
            {canEdit && project.status !== ProjectStatus.COMPLETED && project.status !== ProjectStatus.VOIDED && (
              <div className="flex gap-2">
                {editOpen ? (
                  <>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditOpen(false)}>
                      取消
                    </Button>
                    <Button size="sm" className="h-7 text-xs" onClick={handleUpdate}>
                      保存
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditOpen(true)}>
                    编辑
                  </Button>
                )}
              </div>
            )}
          </div>
          <CardDescription className="text-xs">项目基础信息及生命周期状态管理</CardDescription>
        </CardHeader>
        <CardContent>
          {editOpen ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <InlineEditField label="项目名称" required>
                <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" required />
              </InlineEditField>
              <InlineEditField label="项目编号">
                <Input value={code} onChange={(e) => setCode(e.target.value)} className="h-8 text-xs" />
              </InlineEditField>
              <InlineEditField label="甲方单位">
                <Input value={clientName} onChange={(e) => setClientName(e.target.value)} className="h-8 text-xs" />
              </InlineEditField>
              <InlineEditField label="合同金额(万元)">
                <Input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="h-8 text-xs" />
              </InlineEditField>
              <InlineEditField label="开始时间" required>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-8 text-xs" required />
              </InlineEditField>
              <InlineEditField label="预计结项">
                <span className="text-muted-foreground">-</span>
              </InlineEditField>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground min-w-[100px]">状态：</span>
                <Badge>{PROJECT_STATUS_LABEL[project.status]}</Badge>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <FieldRow label="项目名称" value={project.name} />
              <FieldRow label="项目编号" value={project.code || "-"} />
              <FieldRow label="甲方单位" value={project.clientName || "-"} />
              <FieldRow label="合同金额(万元)" value={String(project.amountWan)} />
              <FieldRow label="开始时间" value={project.startDate || "-"} />
              <FieldRow label="预计结项" value={project.expectedEndDate || "-"} />
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">状态：</span>
                <Badge>{PROJECT_STATUS_LABEL[project.status]}</Badge>
              </div>
            </div>
          )}

          {canManageStatus && (
            <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
              {project.status === ProjectStatus.DRAFT && (
                <Button size="sm" className="h-7 text-xs" onClick={() => handleStatusAction("start")}>
                  启动
                </Button>
              )}
              {project.status === ProjectStatus.IN_PROGRESS && (
                <>
                  <Button size="sm" className="h-7 text-xs" onClick={() => handleStatusAction("complete")}>
                    完成
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs text-destructive" onClick={() => handleStatusAction("void")}>
                    作废
                  </Button>
                </>
              )}
              {(project.status === ProjectStatus.COMPLETED || project.status === ProjectStatus.VOIDED) && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => handleStatusAction("restore")}>
                  恢复
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">项目组成员</CardTitle>
            {canManageMembers && project.status !== ProjectStatus.COMPLETED && project.status !== ProjectStatus.VOIDED && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setMemberDialogOpen(true)}>
                添加成员
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>角色</TableHead>
                <TableHead>人员</TableHead>
                <TableHead className="w-[100px]">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>{m.roleName}</TableCell>
                  <TableCell className="font-medium">{m.personName}</TableCell>
                  <TableCell>
                    {can("project-members:delete") && project.status !== ProjectStatus.COMPLETED && project.status !== ProjectStatus.VOIDED && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive"
                        onClick={async () => {
                          if (!(await confirm(`确认移除成员「${m.personName}」（${m.roleName}）？`))) return;
                          try {
                            await api.delete(`/api/projects/${projectId}/members/${m.id}`);
                            await fetchProject();
                          } catch (err) {
                            alert(err instanceof Error ? err.message : "移除失败");
                          }
                        }}
                      >
                        移除
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {members.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center text-xs text-muted-foreground">
                    暂无项目组成员
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {memberDialogOpen && (
        <AddMemberDialog
          projectId={projectId}
          onClose={() => setMemberDialogOpen(false)}
          onSuccess={async () => {
            setMemberDialogOpen(false);
            await fetchProject();
          }}
        />
      )}
    </div>
  );
};

const FieldRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground min-w-[100px]">{label}：</span>
    <span className="font-medium">{value}</span>
  </div>
);

const InlineEditField = ({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) => (
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground min-w-[100px]">
      {label}
      {required && <span className="text-destructive ml-0.5">*</span>}
      ：
    </span>
    <div className="flex-1">{children}</div>
  </div>
);

const FormField = ({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) => (
  <div className="space-y-1">
    <label className="text-[11px] font-medium text-muted-foreground">
      {label}
      {required && <span className="text-destructive ml-0.5">*</span>}
    </label>
    {children}
  </div>
);

const AddMemberDialog = ({
  projectId,
  onClose,
  onSuccess,
}: {
  projectId: string;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) => {
  const [roleName, setRoleName] = useState("");
  const [personName, setPersonName] = useState("");
  const [roles, setRoles] = useState<{ id: string; roleName: string }[]>([]);
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<{ id: string; roleName: string }[]>("/api/role-config"),
      api.get<AccountItem[]>("/api/accounts"),
    ])
      .then(([roleData, accountData]) => {
        setRoles(roleData.map((role) => ({ id: role.id, roleName: role.roleName })));
        setAccounts(accountData);
        if (roleData.length > 0) setRoleName(roleData[0].roleName);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const candidates = useMemo(() => {
    const seen = new Set<string>();
    return accounts
      .filter((account) => account.enabled && account.assignedRoleNames.includes(roleName))
      .filter((account) => {
        if (seen.has(account.displayName)) return false;
        seen.add(account.displayName);
        return true;
      });
  }, [accounts, roleName]);

  useEffect(() => {
    if (!personName) return;
    if (!candidates.some((account) => account.displayName === personName)) {
      setPersonName("");
    }
  }, [candidates, personName]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleName || !personName) {
      alert("请选择角色和人员");
      return;
    }
    setSubmitting(true);
    try {
      const account = candidates.find((candidate) => candidate.displayName === personName);
      await api.post(`/api/projects/${projectId}/members`, {
        roleName,
        personName,
        accountId: account?.id,
      });
      await onSuccess();
    } catch (err) {
      alert(err instanceof Error ? err.message : "添加失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">添加项目成员</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="py-6 text-center text-xs text-muted-foreground">加载中...</div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <FormField label="角色" required>
                <select
                  value={roleName}
                  onChange={(e) => {
                    setRoleName(e.target.value);
                    setPersonName("");
                  }}
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  {roles.map((r) => (
                    <option key={r.id} value={r.roleName}>{r.roleName}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="人员" required>
                {candidates.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                    该角色暂无可用账号，请在「后台账号管理」中新增账号或为账号分配该项目角色。
                  </div>
                ) : (
                  <select
                    value={personName}
                    onChange={(e) => setPersonName(e.target.value)}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    required
                  >
                    <option value="">请选择人员</option>
                    {candidates.map((account) => (
                      <option key={account.id} value={account.displayName}>
                        {account.displayName}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={onClose}>
                  取消
                </Button>
                <Button type="submit" size="sm" className="h-7 text-xs" disabled={submitting}>
                  {submitting ? "保存中..." : "保存"}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
