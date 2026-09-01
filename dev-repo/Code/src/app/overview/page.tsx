"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GanttTimeline } from "@/components/gantt-timeline";
import { api } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import type { ProjectGanttTask } from "@/domain/models";

interface OverviewData {
  ganttTasks: ProjectGanttTask[];
}

export default function OverviewPage() {
  const { can } = usePermission();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<OverviewData>("/api/overview")
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  if (!can("project-gantt:view")) {
    return (
      <Card className="border-warning/30 bg-warning/5">
        <CardContent className="py-4 text-sm">当前角色无权查看项目 WBS 管理。</CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">加载中...</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">项目 WBS 总览</CardTitle>
        <p className="text-xs text-muted-foreground">
          汇总展示所有项目的甘特任务；项目维护和切换请回到项目列表进入对应项目。
        </p>
      </CardHeader>
      <CardContent>
        <GanttTimeline tasks={data?.ganttTasks ?? []} showProject emptyText="暂无项目甘特任务" />
      </CardContent>
    </Card>
  );
}
