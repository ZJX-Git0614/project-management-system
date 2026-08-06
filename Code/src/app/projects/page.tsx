"use client";

import Link from "next/link";
import { useState, useMemo, useEffect, useCallback } from "react";
import { Plus, Search, Upload } from "lucide-react";
import { useConfirm } from "@/components/confirm-provider";
import { CreateProjectDialog } from "@/components/create-project-dialog";
import { ProjectStatus } from "@/domain/enums";
import { PROJECT_STATUS_LABEL } from "@/lib/constants";
import { downloadTextFile, toCsv } from "@/lib/utils";
import { usePermission } from "@/lib/use-permission";
import { useProjectFilter } from "@/state/project-filter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api-client";
import { useCurrentProject } from "@/contexts/current-project-context";

const STATUS_BADGE_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "destructive"> = {
  [ProjectStatus.DRAFT]: "secondary",
  [ProjectStatus.IN_PROGRESS]: "success",
  [ProjectStatus.COMPLETED]: "default",
  [ProjectStatus.VOIDED]: "destructive",
};

interface ProjectListItem {
  id: string;
  name: string;
  code: string;
  clientName: string;
  amountWan: number;
  deviceCount: number;
  repairCycleDays: number;
  startDate: string;
  expectedEndDate: string;
  status: string;
  createdAt: string;
}

interface RoleConfigItem {
  id: string;
  roleName: string;
  allowMultiple: boolean;
  systemPreset: boolean;
  persons: string[];
}

