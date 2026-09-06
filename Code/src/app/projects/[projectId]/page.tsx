"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { ProjectStatus } from "@/domain/enums";
import { PROJECT_STATUS_LABEL } from "@/lib/constants";
import { resolveDetailGroup } from "@/lib/navigation";
import { useCurrentProject } from "@/contexts/current-project-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
import { ModalDialog } from "@/components/modal-dialog";
import { usePermission } from "@/lib/use-permission";
import { api } from "@/lib/api-client";
import { ProjectGanttPanel } from "@/components/project-gantt-panel";
import { ProjectBudgetPanel } from "@/components/project-budget-panel";
import { ProjectDocumentListPanel } from "@/components/project-document-list-panel";
import { ProjectEarnedValuePanel } from "@/components/project-earned-value-panel";
import { ProjectExecutionPanel } from "@/components/project-execution-panel";
import { ProjectDeliverableListPanel, ProjectDeliveryStatusPanel, ProjectProcurementPanel } from "@/components/project-delivery-procurement-panels";

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
  ganttTasks?: Array<{ id: string; finishDate?: string }>;
}

interface ProjectMember {
  id: string;
  projectId: string;
  accountId?: string | null;
  roleName: string;
  roleNames?: string[];
  personName: string;
  createdAt: string;
}

interface AccountItem {
  id: string;
  displayName: string;
  enabled: boolean;
  assignedRoleNames: string[];
}

