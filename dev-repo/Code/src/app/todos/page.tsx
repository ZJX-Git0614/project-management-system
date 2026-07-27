"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ClipboardList, DatabaseBackup } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api-client";

interface TodoData {
  projectTodos: Array<{
    id: string;
    createdAt: string;
    title: string;
    detail: string;
    type: string;
    project: { id: string; name: string; code: string };
  }>;
  backupAlerts: Array<{
    id: string;
    createdAt: string;
    triggerMode: string;
    status: string;
    cloudStatus: string;
    errorMessage: string;
  }>;
}

const formatDateTime = (value: string) => new Date(value).toLocaleString("zh-CN");

export default function TodosPage() {
  const [data, setData] = useState<TodoData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<TodoData>("/api/todos")
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "待办加载失败"));
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><ClipboardList className="size-4 text-primary" />待办中心</CardTitle>
          <CardDescription className="text-xs">集中查看项目待办与系统备份告警。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {error && <div className="rounded-md border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</div>}

          <section className="space-y-2">
            <h2 className="text-xs font-semibold">备份告警</h2>
            <div className="overflow-hidden rounded-md border border-border">
              {data?.backupAlerts.map((alert) => (
                <div key={alert.id} className="grid gap-2 border-b border-border px-3 py-3 text-xs last:border-b-0 md:grid-cols-[160px_110px_minmax(0,1fr)]">
                  <div className="flex items-center gap-2 text-destructive"><AlertTriangle className="size-4 shrink-0" />{formatDateTime(alert.createdAt)}</div>
                  <Badge variant={alert.status === "FAILED" ? "destructive" : "warning"} className="w-fit">
                    {alert.status === "FAILED" ? "备份失败" : "云盘备份失败"}
                  </Badge>
                  <div className="select-text break-words text-muted-foreground">{alert.errorMessage || "备份未完整完成，请在系统数据管理中检查记录。"}</div>
                </div>
              ))}
              {data && data.backupAlerts.length === 0 && (
                <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground"><CheckCircle2 className="size-4 text-emerald-500" />暂无备份告警</div>
              )}
              {!data && !error && <div className="px-3 py-8 text-center text-xs text-muted-foreground">正在加载...</div>}
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold">项目待办</h2>
            <div className="overflow-hidden rounded-md border border-border">
              {data?.projectTodos.map((todo) => (
                <div key={todo.id} className="grid gap-2 border-b border-border px-3 py-3 text-xs last:border-b-0 md:grid-cols-[190px_minmax(0,1fr)_150px]">
                  <div className="flex items-center gap-2 font-medium"><DatabaseBackup className="size-4 shrink-0 text-primary" />{todo.title}</div>
                  <div className="text-muted-foreground">{todo.detail || "-"}</div>
                  <div className="text-muted-foreground">{todo.project.code} · {todo.project.name}</div>
                </div>
              ))}
              {data && data.projectTodos.length === 0 && <div className="px-3 py-8 text-center text-xs text-muted-foreground">暂无项目待办</div>}
            </div>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
