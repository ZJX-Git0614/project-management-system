"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, BellRing, CheckCircle2, ClipboardList, ListTodo } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api-client";
import { TODO_CHANGED_EVENT } from "@/lib/todo-events";

interface TodoData {
  projectTodos: Array<{
    id: string;
    createdAt: string;
    title: string;
    detail: string;
    type: string;
    project: { id: string; name: string; code: string };
  }>;
  notifications: Array<{
    id: string;
    createdAt: string;
    category: string;
    title: string;
    detail: string;
    severity: "ERROR" | "WARNING";
  }>;
}

const formatDateTime = (value: string) => new Date(value).toLocaleString("zh-CN");

export default function TodosPage() {
  const [data, setData] = useState<TodoData | null>(null);
  const [error, setError] = useState("");
  const [markingRead, setMarkingRead] = useState(false);

  useEffect(() => {
    api.get<TodoData>("/api/todos")
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "待办加载失败"));
  }, []);

  const markNotificationsRead = async () => {
    setMarkingRead(true);
    try {
      await api.put("/api/todos/notifications/read", {});
      setData((current) => current ? { ...current, notifications: [] } : current);
      window.dispatchEvent(new Event(TODO_CHANGED_EVENT));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "通知已读失败");
    } finally {
      setMarkingRead(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><ClipboardList className="size-4 text-primary" />待办中心</CardTitle>
          <CardDescription className="text-xs">集中查看项目待办与系统通知。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <div className="rounded-md border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs text-destructive">{error}</div>}

          <div className="grid items-start gap-4 md:grid-cols-2">
            <section id="notifications" className="scroll-mt-16 space-y-2">
              <div className="flex min-h-7 items-center justify-between gap-2">
                <h2 className="flex items-center gap-1.5 text-xs font-semibold"><BellRing className="size-3.5 text-primary" />通知</h2>
                {(data?.notifications.length ?? 0) > 0 && (
                  <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={markingRead} onClick={() => void markNotificationsRead()}>
                    <CheckCircle2 className="size-3.5" /> {markingRead ? "处理中..." : "全部已读"}
                  </Button>
                )}
              </div>
              <div className="overflow-hidden rounded-md border border-border">
                {data?.notifications.map((notification) => (
                  <div key={notification.id} className="grid gap-2 border-b border-border px-3 py-3 text-xs last:border-b-0 sm:grid-cols-[145px_minmax(0,1fr)]">
                    <div className={notification.severity === "ERROR" ? "flex items-center gap-2 text-destructive" : "flex items-center gap-2 text-amber-500"}>
                      <AlertTriangle className="size-4 shrink-0" />{formatDateTime(notification.createdAt)}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-foreground">{notification.title}</div>
                      <Badge variant="secondary" className="mt-1 w-fit text-[10px]">{notification.category}</Badge>
                    </div>
                    <div className="select-text break-words text-muted-foreground sm:col-span-2">{notification.detail}</div>
                  </div>
                ))}
                {data && data.notifications.length === 0 && (
                  <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground"><CheckCircle2 className="size-4 text-emerald-500" />暂无未读通知</div>
                )}
                {!data && !error && <div className="px-3 py-8 text-center text-xs text-muted-foreground">正在加载...</div>}
              </div>
            </section>

            <section className="space-y-2">
              <h2 className="flex min-h-7 items-center gap-1.5 text-xs font-semibold"><ListTodo className="size-3.5 text-primary" />项目待办</h2>
              <div className="overflow-hidden rounded-md border border-border">
                {data?.projectTodos.map((todo) => (
                  <div key={todo.id} className="grid gap-1.5 border-b border-border px-3 py-3 text-xs last:border-b-0 sm:grid-cols-[minmax(0,1fr)_135px]">
                    <div className="font-medium">{todo.title}</div>
                    <div className="text-muted-foreground sm:text-right">{todo.project.code} · {todo.project.name}</div>
                    <div className="break-words text-muted-foreground sm:col-span-2">{todo.detail || "-"}</div>
                  </div>
                ))}
                {data && data.projectTodos.length === 0 && <div className="px-3 py-8 text-center text-xs text-muted-foreground">暂无项目待办</div>}
                {!data && !error && <div className="px-3 py-8 text-center text-xs text-muted-foreground">正在加载...</div>}
              </div>
            </section>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