interface MemberRemovalImpact {
  member: Pick<ProjectMember, "id" | "accountId" | "personName" | "roleName">;
  replacementCandidates: Array<Pick<ProjectMember, "id" | "accountId" | "personName" | "roleName">>;
  defaultReplacementMemberId: string | null;
  tasks: Array<{ id: string; taskCode: string; taskName: string }>;
  weeklyItems: Array<{ id: string; matterCode: string; title: string }>;
  risks: Array<{ id: string; riskCode: string; riskName: string }>;
  totalAssignments: number;
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
      {activeGroup === "execution" && <ProjectExecutionPanel projectId={projectId} projectStatus={project.status} />}
      {activeGroup === "documents" && (
        <ProjectDocumentListPanel projectId={projectId} projectStatus={project.status} />
      )}
      {activeGroup === "deliverables" && <ProjectDeliverableListPanel projectId={projectId} />}
      {activeGroup === "delivery-status" && <ProjectDeliveryStatusPanel projectId={projectId} />}
      {activeGroup === "procurement" && <ProjectProcurementPanel projectId={projectId} />}
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
  const [memberRemovalImpact, setMemberRemovalImpact] = useState<MemberRemovalImpact | null>(null);
  const [memberRemovalLoadingId, setMemberRemovalLoadingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [clientName, setClientName] = useState("");
  const [amount, setAmount] = useState(0);
  const [startDate, setStartDate] = useState("");
  const [expectedEndDate, setExpectedEndDate] = useState("");

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
      setExpectedEndDate(data.expectedEndDate);
    } catch {
      // handled
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchProject();
  }, [fetchProject]);

  useEffect(() => {
    const refreshMembers = () => { void fetchProject(); };
    window.addEventListener("focus", refreshMembers);
    return () => window.removeEventListener("focus", refreshMembers);
  }, [fetchProject]);

  if (loading || !project) {
    return <div className="text-sm text-slate-500">加载中...</div>;
  }

  const canEdit = can("project-info:edit");
  const canManageStatus = canAny(["project-info:start", "project-info:complete", "project-info:void", "project-info:restore"]);
  const canManageMembers = can("project-members:create") && can("project-members:delete");
  const latestWbsFinishDate = (project.ganttTasks ?? []).reduce(
    (latest, task) => task.finishDate && task.finishDate > latest ? task.finishDate : latest,
    "",
  );
  const wbsExceedsExpectedEnd = Boolean(
    project.expectedEndDate && latestWbsFinishDate && latestWbsFinishDate > project.expectedEndDate,
  );

  const handleUpdate = async () => {
    if (startDate && expectedEndDate && expectedEndDate < startDate) {
      alert("预计结项时间不能早于项目 T0");
      return;
    }
    try {
      await api.put(`/api/projects/${projectId}`, {
        name,
        code,
        clientName,
        amountWan: amount,
        startDate,
        expectedEndDate,
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
      const result = await api.put<{ approvalRequired?: boolean }>(`/api/projects/${projectId}`, { status: statusMap[action] });
      if (result.approvalRequired) alert("项目状态变更审批已发起，可在审批中心查看进度。");
      await fetchProject();
      onRefresh();
    } catch (error) {
      alert(error instanceof Error ? error.message : "操作失败");
    }
  };

  const openMemberRemoval = async (member: ProjectMember) => {
    setMemberRemovalLoadingId(member.id);
    try {
      const impact = await api.get<MemberRemovalImpact>(`/api/projects/${projectId}/members/${member.id}`);
      setMemberRemovalImpact(impact);
    } catch (error) {
      alert(error instanceof Error ? error.message : "读取成员负责事项失败");
    } finally {
      setMemberRemovalLoadingId(null);
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
              <InlineEditField label="项目 T0">
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-8 text-xs" />
              </InlineEditField>
              <InlineEditField label="预计结项">
                <div>
                  <Input type="date" value={expectedEndDate} min={startDate || undefined} onChange={(e) => setExpectedEndDate(e.target.value)} className="h-8 text-xs" />
                  {latestWbsFinishDate && expectedEndDate && latestWbsFinishDate > expectedEndDate && (
                    <div className="mt-1 flex items-center gap-1 text-[11px] text-amber-500">
                      <AlertTriangle className="size-3" />WBS 计划最晚完成日为 {latestWbsFinishDate}
                    </div>
                  )}
                </div>
              </InlineEditField>
              <p className="col-span-full text-[11px] leading-4 text-muted-foreground">
                项目 T0 未确定时可留空。正式自动排期将显示为 T0、T0+N；后续填写项目 T0 后，系统会按项目日历换算为具体日期。
              </p>
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
              <FieldRow label="项目 T0" value={project.startDate || "未确定（使用相对排期）"} />
              <FieldRow
                label="预计结项"
                value={project.expectedEndDate || "-"}
                warning={wbsExceedsExpectedEnd ? `WBS 计划最晚完成日为 ${latestWbsFinishDate}，已晚于预计结项时间` : undefined}
              />
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
                  <TableCell>{m.roleNames?.join("、") || m.roleName}</TableCell>
                  <TableCell className="font-medium">{m.personName}</TableCell>
                  <TableCell>
                    {can("project-members:delete") && project.status !== ProjectStatus.COMPLETED && project.status !== ProjectStatus.VOIDED && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive"
                        disabled={memberRemovalLoadingId === m.id}
                        onClick={() => void openMemberRemoval(m)}
                      >
                        {memberRemovalLoadingId === m.id ? "检查中..." : "移除"}
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
          existingAccountIds={members.flatMap((member) => member.accountId ? [member.accountId] : [])}
          onClose={() => setMemberDialogOpen(false)}
          onSuccess={async () => {
            setMemberDialogOpen(false);
            await fetchProject();
          }}
        />
      )}
      {memberRemovalImpact && (
        <RemoveMemberDialog
          key={memberRemovalImpact.member.id}
          projectId={projectId}
          impact={memberRemovalImpact}
          onClose={() => setMemberRemovalImpact(null)}
          onSuccess={async () => {
            setMemberRemovalImpact(null);
            await fetchProject();
            onRefresh();
          }}
        />
      )}
    </div>
  );
};

const RemoveMemberDialog = ({
  projectId,
  impact,
  onClose,
  onSuccess,
}: {
  projectId: string;
  impact: MemberRemovalImpact;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) => {
  const [replacementMemberId, setReplacementMemberId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const needsAssignmentChoice = impact.totalAssignments > 0;
  const canSubmit = !needsAssignmentChoice || Boolean(replacementMemberId);

  const removeMember = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const replacement = replacementMemberId || "__UNASSIGNED__";
      const query = new URLSearchParams({
        confirmed: "true",
        replacementMemberId: replacement,
      });
      await api.delete(`/api/projects/${projectId}/members/${impact.member.id}?${query.toString()}`);
      await onSuccess();
    } catch (error) {
      alert(error instanceof Error ? error.message : "移除失败");
    } finally {
      setSubmitting(false);
    }
  };

  const responsibilityGroups = [
    {
      label: "WBS 任务",
      items: impact.tasks.map((task) => `${task.taskCode || "无编号"} · ${task.taskName || "未命名任务"}`),
    },
    {
      label: "项目事项",
      items: impact.weeklyItems.map((item) => `${item.matterCode || "无编号"} · ${item.title || "未命名事项"}`),
    },
    {
      label: "风险",
      items: impact.risks.map((risk) => `${risk.riskCode || "无编号"} · ${risk.riskName || "未命名风险"}`),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <ModalDialog
      open
      title="移除项目成员"
      onClose={submitting ? () => undefined : onClose}
      size="md"
      footer={
        <>
          <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={onClose}>取消</Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={!canSubmit || submitting}
            onClick={() => void removeMember()}
          >
            {submitting ? "交接中..." : "确认移除"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="flex items-start gap-3 rounded-md border border-amber-500/35 bg-amber-500/8 px-3 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-medium">将移除 {impact.member.personName}（{impact.member.roleName}）</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">
              {needsAssignmentChoice
                ? `当前发现 ${impact.totalAssignments} 项负责关系，删除前必须选择接替负责人或未分配。`
                : "未发现该成员的负责关系。"}
            </div>
          </div>
        </div>

        {responsibilityGroups.length > 0 && (
          <div className="max-h-64 space-y-3 overflow-auto border-y border-border py-3">
            {responsibilityGroups.map((group) => (
              <div key={group.label} className="grid gap-1.5 sm:grid-cols-[92px_1fr]">
                <div className="text-xs font-medium text-muted-foreground">{group.label}（{group.items.length}）</div>
                <div className="space-y-1">
                  {group.items.map((item) => (
                    <div key={item} className="truncate text-xs" title={item}>{item}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {needsAssignmentChoice && (
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">接替负责人</span>
            <Select
              value={replacementMemberId}
              onChange={(event) => setReplacementMemberId(event.target.value)}
              aria-label="接替负责人"
            >
              <option value="">请选择</option>
              <option value="__UNASSIGNED__">未分配</option>
              {impact.replacementCandidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.personName}（{candidate.roleName}）
                </option>
              ))}
            </Select>
          </label>
        )}
      </div>
    </ModalDialog>
  );
};

const FieldRow = ({ label, value, warning }: { label: string; value: string; warning?: string }) => (
  <div className="flex items-center gap-2">
    <span className="text-muted-foreground min-w-[100px]">{label}：</span>
    <span className="font-medium">{value}</span>
    {warning && (
      <span title={warning} aria-label={warning}>
        <AlertTriangle className="size-3.5 text-amber-500" />
      </span>
    )}
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
  existingAccountIds,
  onClose,
  onSuccess,
}: {
  projectId: string;
  existingAccountIds: string[];
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) => {
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<AccountItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<AccountItem[]>("/api/accounts")
      .then((accountData) => setAccounts(accountData))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const candidates = useMemo(() => {
    const existingIds = new Set(existingAccountIds);
    return accounts
      .filter((account) => account.enabled && account.assignedRoleNames.length > 0)
      .filter((account) => !existingIds.has(account.id));
  }, [accounts, existingAccountIds]);

  useEffect(() => {
    if (!accountId) return;
    if (!candidates.some((account) => account.id === accountId)) {
      setAccountId("");
    }
  }, [accountId, candidates]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountId) {
      alert("请选择人员");
      return;
    }
    setSubmitting(true);
    try {
      const account = candidates.find((candidate) => candidate.id === accountId);
      await api.post(`/api/projects/${projectId}/members`, {
        personName: account?.displayName,
        accountId,
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
              <FormField label="人员" required>
                {candidates.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                    暂无可添加账号。账号必须已启用、拥有至少一个有效角色，且不能在同一项目重复添加。
                  </div>
                ) : (
                  <select
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value)}
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    required
                  >
                    <option value="">请选择人员</option>
                    {candidates.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.displayName}（{account.assignedRoleNames.join("、")}）
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
