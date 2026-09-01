"use client";

import { createContext, type FocusEvent, type KeyboardEvent, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardPaste, Copy, Pencil, Plus, Redo2, Scissors, Trash2, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableActionButton,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useConfirm } from "@/components/confirm-provider";
import { api } from "@/lib/api-client";
import { usePermission } from "@/lib/use-permission";
import { BudgetCategoryKind, ProjectStatus } from "@/domain/enums";
import type {
  ProjectBudgetCategory,
  ProjectBudgetItem,
} from "@/domain/models";
import { TableContextMenu, type TableContextMenuAction, useTableContextMenu } from "@/components/table-context-menu";
import { cn } from "@/lib/utils";
import { useModuleHistory } from "@/lib/use-module-history";
import { useCommitOnOutsidePointer } from "@/lib/use-commit-on-outside-pointer";

interface ProjectBudgetPanelProps {
  projectId: string;
  projectStatus: ProjectStatus;
  projectAmountWan: number;
}

type CategoryWithMeta = ProjectBudgetCategory & {
  items: ProjectBudgetItem[];
};

type RunBudgetAction = <T>(label: string, targetIds: string[], action: () => Promise<T>) => Promise<T>;
const BudgetHistoryContext = createContext<RunBudgetAction>(async (_label, _targetIds, action) => action());

const handleBudgetRowKeyDown = (
  event: KeyboardEvent<HTMLElement>,
  cancel: () => void,
) => {
  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
    return;
  }
  if (event.key !== "Enter") return;
  if (event.target instanceof HTMLTextAreaElement && event.shiftKey) return;
  event.preventDefault();
  if (event.target instanceof HTMLElement) event.target.blur();
};

const handleBudgetRowBlur = (event: FocusEvent<HTMLElement>, submit: () => void | Promise<void>) => {
  const nextTarget = event.relatedTarget instanceof HTMLElement ? event.relatedTarget : null;
  if (nextTarget && event.currentTarget.contains(nextTarget)) return;
  void submit();
};

type BudgetClipboard = {
  projectId: string;
  categoryId: string;
  mode: "COPY" | "MOVE";
  itemId: string;
};

interface BudgetStructureResult {
  categoryId: string;
  createdItemIds: string[];
  movedItemIds: string[];
}

const useBudgetRowStructure = ({
  category,
  projectId,
  canCreate,
  canEdit,
  onChanged,
}: {
  category: CategoryWithMeta;
  projectId: string;
  canCreate: boolean;
  canEdit: boolean;
  onChanged: () => void | Promise<void>;
}) => {
  const runAction = useContext(BudgetHistoryContext);
  const [clipboard, setClipboard] = useState<BudgetClipboard | null>(null);

  useEffect(() => {
    setClipboard(null);
  }, [category.id, projectId]);

  const copyOrCut = (mode: BudgetClipboard["mode"], itemId: string) => {
    setClipboard({ projectId, categoryId: category.id, mode, itemId });
  };

  const performStructure = async (
    operation: "INSERT" | "COPY" | "MOVE",
    anchorItemId: string,
    position: "BEFORE" | "AFTER",
  ) => {
    const sourceItemIds = operation === "INSERT" ? [] : clipboard ? [clipboard.itemId] : [];
    if (operation !== "INSERT" && (!clipboard || clipboard.projectId !== projectId || clipboard.categoryId !== category.id)) return;
    if (operation === "MOVE" && sourceItemIds.includes(anchorItemId)) {
      alert("剪切的预算条目不能粘贴到自身，请选择其他目标行");
      return;
    }
    const label = operation === "INSERT" ? "插入预算条目" : operation === "COPY" ? "复制粘贴预算条目" : "剪切移动预算条目";
    const historyTargets = [...sourceItemIds];
    try {
      await runAction(label, historyTargets, async () => {
        const response = await api.post<BudgetStructureResult>(`/api/projects/${projectId}/budget-items/structure`, {
          operation,
          anchorItemId,
          position,
          sourceItemIds,
          count: 1,
        });
        historyTargets.push(...response.createdItemIds);
        return response;
      });
      if (operation === "MOVE") setClipboard(null);
      await onChanged();
    } catch (error) {
      alert(error instanceof Error ? error.message : `${label}失败`);
    }
  };

  const actionsFor = (item: ProjectBudgetItem): TableContextMenuAction[] => [
    ...(canEdit ? [
      { label: "剪切", icon: <Scissors className="size-4" />, onSelect: () => copyOrCut("MOVE", item.id) },
      { label: "复制", icon: <Copy className="size-4" />, onSelect: () => copyOrCut("COPY", item.id) },
      {
        label: "粘贴",
        icon: <ClipboardPaste className="size-4" />,
        disabled: !clipboard || clipboard.categoryId !== category.id,
        children: [
          { label: "粘贴到行上方", disabled: clipboard?.mode === "MOVE" && clipboard.itemId === item.id, onSelect: () => performStructure(clipboard?.mode ?? "COPY", item.id, "BEFORE") },
          { label: "粘贴到行下方", disabled: clipboard?.mode === "MOVE" && clipboard.itemId === item.id, onSelect: () => performStructure(clipboard?.mode ?? "COPY", item.id, "AFTER") },
        ],
      },
    ] : []),
    ...(canCreate ? [{
      label: "插入",
      icon: <Plus className="size-4" />,
      separatorBefore: true,
      children: [
        { label: "在上方插入 1 条预算", onSelect: () => performStructure("INSERT", item.id, "BEFORE") },
        { label: "在下方插入 1 条预算", onSelect: () => performStructure("INSERT", item.id, "AFTER") },
      ],
    }] : []),
  ];

  return { actionsFor };
};