export default function ProjectsPage() {
  const { can, canAny } = usePermission();
  const confirm = useConfirm();
  const { setCurrentProject } = useCurrentProject();
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [roleConfigs, setRoleConfigs] = useState<RoleConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<"ALL" | ProjectStatus>("ALL");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const canViewList = can("project-list:view");
  const canCreate = can("project-list:create");
  const canManageStatus = canAny(["project-list:start", "project-list:complete", "project-list:void", "project-list:restore"]);
  const canExport = can("project-list:export");

  const fetchData = useCallback(async () => {
    try {
      const [projList, roles] = await Promise.all([
        api.get<ProjectListItem[]>("/api/projects"),
        api.get<RoleConfigItem[]>("/api/role-config"),
      ]);
      setProjects(projList);
      setRoleConfigs(roles as RoleConfigItem[]);
    } catch {
      // error handled by api-client (redirect to login on 401)
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canViewList) {
      setLoading(false);
      return;
    }
    fetchData();
  }, [canViewList, fetchData]);

  const filtered = useProjectFilter(
    projects as unknown as Parameters<typeof useProjectFilter>[0],
    keyword,
    status,
  );

  const sorted = useMemo(
    () => [...filtered].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [filtered],
  );

  const handleCreate = async (data: {
    name: string;
    code: string;
    clientName: string;
    amountWan: number;
    deviceCount: number;
    repairCycleDays: number;
    startDate: string;
    initialMember?: { roleName: string; personName: string };
  }) => {
    try {
      await api.post("/api/projects", data);
      setShowCreateDialog(false);
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "创建失败");
    }
  };

  const exportProjects = () => {
    const csv = toCsv(
      ["项目名称", "项目编号", "甲方单位", "合同金额(万元)", "设备数量", "维修周期(天)", "开始时间", "预计结项时间", "状态"],
      sorted.map((item) => [
        item.name,
        item.code,
        item.clientName,
        item.amountWan,
        item.deviceCount,
        item.repairCycleDays,
        item.startDate,
        item.expectedEndDate,
        PROJECT_STATUS_LABEL[item.status as ProjectStatus] || item.status,
      ]),
    );
    downloadTextFile(`Ceastar项目管理系统_项目列表_${Date.now()}.csv`, csv);
  };

  const handleStatusAction = async (projectId: string, action: "start" | "complete" | "void" | "restore", projectName: string) => {
    const confirmMessages: Record<string, string> = {
      start: `确认启动项目「${projectName}」？`,
      complete: `确认标记项目「${projectName}」为已完成？`,
      void: `确认作废项目「${projectName}」？`,
      restore: `确认恢复项目「${projectName}」为进行中？`,
    };
    if (!(await confirm(confirmMessages[action]))) return;

    const statusMap: Record<string, string> = {
      start: ProjectStatus.IN_PROGRESS,
      complete: ProjectStatus.COMPLETED,
      void: ProjectStatus.VOIDED,
      restore: ProjectStatus.IN_PROGRESS,
    };

    try {
      const result = await api.put<{ approvalRequired?: boolean }>(`/api/projects/${projectId}`, { status: statusMap[action] });
      if (result.approvalRequired) alert("项目状态变更审批已发起，可在审批中心查看进度。");
      await fetchData();
    } catch (error) {
      alert(error instanceof Error ? error.message : "操作失败");
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          加载中...
        </CardContent>
      </Card>
    );
  }

  if (!canViewList) {
    return (
      <Card className="border-warning/30 bg-warning/5">
        <CardContent className="py-4">
          <p className="text-sm text-warning-foreground">当前角色无权查看项目列表。</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-3">
          <div className="flex-1 min-w-[160px]">
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
              <Search className="mr-1 inline size-3" />
              项目名称搜索
            </label>
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="请输入关键词"
              className="h-8 text-xs"
            />
          </div>
          <div className="w-[140px]">
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">状态筛选</label>
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as "ALL" | ProjectStatus)}
              className="h-8 text-xs"
            >
              <option value="ALL">全部</option>
              {Object.values(ProjectStatus).map((item) => (
                <option key={item} value={item}>
                  {PROJECT_STATUS_LABEL[item]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={exportProjects}
              disabled={!canExport}
            >
              <Upload className="size-3" />
              导出项目列表
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => setShowCreateDialog(true)}
              disabled={!canCreate}
            >
              <Plus className="size-3" />
              创建项目
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Table Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">项目列表</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>项目名称</TableHead>
                <TableHead>项目编号</TableHead>
                <TableHead>甲方单位</TableHead>
                <TableHead>合同金额(万元)</TableHead>
                <TableHead>设备数量</TableHead>
                <TableHead>周期(天)</TableHead>
                <TableHead>开始时间</TableHead>
                <TableHead>预计结项</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((project) => (
                <TableRow key={project.id}>
                  <TableCell className="font-medium">
                    {/* 项目列表是唯一项目入口：点击项目名写入当前项目并进入项目详情。 */}
                    <Link
                      href={`/projects/${project.id}?nav=project`}
                      className="text-primary hover:underline underline-offset-2"
                      onClick={() => {
                        setCurrentProject(project.id);
                      }}
                    >
                      {project.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{project.code}</TableCell>
                  <TableCell>{project.clientName}</TableCell>
                  <TableCell>{project.amountWan}</TableCell>
                  <TableCell>{project.deviceCount}</TableCell>
                  <TableCell>{project.repairCycleDays}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{project.startDate}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{project.expectedEndDate}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE_VARIANT[project.status] ?? "secondary"}>
                      {PROJECT_STATUS_LABEL[project.status as ProjectStatus] || project.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      {/* V0.6.1：取消「查看详情」按钮，由顶栏「当前项目」入口统一承担切换职责
                          ——状态操作按钮（启动/完成/作废/恢复）保留 */}
                      {canManageStatus && project.status === ProjectStatus.DRAFT && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleStatusAction(project.id, "start", project.name)}
                        >
                          启动
                        </Button>
                      )}
                      {canManageStatus && project.status === ProjectStatus.IN_PROGRESS && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => handleStatusAction(project.id, "complete", project.name)}
                          >
                            完成
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-destructive"
                            onClick={() => handleStatusAction(project.id, "void", project.name)}
                          >
                            作废
                          </Button>
                        </>
                      )}
                      {canManageStatus && (project.status === ProjectStatus.COMPLETED || project.status === ProjectStatus.VOIDED) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handleStatusAction(project.id, "restore", project.name)}
                        >
                          恢复
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {sorted.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="h-32 text-center">
                    {projects.length === 0 ? (
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-muted-foreground">暂无项目</p>
                        <p className="text-xs text-muted-foreground/60">
                          {canCreate
                            ? "点击右上角「创建项目」开始使用Ceastar项目管理系统。"
                            : "请联系管理员或项目经理创建项目。"}
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">无匹配项目</p>
                    )}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <CreateProjectDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onSubmit={handleCreate}
        disabled={!canCreate}
        roleConfigs={roleConfigs}
      />
    </div>
  );
}
