"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock3, RefreshCcw, Save, TrendingUp, UsersRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  rows: Array<EarnedValueTaskResult & { actualCostMode?: ActualCostMode; budgetSource?: string }>;
  budgetItems: Array<{ id: string; title: string; categoryName: string; kind: string; plannedCost: number; hourlyCost: number }>;
  budgetSummary: { projectBudget: number; linkedBudgetItems: number; blendedHourlyCost: number };
}

interface ProjectEarnedValuePanelProps {
  projectId: string;
  projectStatus: ProjectStatus;
}

type ForecastMode = "typical" | "atypical";
type ActualCostMode = "LEGACY_AUTO_TASK_RATE" | "LEGACY_MANUAL_TOTAL" | "AUTO_LABOR" | "AUTO_PLUS_ADJUSTMENT";
type EarnedValueTask = EarnedValueTaskInput & { actualCostMode?: ActualCostMode; budgetSource?: string };

interface PersonnelEarnedValueResponse {
  statusDate: string;
  rows: Array<{
    projectMemberId: string | null;
    personName: string;
    roleName: string;
    isUnattributed: boolean;
    taskCount: number;
    worklogCount: number;
    bac: number;
    pv: number;
    ev: number;
    ac: number;
    cv: number;
    cpi: number | null;
    plannedWorkHours: number;
    earnedWorkHours: number;
    actualWorkHours: number;
    workVarianceHours: number;
    legacyActualCost: number;
    manualAdjustmentCost: number;
  }>;
  attribution: {
    unattributedBac: number;
    unattributedActualCost: number;
    legacyActualCost: number;
    manualAdjustmentCost: number;
  };
}

type TaskDialogTarget = { id: string; taskCode: string; taskName: string };

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

const COST_MODE_LABEL: Record<ActualCostMode, string> = {
  AUTO_LABOR: "按人员工时自动计算",
  AUTO_PLUS_ADJUSTMENT: "人员工时 + 手工调整",
  LEGACY_MANUAL_TOTAL: "历史手工总成本",
  LEGACY_AUTO_TASK_RATE: "历史任务小时费率",
};

