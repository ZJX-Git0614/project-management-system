"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCcw, Save, TrendingUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { GanttDateField } from "@/components/gantt-date-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableEmptyState, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProjectStatus } from "@/domain/enums";
import { api } from "@/lib/api-client";
import { calculateEarnedValue, type EarnedValueTaskInput, type EarnedValueTaskResult } from "@/lib/earned-value";
import { usePermission } from "@/lib/use-permission";
import { cn } from "@/lib/utils";

interface EarnedValueApiResponse {
  statusDate: string;
  rows: EarnedValueTaskResult[];
  budgetItems: Array<{ id: string; title: string; categoryName: string; kind: string; plannedCost: number; hourlyCost: number }>;
  budgetSummary: { projectBudget: number; linkedBudgetItems: number; blendedHourlyCost: number };
}

interface ProjectEarnedValuePanelProps {
  projectId: string;
  projectStatus: ProjectStatus;
}

type ForecastMode = "typical" | "atypical";

const currencyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

const money = (value: number | null) => value === null ? "--" : currencyFormatter.format(value);
const ratio = (value: number | null) => value === null ? "--" : numberFormatter.format(value);
const percent = (value: number | null) => value === null ? "--" : `${numberFormatter.format(value * 100)}%`;
const hours = (value: number | null) => value === null ? "--" : `${numberFormatter.format(value)} h`;
const transparentRowInputClass = cn(
  "h-7 w-full rounded px-2 text-right text-xs tabular-nums shadow-none transition-colors",
  "!border-transparent !bg-transparent !ring-0 !ring-offset-0",
  "hover:!border-border/50 hover:!bg-muted/10",
  "focus-visible:!border-primary/50 focus-visible:!bg-background focus-visible:!ring-1 focus-visible:!ring-primary/20",
  "disabled:cursor-default disabled:opacity-100",
);
const transparentRowSelectClass = cn(
  "h-7 w-full rounded px-2 text-xs shadow-none transition-colors",
  "!border-transparent !bg-transparent !ring-0 !ring-offset-0",
  "hover:!border-border/50 hover:!bg-muted/10",
  "focus-visible:!border-primary/50 focus-visible:!bg-background focus-visible:!ring-1 focus-visible:!ring-primary/20",
  "disabled:cursor-default disabled:opacity-100",
);
const tone = (value: number | null, inverse = false) => {
  if (value === null || Math.abs(value) < 1e-9) return "text-foreground";
  const favorable = inverse ? value < 0 : value > 0;
  return favorable ? "text-emerald-500" : "text-rose-500";
};