const formatAmount = (n: number | undefined | null) => {
  if (!Number.isFinite(n as number)) return "0";
  return (n as number).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
};
const formatPercent = (n: number | undefined | null) => {
  if (!Number.isFinite(n as number)) return "0%";
  return `${(n as number).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
};

const KIND_LABEL: Record<BudgetCategoryKind, string> = {
  [BudgetCategoryKind.MANPOWER]: "人力型",
  [BudgetCategoryKind.PURCHASE]: "采购型",
  [BudgetCategoryKind.OTHER]: "差旅型",
  [BudgetCategoryKind.RATE]: "费率型",
};

const KIND_BADGE_CLASS: Record<BudgetCategoryKind, string> = {
  [BudgetCategoryKind.MANPOWER]: "bg-blue-100 text-blue-700 border-blue-200",
  [BudgetCategoryKind.PURCHASE]: "bg-amber-100 text-amber-700 border-amber-200",
  [BudgetCategoryKind.OTHER]: "bg-amber-100 text-amber-700 border-amber-200",
  [BudgetCategoryKind.RATE]: "bg-violet-100 text-violet-700 border-violet-200",
};

const categorySubtotal = (cat: CategoryWithMeta): number =>
  cat.items.reduce((acc, it) => acc + calcItemSubtotal(cat.kind, it), 0);

const calcItemSubtotal = (kind: string, it: ProjectBudgetItem): number => {
  if (kind === "MANPOWER") return it.personMonths * it.monthlyCostPerPerson;
  if (kind === "PURCHASE") {
    return it.unitPrice * (it.sampleQuantity + it.productionQuantity);
  }
  if (kind === "OTHER") return it.amount;
  return 0;
};

const calcCategorySubtotal = (cat: CategoryWithMeta, contractAmount: number): number => {
  if (cat.kind === BudgetCategoryKind.RATE) {
    return cat.items.reduce((acc, it) => acc + contractAmount * ((it.currentRate ?? 0) / 100), 0);
  }
  return categorySubtotal(cat);
};

const budgetItemLabel = (item: ProjectBudgetItem) => item.title || [item.person, item.groupName].filter(Boolean).join(" · ") || "预算条目";
const budgetDeleteMessage = (item: ProjectBudgetItem) => {
  const target = budgetItemLabel(item);
  if (!item.linkedTasks?.length) return `确认删除「${target}」？`;
  const links = item.linkedTasks.map((task) => `${task.taskCode} · ${task.taskName}`).join("、");
  return `确认删除「${target}」？\n当前与以下 WBS 任务存在关联：${links}\n删除后这些任务将自动改为不关联状态；撤销删除可恢复关联。`;
};

// ================ 主组件 ================
export const ProjectBudgetPanel = ({
  projectId,
  projectStatus,
  projectAmountWan,
}: ProjectBudgetPanelProps) => {
  const [categories, setCategories] = useState<CategoryWithMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const confirm = useConfirm();
  const { can } = usePermission();

  const readOnly =
    projectStatus === ProjectStatus.COMPLETED ||
    projectStatus === ProjectStatus.VOIDED;
  const canCreateItem = can("project-budget:create") && !readOnly;
  const canEditItem = can("project-budget:edit") && !readOnly;
  const canDeleteItem = can("project-budget:delete") && !readOnly;
  const canManageCategory = can("project-budget:category-manage") && !readOnly;

  const fetchAll = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setLoadError(null);
    try {
      const [cats, items] = await Promise.all([
        api.get<ProjectBudgetCategory[]>(`/api/projects/${projectId}/budget-categories`),
        api.get<(ProjectBudgetItem & { category: { id: string; name: string; kind: string } | null })[]>(
          `/api/projects/${projectId}/budget-items`,
        ),
      ]);
      const merged: CategoryWithMeta[] = cats.map((c) => ({
        ...c,
        items: items
          .filter((i) => i.categoryId === c.id)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
      }));
      setCategories(merged);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载预算失败");
      setCategories([]);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void Promise.resolve().then(() => fetchAll());
  }, [fetchAll]);

  const {
    undo,
    redo,
    runWithHistory,
    undoEntry,
    redoEntry,
    historyBusy,
  } = useModuleHistory({
    projectId,
    module: "PROJECT_BUDGET",
    enabled: !readOnly,
    onRestored: () => fetchAll(false),
    onError: (errorTitle, message) => alert(`${errorTitle}\n${message}`),
    onWarning: (message) => alert(message),
  });

  // RATE 分类：当前费率（currentRate）按"分类名 → 费率"映射；用于 KPI 计算
  // RATE 分类下约定只放 1 条档位条目，取第一条的 currentRate
  const findCurrentRate = (name: string): number => {
    const cat = categories.find(
      (c) => c.kind === BudgetCategoryKind.RATE && c.name === name,
    );
    if (!cat || cat.items.length === 0) return 0;
    return cat.items[0].currentRate ?? 0;
  };

  // 汇总计算
  const summary = useMemo(() => {
    const manpower = categories
      .filter((c) => c.kind === BudgetCategoryKind.MANPOWER)
      .reduce((acc, c) => acc + categorySubtotal(c), 0);
    const purchase = categories
      .filter((c) => c.kind === BudgetCategoryKind.PURCHASE)
      .reduce((acc, c) => acc + categorySubtotal(c), 0);
    const travel = categories
      .filter((c) => c.kind === BudgetCategoryKind.OTHER)
      .reduce((acc, c) => acc + categorySubtotal(c), 0);
    const directCost = manpower + purchase + travel;
    const overheadRate = findCurrentRate("公摊成本比例");
    const auditRate = findCurrentRate("审价扣除预留");
    const riskRate = findCurrentRate("风险成本预留");
    // 合同金额以「项目信息」中的 amountWan（万元）为准，自动换算为元
    const contract = (projectAmountWan || 0) * 10000;
    const overhead = contract * (overheadRate / 100);
    const auditDeduction = contract * (auditRate / 100);
    const riskReserve = contract * (riskRate / 100);
    const totalCost = directCost + overhead + auditDeduction + riskReserve;
    const profit = contract - totalCost;
    const profitRate = contract > 0 ? (profit / contract) * 100 : 0;
    return {
      manpower,
      purchase,
      travel,
      directCost,
      overhead,
      auditDeduction,
      riskReserve,
      totalCost,
      contract,
      profit,
      profitRate,
      overheadRate,
      auditDeductionRate: auditRate,
      riskReserveRate: riskRate,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, projectAmountWan]);

  if (loading) {
    return <div className="text-sm text-muted-foreground">加载中...</div>;
  }
  if (loadError) {
    return (
      <div className="space-y-2">
        <div className="text-sm text-destructive">加载预算失败：{loadError}</div>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void fetchAll()}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <BudgetHistoryContext.Provider value={runWithHistory}>
    <div className="space-y-4">
      <BudgetSummary
        summary={summary}
        historyControls={(canCreateItem || canEditItem || canDeleteItem || canManageCategory) ? (
          <div className="flex items-center gap-2" role="group" aria-label="撤销与重做">
            <Button type="button" size="icon" variant="outline" className="size-8" disabled={!undoEntry || historyBusy} onClick={() => void undo()} title={undoEntry ? `撤销：${undoEntry.label}` : "没有可撤销的操作"} aria-label="撤销">
              <Undo2 className="size-3.5" />
            </Button>
            <Button type="button" size="icon" variant="outline" className="size-8" disabled={!redoEntry || historyBusy} onClick={() => void redo()} title={redoEntry ? `重做：${redoEntry.label}` : "没有可重做的操作"} aria-label="重做">
              <Redo2 className="size-3.5" />
            </Button>
          </div>
        ) : null}
      />

      <CategoriesSection
        categories={categories}
        projectId={projectId}
        projectAmountWan={projectAmountWan}
        canCreateItem={canCreateItem}
        canEditItem={canEditItem}
        canDeleteItem={canDeleteItem}
        canManageCategory={canManageCategory}
        onChanged={() => fetchAll(false)}
        confirm={confirm}
      />
    </div>
    </BudgetHistoryContext.Provider>
  );
};

// ================ 预算总览 ================
const BudgetSummary = ({
  summary,
  historyControls,
}: {
  summary: {
    manpower: number;
    purchase: number;
    travel: number;
    directCost: number;
    overhead: number;
    auditDeduction: number;
    riskReserve: number;
    totalCost: number;
    contract: number;
    profit: number;
    profitRate: number;
    overheadRate: number;
    auditDeductionRate: number;
    riskReserveRate: number;
  };
  historyControls?: React.ReactNode;
}) => {
  const kpis = [
    { label: "合同金额", value: formatAmount(summary.contract), tone: "text-slate-900" },
    { label: "人力成本", value: formatAmount(summary.manpower), tone: "text-slate-700" },
    { label: "采购成本", value: formatAmount(summary.purchase), tone: "text-slate-700" },
    { label: "差旅成本", value: formatAmount(summary.travel), tone: "text-slate-700" },
    { label: "公摊成本", value: formatAmount(summary.overhead), tone: "text-slate-700" },
    { label: "审价扣除", value: formatAmount(summary.auditDeduction), tone: "text-slate-700" },
    { label: "风险预留", value: formatAmount(summary.riskReserve), tone: "text-slate-700" },
    { label: "成本总计", value: formatAmount(summary.totalCost), tone: "text-orange-700 font-semibold" },
    { label: "预计利润", value: formatAmount(summary.profit), tone: summary.profit >= 0 ? "text-emerald-700 font-semibold" : "text-red-700 font-semibold" },
    { label: "利润率", value: formatPercent(summary.profitRate), tone: summary.profit >= 0 ? "text-emerald-700 font-semibold" : "text-red-700 font-semibold" },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">预算总览</CardTitle>
          {historyControls}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-5">
          {kpis.map((k) => (
            <div key={k.label} className="rounded-md border border-border bg-muted/20 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">{k.label}</div>
              <div className={`text-base tabular-nums ${k.tone}`}>{k.value}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

const Field = ({
  label,
  required,
  full,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  full?: boolean;
  hint?: string;
  children: React.ReactNode;
}) => (
  <div className={full ? "md:col-span-2" : ""}>
    <label className="mb-1 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
      <span>
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </span>
      {hint && <span className="text-[10px] text-muted-foreground/70">（{hint}）</span>}
    </label>
    {children}
  </div>
);

// ================ 分类区 ================
const CategoriesSection = ({
  categories,
  projectId,
  projectAmountWan,
  canCreateItem,
  canEditItem,
  canDeleteItem,
  canManageCategory,
  onChanged,
  confirm,
}: {
  categories: CategoryWithMeta[];
  projectId: string;
  projectAmountWan: number;
  canCreateItem: boolean;
  canEditItem: boolean;
  canDeleteItem: boolean;
  canManageCategory: boolean;
  onChanged: () => void | Promise<void>;
  confirm: (msg: string) => Promise<boolean>;
}) => {
  const displayCategories = useMemo(
    () => [
      ...categories.filter((cat) => cat.kind !== BudgetCategoryKind.RATE),
      ...categories.filter((cat) => cat.kind === BudgetCategoryKind.RATE),
    ],
    [categories],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-semibold">预算分类与明细</div>
        {canManageCategory && (
          <NewCategoryButton projectId={projectId} onCreated={onChanged} />
        )}
      </div>

      {categories.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-xs text-muted-foreground">
            暂无预算分类，请点击「新增分类」开始建立预算结构
          </CardContent>
        </Card>
      ) : (
        displayCategories.map((cat) => (
          <CategoryCard
            key={cat.id}
            category={cat}
            projectId={projectId}
            projectAmountWan={projectAmountWan}
            canCreateItem={canCreateItem}
            canEditItem={canEditItem}
            canDeleteItem={canDeleteItem}
            canManageCategory={canManageCategory}
            onChanged={onChanged}
            confirm={confirm}
          />
        ))
      )}
    </div>
  );
};

const NewCategoryButton = ({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void | Promise<void>;
}) => {
  const runAction = useContext(BudgetHistoryContext);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BudgetCategoryKind>(BudgetCategoryKind.MANPOWER);
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) {
      alert("分类名称不能为空");
      return;
    }
    setSubmitting(true);
    try {
      const targetIds: string[] = [];
      await runAction(`新增预算分类「${name.trim()}」`, targetIds, async () => {
        const created = await api.post<ProjectBudgetCategory>(`/api/projects/${projectId}/budget-categories`, {
          name: name.trim(),
          kind,
          description: description.trim(),
          sortOrder: Number(sortOrder) || 0,
        });
        targetIds.push(created.id);
      });
      setOpen(false);
      setName("");
      setKind(BudgetCategoryKind.MANPOWER);
      setDescription("");
      setSortOrder("0");
      await onCreated();
    } catch (e) {
      alert(e instanceof Error ? e.message : "新增分类失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setOpen(true)}>
        新增分类
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-md">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">新增预算分类</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Field label="分类名称" required>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-8 text-xs"
                  placeholder="如：硬件人力 / 软件人力 / 采购 / 差旅"
                  autoFocus
                />
              </Field>
              <Field label="分类类型" required>
                <Select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as BudgetCategoryKind)}
                  className="h-8 text-xs"
                >
                  <option value={BudgetCategoryKind.MANPOWER}>人力型（组别+人员+人月+人均月成本）</option>
                  <option value={BudgetCategoryKind.PURCHASE}>采购型（项目+单价+样机数+量产数）</option>
                  <option value={BudgetCategoryKind.OTHER}>差旅型（事项+金额）</option>
                  <option value={BudgetCategoryKind.RATE}>费率型（标题+建议上下限+当前使用，用于公摊/审价/风险等费率参数）</option>
                </Select>
              </Field>
              <Field label="排序">
                <Input
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                  className="h-8 text-xs tabular-nums"
                />
              </Field>
              <Field label="描述" full>
                <Input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="h-8 text-xs"
                  placeholder="可选，描述分类用途"
                />
              </Field>
              <div className="flex justify-end gap-2 pt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => setOpen(false)}
                  disabled={submitting}
                >
                  取消
                </Button>
                <Button size="sm" className="h-7 text-xs" onClick={handleSubmit} disabled={submitting}>
                  {submitting ? "保存中..." : "保存"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
};

const CategoryCard = ({
  category,
  projectId,
  projectAmountWan,
  canCreateItem,
  canEditItem,
  canDeleteItem,
  canManageCategory,
  onChanged,
  confirm,
}: {
  category: CategoryWithMeta;
  projectId: string;
  projectAmountWan: number;
  canCreateItem: boolean;
  canEditItem: boolean;
  canDeleteItem: boolean;
  canManageCategory: boolean;
  onChanged: () => void | Promise<void>;
  confirm: (msg: string) => Promise<boolean>;
}) => {
  const runAction = useContext(BudgetHistoryContext);
  const [editOpen, setEditOpen] = useState(false);
  const subtotal = calcCategorySubtotal(category, (projectAmountWan || 0) * 10000);

  const handleDelete = async () => {
    if (!(await confirm(`确认删除分类「${category.name}」？下挂条目不会被自动删除，请先清理`))) return;
    try {
      await runAction(`删除预算分类「${category.name}」`, [category.id], () => (
        api.delete(`/api/projects/${projectId}/budget-categories/${category.id}`)
      ));
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除分类失败");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-sm">{category.name}</CardTitle>
            <span className={`rounded border px-1.5 py-0.5 text-[10px] ${KIND_BADGE_CLASS[category.kind as BudgetCategoryKind] ?? ""}`}>
              {KIND_LABEL[category.kind as BudgetCategoryKind] ?? category.kind}
            </span>
            {category.description && (
              <span className="text-[11px] text-muted-foreground">{category.description}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right text-xs">
              <div className="text-[10px] text-muted-foreground">分类小计</div>
              <div className="font-semibold tabular-nums">{formatAmount(subtotal)}</div>
            </div>
            {canManageCategory && (
              <>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditOpen(true)}>
                  编辑分类
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-destructive"
                  onClick={handleDelete}
                >
                  删除分类
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {category.kind === BudgetCategoryKind.MANPOWER && (
          <ManpowerTable
            category={category}
            projectId={projectId}
            canCreate={canCreateItem}
            canEdit={canEditItem}
            canDelete={canDeleteItem}
            onChanged={onChanged}
            confirm={confirm}
          />
        )}
        {category.kind === BudgetCategoryKind.PURCHASE && (
          <PurchaseTable
            category={category}
            projectId={projectId}
            canCreate={canCreateItem}
            canEdit={canEditItem}
            canDelete={canDeleteItem}
            onChanged={onChanged}
            confirm={confirm}
          />
        )}
        {category.kind === BudgetCategoryKind.OTHER && (
          <OtherTable
            category={category}
            projectId={projectId}
            canCreate={canCreateItem}
            canEdit={canEditItem}
            canDelete={canDeleteItem}
            onChanged={onChanged}
            confirm={confirm}
          />
        )}
        {category.kind === BudgetCategoryKind.RATE && (
          <RateTable
            category={category}
            projectId={projectId}
            canCreate={canCreateItem}
            canEdit={canEditItem}
            canDelete={canDeleteItem}
            onChanged={onChanged}
            confirm={confirm}
          />
        )}
      </CardContent>
      {editOpen && (
        <EditCategoryDialog
          category={category}
          projectId={projectId}
          onClose={() => setEditOpen(false)}
          onSaved={async () => {
            setEditOpen(false);
            await onChanged();
          }}
        />
      )}
    </Card>
  );
};

const EditCategoryDialog = ({
  category,
  projectId,
  onClose,
  onSaved,
}: {
  category: ProjectBudgetCategory;
  projectId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) => {
  const runAction = useContext(BudgetHistoryContext);
  const [name, setName] = useState(category.name);
  const [kind, setKind] = useState<BudgetCategoryKind>(category.kind as BudgetCategoryKind);
  const [description, setDescription] = useState(category.description);
  const [sortOrder, setSortOrder] = useState(String(category.sortOrder));
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) {
      alert("分类名称不能为空");
      return;
    }
    setSubmitting(true);
    try {
      await runAction(`编辑预算分类「${category.name}」`, [category.id], () => (
        api.put(`/api/projects/${projectId}/budget-categories/${category.id}`, {
          name: name.trim(),
          kind,
          description: description.trim(),
          sortOrder: Number(sortOrder) || 0,
        })
      ));
      await onSaved();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">编辑预算分类</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="分类名称" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-xs" autoFocus />
          </Field>
          <Field label="分类类型" required>
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as BudgetCategoryKind)}
              className="h-8 text-xs"
            >
              <option value={BudgetCategoryKind.MANPOWER}>人力型</option>
              <option value={BudgetCategoryKind.PURCHASE}>采购型</option>
              <option value={BudgetCategoryKind.OTHER}>差旅型</option>
              <option value={BudgetCategoryKind.RATE}>费率型</option>
            </Select>
          </Field>
          <Field label="排序">
            <Input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              className="h-8 text-xs tabular-nums"
            />
          </Field>
          <Field label="描述" full>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="h-8 text-xs"
            />
          </Field>
          <div className="text-[11px] text-muted-foreground">
            注：修改分类类型后，已有条目若字段不匹配将显示为空，但不会被删除。
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={handleSubmit} disabled={submitting}>
              {submitting ? "保存中..." : "保存"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

// ================ 人力型表 ================
type ManpowerDraft = {
  groupName: string;
  person: string;
  personMonths: number;
  monthlyCostPerPerson: number;
  remark: string;
};
const EMPTY_MP: ManpowerDraft = {
  groupName: "",
  person: "",
  personMonths: 0,
  monthlyCostPerPerson: 0,
  remark: "",
};

const ManpowerTable = ({
  category,
  projectId,
  canCreate,
  canEdit,
  canDelete,
  onChanged,
  confirm,
}: {
  category: CategoryWithMeta;
  projectId: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => void | Promise<void>;
  confirm: (msg: string) => Promise<boolean>;
}) => {
  const runAction = useContext(BudgetHistoryContext);
  const [newRow, setNewRow] = useState<ManpowerDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<ManpowerDraft | null>(null);
  const submittingRef = useRef(false);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const { menu, openContextMenu, closeContextMenu } = useTableContextMenu();
  const activeEditRowRef = useRef<HTMLTableRowElement>(null);
  const { actionsFor: structureActionsFor } = useBudgetRowStructure({
    category,
    projectId,
    canCreate,
    canEdit,
    onChanged,
  });

  const startCreate = () => {
    setInvalidFields([]);
    setNewRow({ ...EMPTY_MP });
    setEditingId(null);
    setEditRow(null);
  };
  const cancelCreate = () => {
    setInvalidFields([]);
    setNewRow(null);
  };
  const startEdit = (it: ProjectBudgetItem) => {
    setInvalidFields([]);
    setEditingId(it.id);
    setEditRow({
      groupName: it.groupName,
      person: it.person,
      personMonths: it.personMonths,
      monthlyCostPerPerson: it.monthlyCostPerPerson,
      remark: it.remark,
    });
    setNewRow(null);
  };
  const cancelEdit = () => {
    setInvalidFields([]);
    setEditingId(null);
    setEditRow(null);
  };

  const submitCreate = async () => {
    if (!newRow || submittingRef.current) return;
    const errors = [!newRow.groupName.trim() ? "groupName" : "", !newRow.person.trim() ? "person" : ""].filter(Boolean);
    setInvalidFields(errors);
    if (errors.length > 0) return;
    submittingRef.current = true;
    try {
      const targetIds: string[] = [];
      await runAction(`新增预算条目「${newRow.person}」`, targetIds, async () => {
        const created = await api.post<ProjectBudgetItem>(`/api/projects/${projectId}/budget-items`, {
          categoryId: category.id,
          ...newRow,
        });
        targetIds.push(created.id);
      });
      setNewRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      submittingRef.current = false;
    }
  };

  const submitEdit = async () => {
    if (!editingId || !editRow || submittingRef.current) return;
    const errors = [!editRow.groupName.trim() ? "groupName" : "", !editRow.person.trim() ? "person" : ""].filter(Boolean);
    setInvalidFields(errors);
    if (errors.length > 0) return;
    submittingRef.current = true;
    try {
      await runAction(`编辑预算条目「${editRow.person}」`, [editingId], () => (
        api.put(`/api/projects/${projectId}/budget-items/${editingId}`, {
          categoryId: category.id,
          ...editRow,
        })
      ));
      setEditingId(null);
      setEditRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      submittingRef.current = false;
    }
  };

  useCommitOnOutsidePointer(Boolean(newRow || editingId), activeEditRowRef, () => (
    newRow ? submitCreate() : submitEdit()
  ));

  const handleDelete = async (it: ProjectBudgetItem) => {
    if (!(await confirm(budgetDeleteMessage(it)))) return;
    try {
      await runAction(`删除预算条目「${budgetItemLabel(it)}」`, [it.id], () => (
        api.delete(`/api/projects/${projectId}/budget-items/${it.id}`)
      ));
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  const contextActions = (it?: ProjectBudgetItem): TableContextMenuAction[] => [
    ...(it ? structureActionsFor(it) : []),
    ...(it && canEdit
      ? [{ label: "编辑预算条目", icon: <Pencil className="size-3.5" />, separatorBefore: true, onSelect: () => startEdit(it) }]
      : []),
    ...(it && canDelete
      ? [{ label: "删除预算条目", icon: <Trash2 className="size-3.5" />, destructive: true, separatorBefore: true, onSelect: () => handleDelete(it) }]
      : []),
    ...(!it && canCreate
      ? [{ label: "新增预算条目", icon: <Plus className="size-3.5" />, onSelect: startCreate }]
      : []),
  ];

  return (
    <>
    <Table onContextMenu={(event) => openContextMenu(event, contextActions())}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[60px]">序号</TableHead>
          <TableHead className="w-[160px]">组别</TableHead>
          <TableHead>人员</TableHead>
          <TableHead className="w-[120px]">人月</TableHead>
          <TableHead className="w-[140px]">人均月成本</TableHead>
          <TableHead className="w-[140px] text-right">小计</TableHead>
          <TableHead>备注</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {newRow && (
          <TableRow ref={activeEditRowRef} className="bg-muted/30" onKeyDownCapture={(event) => handleBudgetRowKeyDown(event, cancelCreate)} onBlurCapture={(event) => handleBudgetRowBlur(event, submitCreate)}>
            <TableCell className="p-2 text-xs text-muted-foreground">新</TableCell>
            <TableCell className="p-2">
              <Input
                value={newRow.groupName}
                onChange={(e) => { setInvalidFields((prev) => prev.filter((field) => field !== "groupName")); setNewRow({ ...newRow, groupName: e.target.value }); }}
                className={cn("h-7 text-xs", invalidFields.includes("groupName") && "border-destructive ring-1 ring-destructive/30")}
                autoFocus
                placeholder="组别"
              />
              {invalidFields.includes("groupName") && (
                <p className="mt-1 text-[11px] text-destructive">请填写组别</p>
              )}
            </TableCell>
            <TableCell className="p-2">
              <Input
                value={newRow.person}
                onChange={(e) => { setInvalidFields((prev) => prev.filter((field) => field !== "person")); setNewRow({ ...newRow, person: e.target.value }); }}
                className={cn("h-7 text-xs", invalidFields.includes("person") && "border-destructive ring-1 ring-destructive/30")}
                placeholder="人员"
              />
              {invalidFields.includes("person") && (
                <p className="mt-1 text-[11px] text-destructive">请填写人员</p>
              )}
            </TableCell>
            <TableCell className="p-2">
              <Input
                type="number"
                min={0}
                step={0.1}
                value={newRow.personMonths}
                onChange={(e) => setNewRow({ ...newRow, personMonths: Number(e.target.value) || 0 })}
                className="h-7 text-xs tabular-nums"
              />
            </TableCell>
            <TableCell className="p-2">
              <Input
                type="number"
                min={0}
                step={1}
                value={newRow.monthlyCostPerPerson}
                onChange={(e) =>
                  setNewRow({ ...newRow, monthlyCostPerPerson: Number(e.target.value) || 0 })
                }
                className="h-7 text-xs tabular-nums"
              />
            </TableCell>
            <TableCell className="p-2 text-right text-xs font-medium tabular-nums">
              {formatAmount(newRow.personMonths * newRow.monthlyCostPerPerson)}
            </TableCell>
            <TableCell className="p-2">
              <Input
                value={newRow.remark}
                onChange={(e) => setNewRow({ ...newRow, remark: e.target.value })}
                className="h-7 text-xs"
                placeholder="可选"
              />
            </TableCell>
          </TableRow>
        )}
        {category.items.map((it, idx) => {
          const isEditing = editingId === it.id && editRow;
          const subtotal = it.personMonths * it.monthlyCostPerPerson;
          return (
            <TableRow key={it.id} ref={isEditing ? activeEditRowRef : undefined} data-table-row-id={it.id} className={isEditing ? "bg-muted/30" : undefined} onContextMenu={(event) => openContextMenu(event, contextActions(it), { title: budgetItemLabel(it), description: category.name })} onKeyDownCapture={isEditing ? (event) => handleBudgetRowKeyDown(event, cancelEdit) : undefined} onBlurCapture={isEditing ? (event) => handleBudgetRowBlur(event, submitEdit) : undefined}>
              <TableCell className="p-2 text-xs text-muted-foreground">{idx + 1}</TableCell>
              <TableCell className={isEditing ? "p-2" : "cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <div>
                    <Input
                      value={editRow!.groupName}
                      onChange={(e) => { setInvalidFields((prev) => prev.filter((field) => field !== "groupName")); setEditRow({ ...editRow!, groupName: e.target.value }); }}
                      className={cn("h-7 text-xs", invalidFields.includes("groupName") && "border-destructive ring-1 ring-destructive/30")}
                    />
                    {invalidFields.includes("groupName") && (
                      <p className="mt-1 text-[11px] text-destructive">请填写组别</p>
                    )}
                  </div>
                ) : (
                  it.groupName
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2 font-medium" : "font-medium cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <div>
                    <Input
                      value={editRow!.person}
                      onChange={(e) => { setInvalidFields((prev) => prev.filter((field) => field !== "person")); setEditRow({ ...editRow!, person: e.target.value }); }}
                      className={cn("h-7 text-xs", invalidFields.includes("person") && "border-destructive ring-1 ring-destructive/30")}
                    />
                    {invalidFields.includes("person") && (
                      <p className="mt-1 text-[11px] text-destructive">请填写人员</p>
                    )}
                  </div>
                ) : (
                  it.person
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "tabular-nums cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <Input
                    type="number"
                    min={0}
                    step={0.1}
                    value={editRow!.personMonths}
                    onChange={(e) =>
                      setEditRow({ ...editRow!, personMonths: Number(e.target.value) || 0 })
                    }
                    className="h-7 text-xs tabular-nums"
                  />
                ) : (
                  it.personMonths
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "tabular-nums cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={editRow!.monthlyCostPerPerson}
                    onChange={(e) =>
                      setEditRow({
                        ...editRow!,
                        monthlyCostPerPerson: Number(e.target.value) || 0,
                      })
                    }
                    className="h-7 text-xs tabular-nums"
                  />
                ) : (
                  formatAmount(it.monthlyCostPerPerson)
                )}
              </TableCell>
              <TableCell className="p-2 text-right text-xs font-semibold tabular-nums">
                {formatAmount(isEditing ? editRow!.personMonths * editRow!.monthlyCostPerPerson : subtotal)}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <Input
                    value={editRow!.remark}
                    onChange={(e) => setEditRow({ ...editRow!, remark: e.target.value })}
                    className="h-7 text-xs"
                  />
                ) : (
                  it.remark
                )}
              </TableCell>
            </TableRow>
          );
        })}
        {category.items.length === 0 && !newRow && (
          <TableRow>
            <TableCell colSpan={7} className="h-24 text-center text-xs text-muted-foreground">
              暂无条目，在表格中右击即可新增
            </TableCell>
          </TableRow>
        )}
        {(category.items.length > 0 || newRow) && (
          <TableRow className="bg-muted/50 font-semibold">
            <TableCell colSpan={5} className="p-2 text-xs text-muted-foreground">
              {category.items.length} 条
            </TableCell>
            <TableCell className="p-2 text-right text-xs font-semibold tabular-nums">
              {formatAmount(category.items.reduce((a, it) => a + it.personMonths * it.monthlyCostPerPerson, 0))}
            </TableCell>
            <TableCell className="p-2 text-right">
              {newRow && (
                <TableActionButton onClick={cancelCreate}>
                  取消新增
                </TableActionButton>
              )}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
    <TableContextMenu menu={menu} onClose={closeContextMenu} />
    </>
  );
};

// ================ 采购型表 ================
type PurchaseDraft = {
  title: string;
  unitPrice: number;
  sampleQuantity: number;
  productionQuantity: number;
  remark: string;
};
const EMPTY_PR: PurchaseDraft = {
  title: "",
  unitPrice: 0,
  sampleQuantity: 0,
  productionQuantity: 0,
  remark: "",
};

const PurchaseTable = ({
  category,
  projectId,
  canCreate,
  canEdit,
  canDelete,
  onChanged,
  confirm,
}: {
  category: CategoryWithMeta;
  projectId: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => void | Promise<void>;
  confirm: (msg: string) => Promise<boolean>;
}) => {
  const runAction = useContext(BudgetHistoryContext);
  const [newRow, setNewRow] = useState<PurchaseDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<PurchaseDraft | null>(null);
  const submittingRef = useRef(false);
  const [titleInvalid, setTitleInvalid] = useState(false);
  const { menu, openContextMenu, closeContextMenu } = useTableContextMenu();
  const activeEditRowRef = useRef<HTMLTableRowElement>(null);
  const { actionsFor: structureActionsFor } = useBudgetRowStructure({
    category,
    projectId,
    canCreate,
    canEdit,
    onChanged,
  });

  const startCreate = () => {
    setTitleInvalid(false);
    setNewRow({ ...EMPTY_PR });
    setEditingId(null);
    setEditRow(null);
  };
  const cancelCreate = () => {
    setTitleInvalid(false);
    setNewRow(null);
  };
  const startEdit = (it: ProjectBudgetItem) => {
    setTitleInvalid(false);
    setEditingId(it.id);
    setEditRow({
      title: it.title,
      unitPrice: it.unitPrice,
      sampleQuantity: it.sampleQuantity,
      productionQuantity: it.productionQuantity,
      remark: it.remark,
    });
    setNewRow(null);
  };
  const cancelEdit = () => {
    setTitleInvalid(false);
    setEditingId(null);
    setEditRow(null);
  };

  const submitCreate = async () => {
    if (!newRow || submittingRef.current) return;
    if (!newRow.title.trim()) {
      setTitleInvalid(true);
      return;
    }
    submittingRef.current = true;
    try {
      const targetIds: string[] = [];
      await runAction(`新增预算条目「${newRow.title}」`, targetIds, async () => {
        const created = await api.post<ProjectBudgetItem>(`/api/projects/${projectId}/budget-items`, {
          categoryId: category.id,
          ...newRow,
        });
        targetIds.push(created.id);
      });
      setNewRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      submittingRef.current = false;
    }
  };

  const submitEdit = async () => {
    if (!editingId || !editRow || submittingRef.current) return;
    if (!editRow.title.trim()) {
      setTitleInvalid(true);
      return;
    }
    submittingRef.current = true;
    try {
      await runAction(`编辑预算条目「${editRow.title}」`, [editingId], () => (
        api.put(`/api/projects/${projectId}/budget-items/${editingId}`, {
          categoryId: category.id,
          ...editRow,
        })
      ));
      setEditingId(null);
      setEditRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      submittingRef.current = false;
    }
  };

  useCommitOnOutsidePointer(Boolean(newRow || editingId), activeEditRowRef, () => (
    newRow ? submitCreate() : submitEdit()
  ));

  const handleDelete = async (it: ProjectBudgetItem) => {
    if (!(await confirm(budgetDeleteMessage(it)))) return;
    try {
      await runAction(`删除预算条目「${budgetItemLabel(it)}」`, [it.id], () => (
        api.delete(`/api/projects/${projectId}/budget-items/${it.id}`)
      ));
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  const contextActions = (it?: ProjectBudgetItem): TableContextMenuAction[] => [
    ...(it ? structureActionsFor(it) : []),
    ...(it && canEdit
      ? [{ label: "编辑预算条目", icon: <Pencil className="size-3.5" />, separatorBefore: true, onSelect: () => startEdit(it) }]
      : []),
    ...(it && canDelete
      ? [{ label: "删除预算条目", icon: <Trash2 className="size-3.5" />, destructive: true, separatorBefore: true, onSelect: () => handleDelete(it) }]
      : []),
    ...(!it && canCreate
      ? [{ label: "新增预算条目", icon: <Plus className="size-3.5" />, onSelect: startCreate }]
      : []),
  ];

  return (
    <>
    <Table onContextMenu={(event) => openContextMenu(event, contextActions())}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[60px]">序号</TableHead>
          <TableHead>项目/物料名称</TableHead>
          <TableHead className="w-[120px]">单价</TableHead>
          <TableHead className="w-[100px]">样机数量</TableHead>
          <TableHead className="w-[120px] text-right">样机小计</TableHead>
          <TableHead className="w-[100px]">量产数量</TableHead>
          <TableHead className="w-[140px] text-right">量产小计</TableHead>
          <TableHead className="w-[140px] text-right">合计</TableHead>
          <TableHead>备注</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {newRow && (
          <TableRow ref={activeEditRowRef} className="bg-muted/30" onKeyDownCapture={(event) => handleBudgetRowKeyDown(event, cancelCreate)} onBlurCapture={(event) => handleBudgetRowBlur(event, submitCreate)}>
            <TableCell className="p-2 text-xs text-muted-foreground">新</TableCell>
            <TableCell className="p-2">
              <Input
                value={newRow.title}
                onChange={(e) => { setTitleInvalid(false); setNewRow({ ...newRow, title: e.target.value }); }}
                className={cn("h-7 text-xs", titleInvalid && "border-destructive ring-1 ring-destructive/30")}
                autoFocus
              />
              {titleInvalid && (
                <p className="mt-1 text-[11px] text-destructive">请填写项目或物料名称</p>
              )}
            </TableCell>
            <TableCell className="p-2">
              <Input
                type="number"
                min={0}
                step={1}
                value={newRow.unitPrice}
                onChange={(e) => setNewRow({ ...newRow, unitPrice: Number(e.target.value) || 0 })}
                className="h-7 text-xs tabular-nums"
              />
            </TableCell>
            <TableCell className="p-2">
              <Input
                type="number"
                min={0}
                step={1}
                value={newRow.sampleQuantity}
                onChange={(e) => setNewRow({ ...newRow, sampleQuantity: Number(e.target.value) || 0 })}
                className="h-7 text-xs tabular-nums"
              />
            </TableCell>
            <TableCell className="p-2 text-right text-xs tabular-nums">
              {formatAmount(newRow.unitPrice * newRow.sampleQuantity)}
            </TableCell>
            <TableCell className="p-2">
              <Input
                type="number"
                min={0}
                step={1}
                value={newRow.productionQuantity}
                onChange={(e) => setNewRow({ ...newRow, productionQuantity: Number(e.target.value) || 0 })}
                className="h-7 text-xs tabular-nums"
              />
            </TableCell>
            <TableCell className="p-2 text-right text-xs tabular-nums">
              {formatAmount(newRow.unitPrice * newRow.productionQuantity)}
            </TableCell>
            <TableCell className="p-2 text-right text-xs font-medium tabular-nums">
              {formatAmount(newRow.unitPrice * (newRow.sampleQuantity + newRow.productionQuantity))}
            </TableCell>
            <TableCell className="p-2">
              <Input
                value={newRow.remark}
                onChange={(e) => setNewRow({ ...newRow, remark: e.target.value })}
                className="h-7 text-xs"
                placeholder="可选"
              />
            </TableCell>
          </TableRow>
        )}
        {category.items.map((it, idx) => {
          const isEditing = editingId === it.id && editRow;
          const sample = it.unitPrice * it.sampleQuantity;
          const production = it.unitPrice * it.productionQuantity;
          const total = sample + production;
          return (
            <TableRow key={it.id} ref={isEditing ? activeEditRowRef : undefined} data-table-row-id={it.id} className={isEditing ? "bg-muted/30" : undefined} onContextMenu={(event) => openContextMenu(event, contextActions(it), { title: budgetItemLabel(it), description: category.name })} onKeyDownCapture={isEditing ? (event) => handleBudgetRowKeyDown(event, cancelEdit) : undefined} onBlurCapture={isEditing ? (event) => handleBudgetRowBlur(event, submitEdit) : undefined}>
              <TableCell className="p-2 text-xs text-muted-foreground">{idx + 1}</TableCell>
              <TableCell className={isEditing ? "p-2" : "font-medium cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <div>
                    <Input
                      value={editRow!.title}
                      onChange={(e) => { setTitleInvalid(false); setEditRow({ ...editRow!, title: e.target.value }); }}
                      className={cn("h-7 text-xs", titleInvalid && "border-destructive ring-1 ring-destructive/30")}
                    />
                    {titleInvalid && (
                      <p className="mt-1 text-[11px] text-destructive">请填写项目或物料名称</p>
                    )}
                  </div>
                ) : (
                  it.title
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "tabular-nums cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={editRow!.unitPrice}
                    onChange={(e) => setEditRow({ ...editRow!, unitPrice: Number(e.target.value) || 0 })}
                    className="h-7 text-xs tabular-nums"
                  />
                ) : (
                  formatAmount(it.unitPrice)
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "tabular-nums cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={editRow!.sampleQuantity}
                    onChange={(e) =>
                      setEditRow({ ...editRow!, sampleQuantity: Number(e.target.value) || 0 })
                    }
                    className="h-7 text-xs tabular-nums"
                  />
                ) : (
                  it.sampleQuantity
                )}
              </TableCell>
              <TableCell className="p-2 text-right text-xs tabular-nums">
                {formatAmount(isEditing ? editRow!.unitPrice * editRow!.sampleQuantity : sample)}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "tabular-nums cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={editRow!.productionQuantity}
                    onChange={(e) =>
                      setEditRow({
                        ...editRow!,
                        productionQuantity: Number(e.target.value) || 0,
                      })
                    }
                    className="h-7 text-xs tabular-nums"
                  />
                ) : (
                  it.productionQuantity
                )}
              </TableCell>
              <TableCell className="p-2 text-right text-xs tabular-nums">
                {formatAmount(
                  isEditing ? editRow!.unitPrice * editRow!.productionQuantity : production,
                )}
              </TableCell>
              <TableCell className="p-2 text-right text-xs font-semibold tabular-nums">
                {formatAmount(
                  isEditing
                    ? editRow!.unitPrice * (editRow!.sampleQuantity + editRow!.productionQuantity)
                    : total,
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <Input
                    value={editRow!.remark}
                    onChange={(e) => setEditRow({ ...editRow!, remark: e.target.value })}
                    className="h-7 text-xs"
                  />
                ) : (
                  it.remark
                )}
              </TableCell>
            </TableRow>
          );
        })}
        {category.items.length === 0 && !newRow && (
          <TableRow>
            <TableCell colSpan={9} className="h-24 text-center text-xs text-muted-foreground">
              暂无条目，在表格中右击即可新增
            </TableCell>
          </TableRow>
        )}
        {(category.items.length > 0 || newRow) && (
          <TableRow className="bg-muted/50 font-semibold">
            <TableCell colSpan={4} className="p-2 text-xs text-muted-foreground">
              {category.items.length} 条
            </TableCell>
            <TableCell className="p-2 text-right text-xs tabular-nums">
              {formatAmount(category.items.reduce((a, it) => a + it.unitPrice * it.sampleQuantity, 0))}
            </TableCell>
            <TableCell className="p-2"></TableCell>
            <TableCell className="p-2 text-right text-xs tabular-nums">
              {formatAmount(category.items.reduce((a, it) => a + it.unitPrice * it.productionQuantity, 0))}
            </TableCell>
            <TableCell className="p-2 text-right text-xs font-semibold tabular-nums">
              {formatAmount(category.items.reduce((a, it) => a + it.unitPrice * (it.sampleQuantity + it.productionQuantity), 0))}
            </TableCell>
            <TableCell className="p-2 text-right">
              {newRow && (
                <TableActionButton onClick={cancelCreate}>
                  取消新增
                </TableActionButton>
              )}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
    <TableContextMenu menu={menu} onClose={closeContextMenu} />
    </>
  );
};

// ================ 差旅型表 ================
type OtherDraft = {
  title: string;
  amount: number;
  remark: string;
};
const EMPTY_OT: OtherDraft = { title: "", amount: 0, remark: "" };

const OtherTable = ({
  category,
  projectId,
  canCreate,
  canEdit,
  canDelete,
  onChanged,
  confirm,
}: {
  category: CategoryWithMeta;
  projectId: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => void | Promise<void>;
  confirm: (msg: string) => Promise<boolean>;
}) => {
  const runAction = useContext(BudgetHistoryContext);
  const [newRow, setNewRow] = useState<OtherDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<OtherDraft | null>(null);
  const submittingRef = useRef(false);
  const [titleInvalid, setTitleInvalid] = useState(false);
  const { menu, openContextMenu, closeContextMenu } = useTableContextMenu();
  const activeEditRowRef = useRef<HTMLTableRowElement>(null);
  const { actionsFor: structureActionsFor } = useBudgetRowStructure({
    category,
    projectId,
    canCreate,
    canEdit,
    onChanged,
  });

  const startCreate = () => {
    setTitleInvalid(false);
    setNewRow({ ...EMPTY_OT });
    setEditingId(null);
    setEditRow(null);
  };
  const cancelCreate = () => {
    setTitleInvalid(false);
    setNewRow(null);
  };
  const startEdit = (it: ProjectBudgetItem) => {
    setTitleInvalid(false);
    setEditingId(it.id);
    setEditRow({ title: it.title, amount: it.amount, remark: it.remark });
    setNewRow(null);
  };
  const cancelEdit = () => {
    setTitleInvalid(false);
    setEditingId(null);
    setEditRow(null);
  };

  const submitCreate = async () => {
    if (!newRow || submittingRef.current) return;
    if (!newRow.title.trim()) {
      setTitleInvalid(true);
      return;
    }
    submittingRef.current = true;
    try {
      const targetIds: string[] = [];
      await runAction(`新增预算条目「${newRow.title}」`, targetIds, async () => {
        const created = await api.post<ProjectBudgetItem>(`/api/projects/${projectId}/budget-items`, {
          categoryId: category.id,
          ...newRow,
        });
        targetIds.push(created.id);
      });
      setNewRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      submittingRef.current = false;
    }
  };

  const submitEdit = async () => {
    if (!editingId || !editRow || submittingRef.current) return;
    if (!editRow.title.trim()) {
      setTitleInvalid(true);
      return;
    }
    submittingRef.current = true;
    try {
      await runAction(`编辑预算条目「${editRow.title}」`, [editingId], () => (
        api.put(`/api/projects/${projectId}/budget-items/${editingId}`, {
          categoryId: category.id,
          ...editRow,
        })
      ));
      setEditingId(null);
      setEditRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      submittingRef.current = false;
    }
  };

  useCommitOnOutsidePointer(Boolean(newRow || editingId), activeEditRowRef, () => (
    newRow ? submitCreate() : submitEdit()
  ));

  const handleDelete = async (it: ProjectBudgetItem) => {
    if (!(await confirm(budgetDeleteMessage(it)))) return;
    try {
      await runAction(`删除预算条目「${budgetItemLabel(it)}」`, [it.id], () => (
        api.delete(`/api/projects/${projectId}/budget-items/${it.id}`)
      ));
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  const contextActions = (it?: ProjectBudgetItem): TableContextMenuAction[] => [
    ...(it ? structureActionsFor(it) : []),
    ...(it && canEdit
      ? [{ label: "编辑预算条目", icon: <Pencil className="size-3.5" />, separatorBefore: true, onSelect: () => startEdit(it) }]
      : []),
    ...(it && canDelete
      ? [{ label: "删除预算条目", icon: <Trash2 className="size-3.5" />, destructive: true, separatorBefore: true, onSelect: () => handleDelete(it) }]
      : []),
    ...(!it && canCreate
      ? [{ label: "新增预算条目", icon: <Plus className="size-3.5" />, onSelect: startCreate }]
      : []),
  ];

  return (
    <>
    <Table onContextMenu={(event) => openContextMenu(event, contextActions())}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[60px]">序号</TableHead>
          <TableHead>差旅事项</TableHead>
          <TableHead className="w-[180px] text-right">金额</TableHead>
          <TableHead>备注</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {newRow && (
          <TableRow ref={activeEditRowRef} className="bg-muted/30" onKeyDownCapture={(event) => handleBudgetRowKeyDown(event, cancelCreate)} onBlurCapture={(event) => handleBudgetRowBlur(event, submitCreate)}>
            <TableCell className="p-2 text-xs text-muted-foreground">新</TableCell>
            <TableCell className="p-2">
              <Input
                value={newRow.title}
                onChange={(e) => { setTitleInvalid(false); setNewRow({ ...newRow, title: e.target.value }); }}
                className={cn("h-7 text-xs", titleInvalid && "border-destructive ring-1 ring-destructive/30")}
                autoFocus
                placeholder="差旅事项"
              />
              {titleInvalid && (
                <p className="mt-1 text-[11px] text-destructive">请填写差旅事项</p>
              )}
            </TableCell>
            <TableCell className="p-2">
              <Input
                type="number"
                min={0}
                step={1}
                value={newRow.amount}
                onChange={(e) => setNewRow({ ...newRow, amount: Number(e.target.value) || 0 })}
                className="h-7 text-xs tabular-nums text-right"
              />
            </TableCell>
            <TableCell className="p-2">
              <Input
                value={newRow.remark}
                onChange={(e) => setNewRow({ ...newRow, remark: e.target.value })}
                className="h-7 text-xs"
                placeholder="可选"
              />
            </TableCell>
          </TableRow>
        )}
        {category.items.map((it, idx) => {
          const isEditing = editingId === it.id && editRow;
          return (
            <TableRow key={it.id} ref={isEditing ? activeEditRowRef : undefined} data-table-row-id={it.id} className={isEditing ? "bg-muted/30" : undefined} onContextMenu={(event) => openContextMenu(event, contextActions(it), { title: budgetItemLabel(it), description: category.name })} onKeyDownCapture={isEditing ? (event) => handleBudgetRowKeyDown(event, cancelEdit) : undefined} onBlurCapture={isEditing ? (event) => handleBudgetRowBlur(event, submitEdit) : undefined}>
              <TableCell className="p-2 text-xs text-muted-foreground">{idx + 1}</TableCell>
              <TableCell className={isEditing ? "p-2" : "font-medium cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <div>
                    <Input
                      value={editRow!.title}
                      onChange={(e) => { setTitleInvalid(false); setEditRow({ ...editRow!, title: e.target.value }); }}
                      className={cn("h-7 text-xs", titleInvalid && "border-destructive ring-1 ring-destructive/30")}
                    />
                    {titleInvalid && (
                      <p className="mt-1 text-[11px] text-destructive">请填写差旅事项</p>
                    )}
                  </div>
                ) : (
                  it.title
                )}
              </TableCell>
              <TableCell className="p-2 text-right text-xs font-semibold tabular-nums cursor-pointer hover:bg-primary/5" onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={editRow!.amount}
                    onChange={(e) => setEditRow({ ...editRow!, amount: Number(e.target.value) || 0 })}
                    className="h-7 text-xs tabular-nums text-right"
                  />
                ) : (
                  formatAmount(it.amount)
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <Input
                    value={editRow!.remark}
                    onChange={(e) => setEditRow({ ...editRow!, remark: e.target.value })}
                    className="h-7 text-xs"
                  />
                ) : (
                  it.remark
                )}
              </TableCell>
            </TableRow>
          );
        })}
        {category.items.length === 0 && !newRow && (
          <TableRow>
            <TableCell colSpan={4} className="h-24 text-center text-xs text-muted-foreground">
              暂无差旅事项，在表格中右击即可新增
            </TableCell>
          </TableRow>
        )}
        {(category.items.length > 0 || newRow) && (
          <TableRow className="bg-muted/50 font-semibold">
            <TableCell colSpan={2} className="p-2 text-xs text-muted-foreground">
              {category.items.length} 项
            </TableCell>
            <TableCell className="p-2 text-right text-xs font-semibold tabular-nums">
              {formatAmount(category.items.reduce((a, it) => a + it.amount, 0))}
            </TableCell>
            <TableCell className="p-2 text-right">
              {newRow && (
                <TableActionButton onClick={cancelCreate}>
                  取消新增
                </TableActionButton>
              )}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
    <TableContextMenu menu={menu} onClose={closeContextMenu} />
    </>
  );
};

// ================ 费率型表 ================
type RateDraft = {
  title: string;
  minRate: number;
  maxRate: number;
  currentRate: number;
  remark: string;
};
const RateTable = ({
  category,
  projectId,
  canCreate,
  canEdit,
  canDelete,
  onChanged,
  confirm,
}: {
  category: CategoryWithMeta;
  projectId: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => void | Promise<void>;
  confirm: (msg: string) => Promise<boolean>;
}) => {
  const runAction = useContext(BudgetHistoryContext);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<RateDraft | null>(null);
  const submittingRef = useRef(false);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const { menu, openContextMenu, closeContextMenu } = useTableContextMenu();
  const activeEditRowRef = useRef<HTMLTableRowElement>(null);
  const { actionsFor: structureActionsFor } = useBudgetRowStructure({
    category,
    projectId,
    canCreate,
    canEdit,
    onChanged,
  });

  const startEdit = (it: ProjectBudgetItem) => {
    setInvalidFields([]);
    setEditingId(it.id);
    setEditRow({
      title: it.title,
      minRate: it.minRate,
      maxRate: it.maxRate,
      currentRate: it.currentRate,
      remark: it.remark,
    });
  };
  const cancelEdit = () => {
    setInvalidFields([]);
    setEditingId(null);
    setEditRow(null);
  };

  const submitEdit = async () => {
    if (!editingId || !editRow || submittingRef.current) return;
    if (!editRow.title.trim()) {
      setInvalidFields(["title"]);
      return;
    }
    if (editRow.minRate > editRow.maxRate) {
      setInvalidFields(["minRate", "maxRate"]);
      return;
    }
    submittingRef.current = true;
    try {
      await runAction(`编辑费率「${editRow.title}」`, [editingId], () => (
        api.put(`/api/projects/${projectId}/budget-items/${editingId}`, {
          categoryId: category.id,
          ...editRow,
        })
      ));
      setEditingId(null);
      setEditRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      submittingRef.current = false;
    }
  };

  useCommitOnOutsidePointer(Boolean(editingId), activeEditRowRef, submitEdit);

  const handleDelete = async (it: ProjectBudgetItem) => {
    if (!(await confirm(budgetDeleteMessage(it)))) return;
    try {
      await runAction(`删除费率「${budgetItemLabel(it)}」`, [it.id], () => (
        api.delete(`/api/projects/${projectId}/budget-items/${it.id}`)
      ));
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  const contextActions = (it?: ProjectBudgetItem): TableContextMenuAction[] => it
    ? [
        ...structureActionsFor(it),
        ...(canEdit ? [{ label: "编辑费率", icon: <Pencil className="size-3.5" />, separatorBefore: true, onSelect: () => startEdit(it) }] : []),
        ...(canDelete ? [{ label: "删除费率", icon: <Trash2 className="size-3.5" />, destructive: true, separatorBefore: true, onSelect: () => handleDelete(it) }] : []),
      ]
    : [];

  return (
    <>
    <Table className="table-fixed" onContextMenu={(event) => openContextMenu(event, contextActions())}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[60px]">序号</TableHead>
          <TableHead className="w-[220px]">费率名称</TableHead>
          <TableHead className="w-[140px] text-right">建议下限</TableHead>
          <TableHead className="w-[140px] text-right">建议上限</TableHead>
          <TableHead className="w-[140px] text-right">当前使用</TableHead>
          <TableHead>备注</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {category.items.map((it, idx) => {
          const isEditing = editingId === it.id && editRow;
          const outOfRange = it.currentRate < it.minRate || it.currentRate > it.maxRate;
          return (
            <TableRow key={it.id} ref={isEditing ? activeEditRowRef : undefined} data-table-row-id={it.id} className={isEditing ? "bg-muted/30" : undefined} onContextMenu={(event) => openContextMenu(event, contextActions(it), { title: budgetItemLabel(it), description: category.name })} onKeyDownCapture={isEditing ? (event) => handleBudgetRowKeyDown(event, cancelEdit) : undefined} onBlurCapture={isEditing ? (event) => handleBudgetRowBlur(event, submitEdit) : undefined}>
              <TableCell className="p-2 text-xs text-muted-foreground">{idx + 1}</TableCell>
              <TableCell className={isEditing ? "p-2" : "font-medium cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <div>
                    <Input
                      value={editRow!.title}
                      onChange={(e) => { setInvalidFields((prev) => prev.filter((field) => field !== "title")); setEditRow({ ...editRow!, title: e.target.value }); }}
                      className={cn("h-7 text-xs", invalidFields.includes("title") && "border-destructive ring-1 ring-destructive/30")}
                    />
                    {invalidFields.includes("title") && (
                      <p className="mt-1 text-[11px] text-destructive">请填写费率名称</p>
                    )}
                  </div>
                ) : (
                  it.title
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "text-right text-xs tabular-nums cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <div>
                    <Input
                      type="number"
                      min={0}
                      step={0.01}
                      value={editRow!.minRate}
                      onChange={(e) => { setInvalidFields((prev) => prev.filter((field) => field !== "minRate" && field !== "maxRate")); setEditRow({ ...editRow!, minRate: Number(e.target.value) || 0 }); }}
                      className={cn("h-7 text-xs tabular-nums text-right", invalidFields.includes("minRate") && "border-destructive ring-1 ring-destructive/30")}
                    />
                    {invalidFields.includes("minRate") && (
                      <p className="mt-1 text-right text-[11px] text-destructive">下限不能大于上限</p>
                    )}
                  </div>
                ) : (
                  formatPercent(it.minRate)
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "text-right text-xs tabular-nums cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <div>
                    <Input
                      type="number"
                      min={0}
                      step={0.01}
                      value={editRow!.maxRate}
                      onChange={(e) => { setInvalidFields((prev) => prev.filter((field) => field !== "minRate" && field !== "maxRate")); setEditRow({ ...editRow!, maxRate: Number(e.target.value) || 0 }); }}
                      className={cn("h-7 text-xs tabular-nums text-right", invalidFields.includes("maxRate") && "border-destructive ring-1 ring-destructive/30")}
                    />
                  </div>
                ) : (
                  formatPercent(it.maxRate)
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "text-right text-xs font-semibold tabular-nums cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={editRow!.currentRate}
                    onChange={(e) => setEditRow({ ...editRow!, currentRate: Number(e.target.value) || 0 })}
                    className={`h-7 text-xs tabular-nums text-right ${
                      editRow!.currentRate < editRow!.minRate || editRow!.currentRate > editRow!.maxRate
                        ? "border-red-400 focus-visible:ring-red-300"
                        : ""
                    }`}
                  />
                ) : (
                  <span className={outOfRange ? "text-red-600" : ""}>{formatPercent(it.currentRate)}</span>
                )}
                {!isEditing && outOfRange && (
                  <div className="text-[10px] text-red-600">超出建议范围</div>
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "text-xs text-muted-foreground cursor-pointer hover:bg-primary/5"} onClick={() => !isEditing && canEdit && startEdit(it)}>
                {isEditing ? (
                  <Input
                    value={editRow!.remark}
                    onChange={(e) => setEditRow({ ...editRow!, remark: e.target.value })}
                    className="h-7 text-xs"
                  />
                ) : (
                  it.remark || "-"
                )}
              </TableCell>
            </TableRow>
          );
        })}
        {category.items.length === 0 && (
          <TableRow>
            <TableCell colSpan={6} className="h-24 text-center text-xs text-muted-foreground">
              暂无档位条目
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
    <TableContextMenu menu={menu} onClose={closeContextMenu} />
    </>
  );
};