export const ProjectEarnedValuePanel = ({ projectId, projectStatus }: ProjectEarnedValuePanelProps) => {
  const [tasks, setTasks] = useState<EarnedValueTask[]>([]);
  const [budgetItems, setBudgetItems] = useState<EarnedValueApiResponse["budgetItems"]>([]);
  const [budgetSummary, setBudgetSummary] = useState<EarnedValueApiResponse["budgetSummary"]>({ projectBudget: 0, linkedBudgetItems: 0, blendedHourlyCost: 0 });
  const [personnelRows, setPersonnelRows] = useState<PersonnelEarnedValueResponse["rows"]>([]);
  const [personnelAttribution, setPersonnelAttribution] = useState<PersonnelEarnedValueResponse["attribution"]>({
    unattributedBac: 0,
    unattributedActualCost: 0,
    legacyActualCost: 0,
    manualAdjustmentCost: 0,
  });
  const [statusDate, setStatusDate] = useState(new Date().toISOString().slice(0, 10));
  const [forecastMode, setForecastMode] = useState<ForecastMode>("typical");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [laborAssignmentTask, setLaborAssignmentTask] = useState<TaskDialogTarget | null>(null);
  const [worklogTask, setWorklogTask] = useState<TaskDialogTarget | null>(null);
  const { can } = usePermission();
  const readOnly = projectStatus === ProjectStatus.COMPLETED || projectStatus === ProjectStatus.VOIDED;
  const canEdit = can("earned-value:edit") && !readOnly;
  const canEditWbs = can("project-gantt:edit") && !readOnly;

  const fetchData = useCallback(async (date = statusDate) => {
    setLoading(true);
    try {
      const [response, personnel] = await Promise.all([
        api.get<EarnedValueApiResponse>(`/api/projects/${projectId}/earned-value?statusDate=${encodeURIComponent(date)}`),
        api.get<PersonnelEarnedValueResponse>(`/api/projects/${projectId}/earned-value/personnel?statusDate=${encodeURIComponent(date)}`),
      ]);
      setStatusDate(response.statusDate);
      setTasks(response.rows);
      setBudgetItems(response.budgetItems);
      setBudgetSummary(response.budgetSummary);
      setPersonnelRows(personnel.rows);
      setPersonnelAttribution(personnel.attribution);
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
  const taskById = new Map(tasks.map((task) => [task.id, task] as const));
  const analysisRows = analysis.rows.map((row) => ({
    ...row,
    actualCostMode: (taskById.get(row.id)?.actualCostMode ?? "AUTO_LABOR") as ActualCostMode,
  }));

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

  const updateCostMode = (taskId: string, actualCostMode: ActualCostMode) => {
    setTasks((current) => current.map((task) => task.id === taskId ? { ...task, actualCostMode } : task));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/api/projects/${projectId}/earned-value`, {
        entries: tasks.map((task) => ({
          taskId: task.id,
          budgetAtCompletion: task.budgetAtCompletion ?? 0,
          actualCost: task.actualCost ?? 0,
          actualCostMode: task.actualCostMode ?? "AUTO_LABOR",
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
          <Table className="min-w-[1940px] table-fixed">
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
                <TableHead className="w-44">实际成本口径</TableHead>
                <TableHead className="w-44">人员与工时</TableHead>
                <TableHead className="w-32 text-right">PV</TableHead>
                <TableHead className="w-32 text-right">EV</TableHead>
                <TableHead className="w-32 text-right">工时偏差</TableHead>
                <TableHead className="w-32 text-right">成本偏差 CV</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analysisRows.map((row) => (
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
                      disabled={!canEdit || saving || (row.actualCostMode !== "LEGACY_MANUAL_TOTAL" && row.actualCostMode !== "AUTO_PLUS_ADJUSTMENT")}
                      onChange={(event) => updateCost(row.id, "actualCost", event.target.value)}
                      className={transparentRowInputClass}
                      aria-label={`${row.taskName} 实际成本`}
                    />
                  </TableCell>
                  <TableCell className="px-2">
                    <Select
                      value={row.actualCostMode}
                      disabled={!canEdit || saving || row.includeInTotals === false}
                      onChange={(event) => updateCostMode(row.id, event.target.value as ActualCostMode)}
                      className={transparentRowSelectClass}
                      variant="ghost"
                    >
                      {Object.entries(COST_MODE_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell className="px-2">
                    {row.includeInTotals !== false ? (
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          disabled={!canEditWbs || saving}
                          onClick={() => setLaborAssignmentTask({ id: row.id, taskCode: row.taskCode, taskName: row.taskName })}
                        >
                          <UsersRound className="size-3.5" /> 分工
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          disabled={!canEditWbs || saving}
                          onClick={() => setWorklogTask({ id: row.id, taskCode: row.taskCode, taskName: row.taskName })}
                        >
                          <Clock3 className="size-3.5" /> 登记
                        </Button>
                      </div>
                    ) : <span className="text-[11px] text-muted-foreground">父级汇总</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.pv)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.ev)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", tone(row.workVarianceHours))}>{hours(row.workVarianceHours)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", tone(row.cv))}>{money(row.cv)}</TableCell>
                </TableRow>
              ))}
              {analysisRows.length === 0 && <TableEmptyState colSpan={15} className="h-24">暂无项目任务</TableEmptyState>}
            </TableBody>
          </Table>
      </section>
      <section className="space-y-3 border-t border-border pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">人员成本与挣值</h3>
            <p className="mt-1 text-xs text-muted-foreground">BAC、PV、EV 按 WBS 人员分工或人力预算分摊归集；AC 仅来自对应人员的冻结工时成本。</p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>待归集预算：<strong className={cn("text-foreground", personnelAttribution.unattributedBac > 0 && "text-amber-600")}>{money(personnelAttribution.unattributedBac)}</strong></div>
            <div>待归集实际：<strong className={cn("text-foreground", personnelAttribution.unattributedActualCost > 0 && "text-amber-600")}>{money(personnelAttribution.unattributedActualCost)}</strong></div>
          </div>
        </div>
        {(personnelAttribution.legacyActualCost > 0 || personnelAttribution.manualAdjustmentCost > 0) && (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            历史成本或手工调整会显式展示在“待归集”，避免被静默分摊给个人。历史成本：{money(personnelAttribution.legacyActualCost)}；手工调整：{money(personnelAttribution.manualAdjustmentCost)}。
          </div>
        )}
        <Table className="min-w-[1280px] table-fixed">
          <TableHeader>
            <TableRow className="h-9">
              <TableHead className="w-52">项目成员</TableHead>
              <TableHead className="w-20 text-right">任务</TableHead>
              <TableHead className="w-32 text-right">BAC</TableHead>
              <TableHead className="w-32 text-right">PV</TableHead>
              <TableHead className="w-32 text-right">EV</TableHead>
              <TableHead className="w-32 text-right">AC</TableHead>
              <TableHead className="w-32 text-right">成本偏差 CV</TableHead>
              <TableHead className="w-24 text-right">CPI</TableHead>
              <TableHead className="w-28 text-right">计划工时</TableHead>
              <TableHead className="w-28 text-right">已挣工时</TableHead>
              <TableHead className="w-28 text-right">实际工时</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {personnelRows.map((row) => (
              <TableRow key={row.projectMemberId ?? "unattributed"} className={row.isUnattributed ? "bg-amber-50/70" : undefined}>
                <TableCell>
                  <div className="font-medium">{row.personName}</div>
                  <div className="text-[11px] text-muted-foreground">{row.roleName}{row.worklogCount > 0 ? ` · ${row.worklogCount} 条工时` : ""}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.taskCount}</TableCell>
                <TableCell className="text-right tabular-nums">{money(row.bac)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(row.pv)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(row.ev)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(row.ac)}</TableCell>
                <TableCell className={cn("text-right tabular-nums", tone(row.cv))}>{money(row.cv)}</TableCell>
                <TableCell className={cn("text-right tabular-nums", tone(row.cpi === null ? null : row.cpi - 1))}>{ratio(row.cpi)}</TableCell>
                <TableCell className="text-right tabular-nums">{hours(row.plannedWorkHours)}</TableCell>
                <TableCell className="text-right tabular-nums">{hours(row.earnedWorkHours)}</TableCell>
                <TableCell className="text-right tabular-nums">{hours(row.actualWorkHours)}</TableCell>
              </TableRow>
            ))}
            {personnelRows.length === 0 && <TableEmptyState colSpan={11} className="h-24">暂无可归集的人员成本数据</TableEmptyState>}
          </TableBody>
        </Table>
      </section>
      {laborAssignmentTask && (
        <TaskLaborAssignmentDialog
          projectId={projectId}
          task={laborAssignmentTask}
          onClose={() => setLaborAssignmentTask(null)}
          onSaved={async () => {
            setLaborAssignmentTask(null);
            await fetchData(statusDate);
          }}
        />
      )}
      {worklogTask && (
        <TaskWorklogDialog
          projectId={projectId}
          task={worklogTask}
          onClose={() => setWorklogTask(null)}
          onSaved={async () => {
            setWorklogTask(null);
            await fetchData(statusDate);
          }}
        />
      )}
    </div>
  );
};

type TaskLaborMember = { id: string; personName: string; roleName: string };
type TaskLaborAssignmentDraft = { projectMemberId: string; plannedWorkHours: number; remark: string };
interface TaskLaborAssignmentResponse {
  task: { id: string; taskCode: string; taskName: string; estimatedWorkHours: number; ownerMemberId: string | null };
  members: TaskLaborMember[];
  assignments: Array<TaskLaborAssignmentDraft & { projectMember: TaskLaborMember }>;
}

const TaskLaborAssignmentDialog = ({
  projectId,
  task,
  onClose,
  onSaved,
}: {
  projectId: string;
  task: TaskDialogTarget;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<TaskLaborMember[]>([]);
  const [estimatedWorkHours, setEstimatedWorkHours] = useState(0);
  const [assignments, setAssignments] = useState<TaskLaborAssignmentDraft[]>([]);

  useEffect(() => {
    let active = true;
    void api.get<TaskLaborAssignmentResponse>(`/api/projects/${projectId}/gantt-tasks/${task.id}/labor-assignments`)
      .then((response) => {
        if (!active) return;
        setMembers(response.members);
        setEstimatedWorkHours(response.task.estimatedWorkHours);
        setAssignments(response.assignments.map((assignment) => ({
          projectMemberId: assignment.projectMemberId,
          plannedWorkHours: assignment.plannedWorkHours,
          remark: assignment.remark,
        })));
      })
      .catch((error) => active && alert(error instanceof Error ? error.message : "加载 WBS 人员分工失败"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [projectId, task.id]);

  const updateAssignment = (index: number, patch: Partial<TaskLaborAssignmentDraft>) => {
    setAssignments((current) => current.map((assignment, assignmentIndex) => (
      assignmentIndex === index ? { ...assignment, ...patch } : assignment
    )));
  };
  const totalPlannedHours = assignments.reduce((sum, assignment) => sum + (Number.isFinite(assignment.plannedWorkHours) ? assignment.plannedWorkHours : 0), 0);
  const save = async () => {
    if (assignments.some((assignment) => !assignment.projectMemberId)) {
      alert("请选择每条 WBS 人员分工对应的项目成员");
      return;
    }
    setSaving(true);
    try {
      await api.put(`/api/projects/${projectId}/gantt-tasks/${task.id}/labor-assignments`, { assignments });
      await onSaved();
    } catch (error) {
      alert(error instanceof Error ? error.message : "保存 WBS 人员分工失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card className="max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-auto">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-sm">WBS 投入人员分工</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">{task.taskCode} / {task.taskName}</p>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <div>任务预计工时：<strong className="text-foreground">{hours(estimatedWorkHours)}</strong></div>
              <div>人员计划工时：<strong className={cn("text-foreground", Math.abs(totalPlannedHours - estimatedWorkHours) > 0.01 && "text-amber-600")}>{hours(totalPlannedHours)}</strong></div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div> : (
            <>
              <p className="text-xs text-muted-foreground">这不会修改甘特图中的“负责人”；多人分工只用于人员预算、实际工时和人员挣值归集。</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>项目成员</TableHead>
                    <TableHead className="w-36 text-right">计划投入工时</TableHead>
                    <TableHead>备注</TableHead>
                    <TableHead className="w-16" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assignments.map((assignment, index) => (
                    <TableRow key={`${assignment.projectMemberId}-${index}`}>
                      <TableCell className="p-2">
                        <Select value={assignment.projectMemberId} onChange={(event) => updateAssignment(index, { projectMemberId: event.target.value })} className="h-8 text-xs">
                          <option value="">请选择成员</option>
                          {members.map((member) => <option key={member.id} value={member.id}>{member.personName}（{member.roleName}）</option>)}
                        </Select>
                      </TableCell>
                      <TableCell className="p-2"><Input type="number" min={0} step="0.5" value={assignment.plannedWorkHours} onChange={(event) => updateAssignment(index, { plannedWorkHours: Number(event.target.value) || 0 })} className="h-8 text-right text-xs tabular-nums" /></TableCell>
                      <TableCell className="p-2"><Input value={assignment.remark} onChange={(event) => updateAssignment(index, { remark: event.target.value })} className="h-8 text-xs" placeholder="可选" /></TableCell>
                      <TableCell className="p-2 text-right"><Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => setAssignments((current) => current.filter((_, assignmentIndex) => assignmentIndex !== index))}>移除</Button></TableCell>
                    </TableRow>
                  ))}
                  {assignments.length === 0 && <TableRow><TableCell colSpan={4} className="h-20 text-center text-xs text-muted-foreground">尚未设置人员分工</TableCell></TableRow>}
                </TableBody>
              </Table>
              <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => setAssignments((current) => [...current, { projectMemberId: "", plannedWorkHours: 0, remark: "" }])}>
                <UsersRound className="size-3.5" /> 添加投入人员
              </Button>
            </>
          )}
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" size="sm" variant="outline" className="h-8 text-xs" disabled={saving} onClick={onClose}>取消</Button>
            <Button type="button" size="sm" className="h-8 text-xs" disabled={loading || saving} onClick={() => void save()}>{saving ? "保存中..." : "保存分工"}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

interface TaskWorklogResponse {
  task: { id: string; taskCode: string; taskName: string; actualCostMode: ActualCostMode };
  canViewCost: boolean;
  worklogs: Array<{
    id: string;
    projectMemberId: string;
    workDate: string;
    actualHours: number;
    hourlyCostSnapshot: number | null;
    actualCostSnapshot: number | null;
    note: string;
    createdAt: string;
    projectMember: TaskLaborMember;
  }>;
}

const TaskWorklogDialog = ({
  projectId,
  task,
  onClose,
  onSaved,
}: {
  projectId: string;
  task: TaskDialogTarget;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<TaskLaborMember[]>([]);
  const [eligibleMemberIds, setEligibleMemberIds] = useState<string[]>([]);
  const [actualCostMode, setActualCostMode] = useState<ActualCostMode>("AUTO_LABOR");
  const [canViewCost, setCanViewCost] = useState(false);
  const [worklogs, setWorklogs] = useState<TaskWorklogResponse["worklogs"]>([]);
  const [projectMemberId, setProjectMemberId] = useState("");
  const [workDate, setWorkDate] = useState(new Date().toISOString().slice(0, 10));
  const [actualHours, setActualHours] = useState("8");
  const [note, setNote] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.get<TaskLaborAssignmentResponse>(`/api/projects/${projectId}/gantt-tasks/${task.id}/labor-assignments`),
      api.get<TaskWorklogResponse>(`/api/projects/${projectId}/gantt-tasks/${task.id}/worklogs`),
    ]).then(([assignmentResponse, worklogResponse]) => {
      if (!active) return;
      const ids = [...new Set([
        ...assignmentResponse.assignments.map((assignment) => assignment.projectMemberId),
        ...(assignmentResponse.task.ownerMemberId ? [assignmentResponse.task.ownerMemberId] : []),
      ])];
      setMembers(assignmentResponse.members);
      setEligibleMemberIds(ids);
      setProjectMemberId((current) => current || ids[0] || "");
      setActualCostMode(worklogResponse.task.actualCostMode);
      setCanViewCost(worklogResponse.canViewCost);
      setWorklogs(worklogResponse.worklogs);
    }).catch((error) => active && alert(error instanceof Error ? error.message : "加载实际工时失败"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [projectId, task.id]);

  const eligibleMembers = members.filter((member) => eligibleMemberIds.includes(member.id));
  const submit = async () => {
    const parsedHours = Number(actualHours);
    if (!projectMemberId) {
      alert("请先在 WBS 人员分工中选择实际投入人");
      return;
    }
    if (!Number.isFinite(parsedHours) || parsedHours <= 0) {
      alert("请输入大于 0 的实际工时");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/api/projects/${projectId}/gantt-tasks/${task.id}/worklogs`, {
        projectMemberId,
        workDate,
        actualHours: parsedHours,
        note,
      });
      await onSaved();
    } catch (error) {
      alert(error instanceof Error ? error.message : "登记实际工时失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card className="max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-auto">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">登记实际工时</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{task.taskCode} / {task.taskName}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? <div className="py-8 text-center text-sm text-muted-foreground">加载中...</div> : (
            <>
              {actualCostMode !== "AUTO_LABOR" && actualCostMode !== "AUTO_PLUS_ADJUSTMENT" ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  当前任务使用“{COST_MODE_LABEL[actualCostMode]}”。请先在上方任务表中切换为“按人员工时自动计算”或“人员工时 + 手工调整”并保存，再登记人员工时。
                </div>
              ) : eligibleMembers.length === 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">请先点击“分工”配置实际投入人员；负责人也可直接登记。</div>
              ) : (
                <div className="grid gap-3 md:grid-cols-4">
                  <label className="grid gap-1 text-xs text-muted-foreground">投入人员
                    <Select value={projectMemberId} onChange={(event) => setProjectMemberId(event.target.value)} className="h-8 text-xs">
                      <option value="">请选择成员</option>
                      {eligibleMembers.map((member) => <option key={member.id} value={member.id}>{member.personName}（{member.roleName}）</option>)}
                    </Select>
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">工时日期
                    <Input type="date" value={workDate} onChange={(event) => setWorkDate(event.target.value)} className="h-8 text-xs" />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">实际工时
                    <Input type="number" min={0.5} max={24} step={0.5} value={actualHours} onChange={(event) => setActualHours(event.target.value)} className="h-8 text-right text-xs tabular-nums" />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">备注
                    <Input value={note} onChange={(event) => setNote(event.target.value)} className="h-8 text-xs" placeholder="可选" />
                  </label>
                </div>
              )}
              <div className="rounded-md border border-border bg-muted/15 px-3 py-2 text-[11px] text-muted-foreground">每条工时会冻结当时的人员小时成本；后续预算费率变动不会重算已登记成本。</div>
              <Table>
                <TableHeader><TableRow><TableHead>日期</TableHead><TableHead>人员</TableHead><TableHead className="text-right">实际工时</TableHead>{canViewCost && <><TableHead className="text-right">小时成本</TableHead><TableHead className="text-right">实际成本</TableHead></>}<TableHead>备注</TableHead></TableRow></TableHeader>
                <TableBody>
                  {worklogs.map((worklog) => (
                    <TableRow key={worklog.id}>
                      <TableCell>{worklog.workDate}</TableCell>
                      <TableCell>{worklog.projectMember.personName}</TableCell>
                      <TableCell className="text-right tabular-nums">{hours(worklog.actualHours)}</TableCell>
                      {canViewCost && <><TableCell className="text-right tabular-nums">{money(worklog.hourlyCostSnapshot)}</TableCell><TableCell className="text-right tabular-nums">{money(worklog.actualCostSnapshot)}</TableCell></>}
                      <TableCell className="max-w-48 truncate" title={worklog.note}>{worklog.note || "--"}</TableCell>
                    </TableRow>
                  ))}
                  {worklogs.length === 0 && <TableEmptyState colSpan={canViewCost ? 6 : 4} className="h-20">尚无实际工时登记</TableEmptyState>}
                </TableBody>
              </Table>
            </>
          )}
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" size="sm" variant="outline" className="h-8 text-xs" disabled={saving} onClick={onClose}>关闭</Button>
            <Button type="button" size="sm" className="h-8 text-xs" disabled={loading || saving || eligibleMembers.length === 0 || (actualCostMode !== "AUTO_LABOR" && actualCostMode !== "AUTO_PLUS_ADJUSTMENT")} onClick={() => void submit()}>{saving ? "登记中..." : "登记工时"}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
