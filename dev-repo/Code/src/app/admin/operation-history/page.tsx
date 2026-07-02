"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { formatDateTime } from "@/lib/utils";
import { formatEntityType, formatActionType } from "@/lib/operation-history";

interface ProjectItem {
  id: string;
  name: string;
}

interface OperationHistory {
  id: string;
  projectId: string;
  entityType: string;
  actionType: string;
  operator: string;
  detail: string;
  createdAt: string;
}

export default function OperationHistoryPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">加载中...</div>}>
      <OperationHistoryContent />
    </Suspense>
  );
}

function OperationHistoryContent() {
  const { can } = usePermission();
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [histories, setHistories] = useState<OperationHistory[]>([]);
  const [searchTerm, setSearchTerm] = useState("");

  const canViewPage = can("account-management:view"); // reuse admin permission

  const fetchData = useCallback(async () => {
    try {
      const projList = await api.get<ProjectItem[]>("/api/projects");
      setProjects(projList);

      const historyResults = await Promise.all(
        projList.map((project) =>
          api
            .get<OperationHistory[]>(
              `/api/projects/${project.id}/operation-history`
            )
            .catch(() => [] as OperationHistory[])
        )
      );
      setHistories(historyResults.flat());
    } catch {
      // handled by api-client
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!canViewPage) {
      setLoading(false);
      return;
    }
    fetchData();
  }, [canViewPage, fetchData]);

  const getProjectName = useCallback(
    (projectId: string) =>
      projects.find((p) => p.id === projectId)?.name ?? projectId,
    [projects]
  );

  const filtered = searchTerm
    ? histories.filter(
        (h) =>
          getProjectName(h.projectId).includes(searchTerm) ||
          formatEntityType(h.entityType).includes(searchTerm) ||
          formatActionType(h.actionType).includes(searchTerm) ||
          h.operator.includes(searchTerm) ||
          h.detail.includes(searchTerm)
      )
    : histories;

  const sorted = [...filtered].sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  if (!canViewPage) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          暂无权限查看操作历史
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          加载中...
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">关键流程操作历史</CardTitle>
            <Input
              placeholder="搜索项目/实体/动作/操作人/明细..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-8 w-64 text-xs"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>项目</TableHead>
                <TableHead>实体</TableHead>
                <TableHead>动作</TableHead>
                <TableHead>操作人</TableHead>
                <TableHead>明细</TableHead>
                <TableHead>时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((history) => (
                <TableRow key={history.id}>
                  <TableCell>{getProjectName(history.projectId)}</TableCell>
                  <TableCell>
                    {formatEntityType(history.entityType)}
                  </TableCell>
                  <TableCell>
                    {formatActionType(history.actionType)}
                  </TableCell>
                  <TableCell>{history.operator}</TableCell>
                  <TableCell>{history.detail}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatDateTime(history.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
              {sorted.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-8 text-center text-xs text-muted-foreground"
                  >
                    暂无操作历史记录
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