export const ProjectEarnedValuePanel = ({ projectId, projectStatus }: ProjectEarnedValuePanelProps) => {
  const [tasks, setTasks] = useState<EarnedValueTaskInput[]>([]);
  const [budgetItems, setBudgetItems] = useState<EarnedValueApiResponse["budgetItems"]>([]);
  const [budgetSummary, setBudgetSummary] = useState<EarnedValueApiResponse["budgetSummary"]>({ projectBudget: 0, linkedBudgetItems: 0, blendedHourlyCost: 0 });
  const [statusDate, setStatusDate] = useState(new Date().toISOString().slice(0, 10));
  const [forecastMode, setForecastMode] = useState<ForecastMode>("typical");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { can } = usePermission();
  const readOnly = projectStatus === ProjectStatus.COMPLETED || projectStatus === ProjectStatus.VOIDED;
  const canEdit = can("earned-value:edit") && !readOnly;

  const fetchData = useCallback(async (date = statusDate) => {
    setLoading(true);
    try {
      const response = await api.get<EarnedValueApiResponse>(
        `/api/projects/${projectId}/earned-value?statusDate=${encodeURIComponent(date)}`,
      );
      setStatusDate(response.statusDate);
      setTasks(response.rows);
      setBudgetItems(response.budgetItems);
      setBudgetSummary(response.budgetSummary);
    } catch (error) {
      alert(error instanceof Error ? error.message : "加载挣值分析失败");
    } finally {
      setLoading(false);
    }
  }, [projectId, statusDate]);

  useEffect(() => {
    void fetchData();
    // 项目切换时重新读取，检查日期由接口规范化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const analysis = useMemo(() => calculateEarnedValue(tasks, statusDate), [statusDate, tasks]);
  const forecast = analysis.summary[forecastMode];
  const comparisonMax = Math.max(analysis.summary.pv, analysis.summary.ev, analysis.summary.ac, 1);

  const updateCost = (taskId: string, key: "budgetAtCompletion" | "actualCost", value: string) => {
    const parsed = Number(value);
    setTasks((current) => current.map((task) => task.id === taskId
      ? { ...task, [key]: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 }
      : task));
  };

  const updateTaskField = (
    taskId: string,
    key: "budgetItemId",
    value: EarnedValueTaskInput["budgetItemId"],
  ) => {
    setTasks((current) => current.map((task) => task.id === taskId ? { ...task, [key]: value } : task));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/projects/${projectId}/earned-value`, {
        entries: tasks.map((task) => ({
          taskId: task.id,
          budgetAtCompletion: task.budgetAtCompletion ?? 0,
          actualCost: task.actualCost ?? 0,
          budgetItemId: task.budgetItemId ?? null,
        })),
      });
      await fetchData(statusDate);
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存挣值数据失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-sm text-muted-foreground">加载中...</div>;

  const progressDelta = analysis.summary.actualProgress - analysis.summary.plannedProgress;
  const scheduleMetrics = [
    { label: "计划进度", value: percent(analysis.summary.plannedProgress), formula: "按检查日期与计划工期计算", className: "text-foreground" },
    { label: "当前进度", value: percent(analysis.summary.actualProgress), formula: "按任务当前进度加权", className: "text-foreground" },
    { label: "进度偏差", value: `${progressDelta >= 0 ? "+" : ""}${percent(progressDelta)}`, formula: "当前进度 - 计划进度", className: tone(progressDelta) },
    { label: "计划完成工时", value: hours(analysis.summary.plannedWorkHours), formula: "计划总工时 × 计划进度", className: "text-foreground" },
    { label: "已挣工时", value: hours(analysis.summary.earnedWorkHours), formula: "计划总工时 × 当前进度", className: "text-foreground" },
    { label: "实际投入工时", value: hours(analysis.summary.actualWorkHours), formula: "任务实际工时合计", className: "text-foreground" },
    { label: "工时进度偏差", value: hours(analysis.summary.scheduleVarianceHours), formula: "已挣工时 - 计划完成工时", className: tone(analysis.summary.scheduleVarianceHours) },
    { label: "工时进度指数", value: ratio(analysis.summary.schedulePerformanceIndex), formula: "已挣工时 / 计划完成工时", className: tone(analysis.summary.schedulePerformanceIndex === null ? null : analysis.summary.schedulePerformanceIndex - 1) },
  ];
  const costMetrics = [
    { label: "计划价值 PV", value: analysis.summary.pv, formula: "BAC × 检查日应完成比例" },
    { label: "挣值 EV", value: analysis.summary.ev, formula: "BAC × 当前完成比例" },
    { label: "实际成本 AC", value: analysis.summary.ac, formula: "实际工时 × 预算小时成本，或实际成本" },
    { label: "完工预算 BAC", value: analysis.summary.bac, formula: "项目预算与任务关联/分摊" },
  ];
  const costIndicators = [
    { label: "预算化进度指数 SPI", value: ratio(analysis.summary.spi), formula: "EV / PV", className: tone(analysis.summary.spi === null ? null : analysis.summary.spi - 1) },
    { label: "成本偏差 CV", value: money(analysis.summary.cv), formula: "EV - AC", className: tone(analysis.summary.cv) },
    { label: "成本绩效 CPI", value: ratio(analysis.summary.cpi), formula: "EV / AC", className: tone(analysis.summary.cpi === null ? null : analysis.summary.cpi - 1) },
    { label: "剩余成本 ETC", value: money(forecast.etc), formula: forecastMode === "typical" ? "(BAC - EV) / CPI" : "BAC - EV", className: "text-foreground" },
    { label: "完工估算 EAC", value: money(forecast.eac), formula: "AC + ETC", className: "text-foreground" },
    { label: "完工偏差 VAC", value: money(forecast.vac), formula: "BAC - EAC", className: tone(forecast.vac) },
    { label: "按 BAC 完成 TCPI", value: ratio(analysis.summary.tcpiBac), formula: "(BAC - EV) / (BAC - AC)", className: tone(analysis.summary.tcpiBac === null ? null : 1 - analysis.summary.tcpiBac) },
    { label: "按 EAC 完成 TCPI", value: ratio(forecast.tcpiEac), formula: "(BAC - EV) / (EAC - AC)", className: tone(forecast.tcpiEac === null ? null : 1 - forecast.tcpiEac) },
  ];

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-md border border-primary/25 bg-primary/10 text-primary">
            <TrendingUp className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">挣值分析</h2>
            <p className="text-xs text-muted-foreground">项目绩效基准与完工预测</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-xs text-muted-foreground">
            检查日期
            <GanttDateField
              value={statusDate}
              onChange={setStatusDate}
              onCommit={(value) => value && void fetchData(value)}
              ariaLabel="挣值检查日期"
              required
            />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            完工预测口径
            <Select value={forecastMode} onChange={(event) => setForecastMode(event.target.value as ForecastMode)} className="h-8 w-44 text-xs">
              <option value="typical">典型偏差持续</option>
              <option value="atypical">非典型偏差调整</option>
            </Select>
          </label>
          <Button type="button" size="sm" variant="outline" className="h-8" onClick={() => void fetchData(statusDate)}>
            <RefreshCcw className="size-3.5" /> 刷新
          </Button>
          {canEdit && (
            <Button type="button" size="sm" className="h-8" disabled={saving} onClick={() => void save()}>
              <Save className="size-3.5" /> {saving ? "保存中..." : "保存"}
            </Button>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold">时间与工时进度绩效</h3>
          <span className="text-[11px] text-muted-foreground">预计工时和实际工时来自项目 WBS 管理</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {scheduleMetrics.map((metric) => (
            <div key={metric.label} className="rounded-md border border-border bg-card px-3 py-2.5">
              <div className="text-xs text-muted-foreground">{metric.label}</div>
              <div className={cn("mt-1 text-lg font-semibold tabular-nums", metric.className)}>{metric.value}</div>
              <div className="mt-1 text-[11px] text-muted-foreground/70">{metric.formula}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2 border-t border-border pt-3">
        <h3 className="text-xs font-semibold">挣值与成本绩效</h3>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {costMetrics.map((metric) => (
          <div key={metric.label} className="rounded-md border border-border bg-card px-3 py-2.5">
            <div className="text-xs text-muted-foreground">{metric.label}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{money(metric.value)}</div>
            <div className="mt-1 text-[11px] text-muted-foreground/70">{metric.formula}</div>
          </div>
        ))}
        </div>
      </section>

      <section className="grid gap-2 rounded-md border border-border bg-muted/15 px-3 py-2 text-[11px] text-muted-foreground md:grid-cols-3">
        <span>项目预算：<strong className="ml-1 text-foreground">{money(budgetSummary.projectBudget)}</strong></span>
        <span>已关联预算条目：<strong className="ml-1 text-foreground">{budgetSummary.linkedBudgetItems}</strong></span>
        <span>人力综合小时成本：<strong className="ml-1 text-foreground">{money(budgetSummary.blendedHourlyCost)}</strong></span>
      </section>

      <section className="grid gap-4 border-y border-border py-3 lg:grid-cols-[minmax(260px,0.7fr)_minmax(560px,1.3fr)]">
        <div className="space-y-3">
          {[{ label: "PV", value: analysis.summary.pv, color: "bg-sky-500" }, { label: "EV", value: analysis.summary.ev, color: "bg-emerald-500" }, { label: "AC", value: analysis.summary.ac, color: "bg-amber-500" }].map((item) => (
            <div key={item.label} className="grid grid-cols-[28px_1fr_110px] items-center gap-2 text-xs">
              <span className="font-medium">{item.label}</span>
              <div className="h-2 overflow-hidden rounded-sm bg-muted">
                <div className={cn("h-full transition-[width] duration-300", item.color)} style={{ width: `${Math.max(0, item.value / comparisonMax * 100)}%` }} />
              </div>
              <span className="text-right tabular-nums text-muted-foreground">{money(item.value)}</span>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-2 md:grid-cols-3">
          {costIndicators.map((item) => (
            <div key={item.label} className="min-w-0 border-l border-border pl-2.5">
              <div className="truncate text-[11px] text-muted-foreground">{item.label}</div>
              <div className={cn("mt-0.5 text-sm font-semibold tabular-nums", item.className)}>{item.value}</div>
              <div className="truncate text-[10px] text-muted-foreground/65">{item.formula}</div>
            </div>
          ))}
        </div>
      </section>

      <section>
          <Table className="min-w-[1660px] table-fixed">
            <TableHeader>
              <TableRow className="h-9">
                <TableHead className="w-24">任务ID</TableHead>
                <TableHead className="w-60">任务名称</TableHead>
                <TableHead className="w-28 text-right">计划进度</TableHead>
                <TableHead className="w-24 text-right">当前进度</TableHead>
                <TableHead className="w-64">预算条目</TableHead>
                <TableHead className="w-28 text-right">预计工时</TableHead>
                <TableHead className="w-28 text-right">实际工时</TableHead>
                <TableHead className="w-36 text-right">完工预算 BAC</TableHead>
                <TableHead className="w-36 text-right">实际成本 AC</TableHead>
                <TableHead className="w-32 text-right">PV</TableHead>
                <TableHead className="w-32 text-right">EV</TableHead>
                <TableHead className="w-32 text-right">工时偏差</TableHead>
                <TableHead className="w-32 text-right">成本偏差 CV</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analysis.rows.map((row) => (
                <TableRow key={row.id} className="h-10">
                  <TableCell className="font-mono text-[11px] text-muted-foreground">{row.taskCode}</TableCell>
                  <TableCell className="truncate font-medium" title={row.taskName}>{row.taskName || "未命名任务"}</TableCell>
                  <TableCell className="text-right tabular-nums">{numberFormatter.format(row.plannedProgress * 100)}%</TableCell>
                  <TableCell className="text-right tabular-nums">{row.progress}%</TableCell>
                  <TableCell className="px-2">
                    <Select
                      value={row.budgetItemId ?? ""}
                      disabled={!canEdit || saving || row.includeInTotals === false}
                      onChange={(event) => updateTaskField(row.id, "budgetItemId", event.target.value || null)}
                      className={transparentRowSelectClass}
                      variant="ghost"
                    >
                      <option value="">按项目预算自动分摊</option>
                      {budgetItems.map((item) => (
                        <option key={item.id} value={item.id}>{item.categoryName} / {item.title} · {money(item.plannedCost)}</option>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell className="px-2">
                    <Input
                      type="text"
                      value={row.estimatedWorkHours && row.estimatedWorkHours > 0
                        ? numberFormatter.format(row.estimatedWorkHours)
                        : "--"}
                      readOnly
                      aria-readonly="true"
                      tabIndex={-1}
                      title="来自项目 WBS 管理"
                      className={cn(transparentRowInputClass, "cursor-default")}
                    />
                  </TableCell>
                  <TableCell className="px-2">
                    <Input
                      type="text"
                      value={row.actualWorkHours && row.actualWorkHours > 0
                        ? numberFormatter.format(row.actualWorkHours)
                        : "--"}
                      readOnly
                      aria-readonly="true"
                      tabIndex={-1}
                      title="来自项目 WBS 管理"
                      className={cn(transparentRowInputClass, "cursor-default")}
                    />
                  </TableCell>
                  <TableCell className="px-2">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={row.budgetAtCompletion ?? 0}
                      disabled={!canEdit || saving}
                      onChange={(event) => updateCost(row.id, "budgetAtCompletion", event.target.value)}
                      className={transparentRowInputClass}
                      aria-label={`${row.taskName} 完工预算`}
                    />
                  </TableCell>
                  <TableCell className="px-2">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={row.actualCost ?? 0}
                      disabled={!canEdit || saving}
                      onChange={(event) => updateCost(row.id, "actualCost", event.target.value)}
                      className={transparentRowInputClass}
                      aria-label={`${row.taskName} 实际成本`}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.pv)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.ev)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", tone(row.workVarianceHours))}>{hours(row.workVarianceHours)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", tone(row.cv))}>{money(row.cv)}</TableCell>
                </TableRow>
              ))}
              {analysis.rows.length === 0 && <TableEmptyState colSpan={13} className="h-24">暂无项目任务</TableEmptyState>}
            </TableBody>
          </Table>
      </section>
    </div>
  );
};
