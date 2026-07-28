"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Briefcase, CircleDashed } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { useCurrentProject } from "@/contexts/current-project-context";
import { ProjectStatus } from "@/domain/enums";

const STATUS_META: Record<
  ProjectStatus,
  { label: string; variant: "secondary" | "success" | "default" | "destructive" }
> = {
  [ProjectStatus.DRAFT]: { label: "草稿", variant: "secondary" },
  [ProjectStatus.IN_PROGRESS]: { label: "进行中", variant: "success" },
  [ProjectStatus.COMPLETED]: { label: "已完成", variant: "default" },
  [ProjectStatus.VOIDED]: { label: "已作废", variant: "destructive" },
};

export const CurrentProjectSwitcher = () => {
  const { allVisibleProjects, currentProject, loading } = useCurrentProject();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const hasAnyVisible = allVisibleProjects.length > 0;

  // SSR 和未挂载时统一渲染加载状态，避免水合不匹配
  if (!mounted || loading) {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-border/80 bg-secondary/50 px-2.5 h-8 text-[11px] text-muted-foreground">
        <Briefcase className="size-3.5 text-muted-foreground/60" />
        <span>{mounted ? "加载中…" : "当前项目"}</span>
      </div>
    );
  }

  // 无任何可见项目
  if (!hasAnyVisible) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-md border border-dashed border-warning/40 bg-warning/5 px-2.5 h-8 text-[11px] text-warning"
        title="无进行中项目，请联系项目经理启动项目！"
      >
        <CircleDashed className="size-3.5" />
        <span className="truncate max-w-[260px]">无进行中项目，请联系项目经理启动项目！</span>
      </div>
    );
  }

  const currentMeta = currentProject
    ? STATUS_META[currentProject.status as ProjectStatus] ?? STATUS_META[ProjectStatus.DRAFT]
    : null;

  return (
    <div
      className="flex h-8 max-w-[360px] items-center gap-1.5 rounded-md border border-border/80 bg-secondary/40 px-2.5 text-xs"
      data-testid="current-project-switcher"
    >
      <Briefcase className="size-3.5 shrink-0 text-primary/70" />
      <span className="shrink-0 text-muted-foreground">当前项目</span>
      <span className="truncate font-medium">{currentProject?.name ?? "未选择"}</span>
      {currentMeta && (
        <Badge variant={currentMeta.variant} className="ml-0.5 h-4 shrink-0 px-1.5 py-0 text-[10px]">
          {currentMeta.label}
        </Badge>
      )}
      <Link href="/projects" className="ml-1 shrink-0 text-[11px] text-primary hover:underline">
        去项目列表
      </Link>
    </div>
  );
};
