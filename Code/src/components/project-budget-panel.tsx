"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

interface ProjectBudgetPanelProps {
  projectId: string;
  projectStatus: ProjectStatus;
  projectAmountWan: number;
}

type CategoryWithMeta = ProjectBudgetCategory & {
  items: ProjectBudgetItem[];
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

  const fetchAll = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void Promise.resolve().then(fetchAll);
  }, [fetchAll]);

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
    <div className="space-y-4">
      <BudgetSummary summary={summary} />

      <CategoriesSection
        categories={categories}
        projectId={projectId}
        projectAmountWan={projectAmountWan}
        canCreateItem={canCreateItem}
        canEditItem={canEditItem}
        canDeleteItem={canDeleteItem}
        canManageCategory={canManageCategory}
        onChanged={() => void fetchAll()}
        confirm={confirm}
      />
    </div>
  );
};

// ================ 预算总览 ================
const BudgetSummary = ({
  summary,
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
        <CardTitle className="text-sm">预算总览</CardTitle>
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
      await api.post(`/api/projects/${projectId}/budget-categories`, {
        name: name.trim(),
        kind,
        description: description.trim(),
        sortOrder: Number(sortOrder) || 0,
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
  const [editOpen, setEditOpen] = useState(false);
  const subtotal = calcCategorySubtotal(category, (projectAmountWan || 0) * 10000);
  const isRateCategory = category.kind === BudgetCategoryKind.RATE;

  const handleDelete = async () => {
    if (!(await confirm(`确认删除分类「${category.name}」？下挂条目不会被自动删除，请先清理`))) return;
    try {
      await api.delete(`/api/projects/${projectId}/budget-categories/${category.id}`);
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
            {canManageCategory && !isRateCategory && (
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
      await api.put(`/api/projects/${projectId}/budget-categories/${category.id}`, {
        name: name.trim(),
        kind,
        description: description.trim(),
        sortOrder: Number(sortOrder) || 0,
      });
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
  const [newRow, setNewRow] = useState<ManpowerDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<ManpowerDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const startCreate = () => {
    setNewRow({ ...EMPTY_MP });
    setEditingId(null);
    setEditRow(null);
  };
  const cancelCreate = () => setNewRow(null);
  const startEdit = (it: ProjectBudgetItem) => {
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
    setEditingId(null);
    setEditRow(null);
  };

  const submitCreate = async () => {
    if (!newRow) return;
    if (!newRow.groupName.trim() || !newRow.person.trim()) {
      alert("组别与人员不能为空");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/budget-items`, {
        categoryId: category.id,
        ...newRow,
      });
      setNewRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async () => {
    if (!editingId || !editRow) return;
    if (!editRow.groupName.trim() || !editRow.person.trim()) {
      alert("组别与人员不能为空");
      return;
    }
    setBusy(true);
    try {
      await api.put(`/api/projects/${projectId}/budget-items/${editingId}`, {
        categoryId: category.id,
        ...editRow,
      });
      setEditingId(null);
      setEditRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (it: ProjectBudgetItem) => {
    if (!(await confirm(`确认删除「${it.person}（${it.groupName}）」？`))) return;
    try {
      await api.delete(`/api/projects/${projectId}/budget-items/${it.id}`);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[60px]">序号</TableHead>
          <TableHead className="w-[160px]">组别</TableHead>
          <TableHead>人员</TableHead>
          <TableHead className="w-[120px]">人月</TableHead>
          <TableHead className="w-[140px]">人均月成本</TableHead>
          <TableHead className="w-[140px] text-right">小计</TableHead>
          <TableHead>备注</TableHead>
          <TableHead className="w-[180px]">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {newRow && (
          <TableRow className="bg-muted/30">
            <TableCell className="p-2 text-xs text-muted-foreground">新</TableCell>
            <TableCell className="p-2">
              <Input
                value={newRow.groupName}
                onChange={(e) => setNewRow({ ...newRow, groupName: e.target.value })}
                className="h-7 text-xs"
                autoFocus
                placeholder="组别"
              />
            </TableCell>
            <TableCell className="p-2">
              <Input
                value={newRow.person}
                onChange={(e) => setNewRow({ ...newRow, person: e.target.value })}
                className="h-7 text-xs"
                placeholder="人员"
              />
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
            <TableCell className="p-2">
              <div className="flex items-center gap-1.5">
                <Button size="sm" className="h-7 text-xs" onClick={submitCreate} disabled={busy}>
                  保存
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={cancelCreate} disabled={busy}>
                  取消
                </Button>
              </div>
            </TableCell>
          </TableRow>
        )}
        {category.items.map((it, idx) => {
          const isEditing = editingId === it.id && editRow;
          const subtotal = it.personMonths * it.monthlyCostPerPerson;
          return (
            <TableRow key={it.id} className={isEditing ? "bg-muted/30" : undefined}>
              <TableCell className="p-2 text-xs text-muted-foreground">{idx + 1}</TableCell>
              <TableCell className={isEditing ? "p-2" : undefined}>
                {isEditing ? (
                  <Input
                    value={editRow!.groupName}
                    onChange={(e) => setEditRow({ ...editRow!, groupName: e.target.value })}
                    className="h-7 text-xs"
                  />
                ) : (
                  it.groupName
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2 font-medium" : "font-medium"}>
                {isEditing ? (
                  <Input
                    value={editRow!.person}
                    onChange={(e) => setEditRow({ ...editRow!, person: e.target.value })}
                    className="h-7 text-xs"
                  />
                ) : (
                  it.person
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "tabular-nums"}>
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
              <TableCell className={isEditing ? "p-2" : "tabular-nums"}>
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
              <TableCell className={isEditing ? "p-2" : undefined}>
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
              <TableCell className="p-2">
                {isEditing ? (
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" className="h-7 text-xs" onClick={submitEdit} disabled={busy}>
                      保存
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={cancelEdit}
                      disabled={busy}
                    >
                      取消
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {canEdit && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => startEdit(it)}>
                        编辑
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive"
                        onClick={() => handleDelete(it)}
                      >
                        删除
                      </Button>
                    )}
                    {!canEdit && !canDelete && (
                      <span className="text-xs text-muted-foreground">只读</span>
                    )}
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
        {category.items.length === 0 && !newRow && (
          <TableRow>
            <TableCell colSpan={8} className="h-24 text-center text-xs text-muted-foreground">
              暂无条目
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
            <TableCell colSpan={2} className="p-2 text-right">
              {canCreate && !newRow && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={startCreate}>
                  新增条目
                </Button>
              )}
              {newRow && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={cancelCreate}>
                  取消新增
                </Button>
              )}
            </TableCell>
          </TableRow>
        )}
        {category.items.length === 0 && !newRow && canCreate && (
          <TableRow>
            <TableCell colSpan={8} className="p-2 text-center">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={startCreate}>
                新增条目
              </Button>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
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
  const [newRow, setNewRow] = useState<PurchaseDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<PurchaseDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const startCreate = () => {
    setNewRow({ ...EMPTY_PR });
    setEditingId(null);
    setEditRow(null);
  };
  const cancelCreate = () => setNewRow(null);
  const startEdit = (it: ProjectBudgetItem) => {
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
    setEditingId(null);
    setEditRow(null);
  };

  const submitCreate = async () => {
    if (!newRow) return;
    if (!newRow.title.trim()) {
      alert("项目/物料名称不能为空");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/budget-items`, {
        categoryId: category.id,
        ...newRow,
      });
      setNewRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async () => {
    if (!editingId || !editRow) return;
    if (!editRow.title.trim()) {
      alert("项目/物料名称不能为空");
      return;
    }
    setBusy(true);
    try {
      await api.put(`/api/projects/${projectId}/budget-items/${editingId}`, {
        categoryId: category.id,
        ...editRow,
      });
      setEditingId(null);
      setEditRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (it: ProjectBudgetItem) => {
    if (!(await confirm(`确认删除「${it.title}」？`))) return;
    try {
      await api.delete(`/api/projects/${projectId}/budget-items/${it.id}`);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <Table>
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
          <TableHead className="w-[180px]">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {newRow && (
          <TableRow className="bg-muted/30">
            <TableCell className="p-2 text-xs text-muted-foreground">新</TableCell>
            <TableCell className="p-2">
              <Input
                value={newRow.title}
                onChange={(e) => setNewRow({ ...newRow, title: e.target.value })}
                className="h-7 text-xs"
                autoFocus
              />
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
            <TableCell className="p-2">
              <div className="flex items-center gap-1.5">
                <Button size="sm" className="h-7 text-xs" onClick={submitCreate} disabled={busy}>
                  保存
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={cancelCreate} disabled={busy}>
                  取消
                </Button>
              </div>
            </TableCell>
          </TableRow>
        )}
        {category.items.map((it, idx) => {
          const isEditing = editingId === it.id && editRow;
          const sample = it.unitPrice * it.sampleQuantity;
          const production = it.unitPrice * it.productionQuantity;
          const total = sample + production;
          return (
            <TableRow key={it.id} className={isEditing ? "bg-muted/30" : undefined}>
              <TableCell className="p-2 text-xs text-muted-foreground">{idx + 1}</TableCell>
              <TableCell className={isEditing ? "p-2" : "font-medium"}>
                {isEditing ? (
                  <Input
                    value={editRow!.title}
                    onChange={(e) => setEditRow({ ...editRow!, title: e.target.value })}
                    className="h-7 text-xs"
                  />
                ) : (
                  it.title
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "tabular-nums"}>
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
              <TableCell className={isEditing ? "p-2" : "tabular-nums"}>
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
              <TableCell className={isEditing ? "p-2" : "tabular-nums"}>
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
              <TableCell className={isEditing ? "p-2" : undefined}>
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
              <TableCell className="p-2">
                {isEditing ? (
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" className="h-7 text-xs" onClick={submitEdit} disabled={busy}>
                      保存
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={cancelEdit}
                      disabled={busy}
                    >
                      取消
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {canEdit && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => startEdit(it)}>
                        编辑
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive"
                        onClick={() => handleDelete(it)}
                      >
                        删除
                      </Button>
                    )}
                    {!canEdit && !canDelete && (
                      <span className="text-xs text-muted-foreground">只读</span>
                    )}
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
        {category.items.length === 0 && !newRow && (
          <TableRow>
            <TableCell colSpan={10} className="h-24 text-center text-xs text-muted-foreground">
              暂无条目
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
            <TableCell colSpan={2} className="p-2 text-right">
              {canCreate && !newRow && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={startCreate}>
                  新增条目
                </Button>
              )}
              {newRow && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={cancelCreate}>
                  取消新增
                </Button>
              )}
            </TableCell>
          </TableRow>
        )}
        {category.items.length === 0 && !newRow && canCreate && (
          <TableRow>
            <TableCell colSpan={10} className="p-2 text-center">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={startCreate}>
                新增条目
              </Button>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
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
  const [newRow, setNewRow] = useState<OtherDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<OtherDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const startCreate = () => {
    setNewRow({ ...EMPTY_OT });
    setEditingId(null);
    setEditRow(null);
  };
  const cancelCreate = () => setNewRow(null);
  const startEdit = (it: ProjectBudgetItem) => {
    setEditingId(it.id);
    setEditRow({ title: it.title, amount: it.amount, remark: it.remark });
    setNewRow(null);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditRow(null);
  };

  const submitCreate = async () => {
    if (!newRow) return;
    if (!newRow.title.trim()) {
      alert("差旅事项不能为空");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/projects/${projectId}/budget-items`, {
        categoryId: category.id,
        ...newRow,
      });
      setNewRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = async () => {
    if (!editingId || !editRow) return;
    if (!editRow.title.trim()) {
      alert("差旅事项不能为空");
      return;
    }
    setBusy(true);
    try {
      await api.put(`/api/projects/${projectId}/budget-items/${editingId}`, {
        categoryId: category.id,
        ...editRow,
      });
      setEditingId(null);
      setEditRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (it: ProjectBudgetItem) => {
    if (!(await confirm(`确认删除「${it.title}」？`))) return;
    try {
      await api.delete(`/api/projects/${projectId}/budget-items/${it.id}`);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[60px]">序号</TableHead>
          <TableHead>差旅事项</TableHead>
          <TableHead className="w-[180px] text-right">金额</TableHead>
          <TableHead>备注</TableHead>
          <TableHead className="w-[180px]">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {newRow && (
          <TableRow className="bg-muted/30">
            <TableCell className="p-2 text-xs text-muted-foreground">新</TableCell>
            <TableCell className="p-2">
              <Input
                value={newRow.title}
                onChange={(e) => setNewRow({ ...newRow, title: e.target.value })}
                className="h-7 text-xs"
                autoFocus
                placeholder="差旅事项"
              />
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
            <TableCell className="p-2">
              <div className="flex items-center gap-1.5">
                <Button size="sm" className="h-7 text-xs" onClick={submitCreate} disabled={busy}>
                  保存
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={cancelCreate} disabled={busy}>
                  取消
                </Button>
              </div>
            </TableCell>
          </TableRow>
        )}
        {category.items.map((it, idx) => {
          const isEditing = editingId === it.id && editRow;
          return (
            <TableRow key={it.id} className={isEditing ? "bg-muted/30" : undefined}>
              <TableCell className="p-2 text-xs text-muted-foreground">{idx + 1}</TableCell>
              <TableCell className={isEditing ? "p-2" : "font-medium"}>
                {isEditing ? (
                  <Input
                    value={editRow!.title}
                    onChange={(e) => setEditRow({ ...editRow!, title: e.target.value })}
                    className="h-7 text-xs"
                  />
                ) : (
                  it.title
                )}
              </TableCell>
              <TableCell className="p-2 text-right text-xs font-semibold tabular-nums">
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
              <TableCell className={isEditing ? "p-2" : undefined}>
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
              <TableCell className="p-2">
                {isEditing ? (
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" className="h-7 text-xs" onClick={submitEdit} disabled={busy}>
                      保存
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={cancelEdit}
                      disabled={busy}
                    >
                      取消
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {canEdit && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => startEdit(it)}>
                        编辑
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive"
                        onClick={() => handleDelete(it)}
                      >
                        删除
                      </Button>
                    )}
                    {!canEdit && !canDelete && (
                      <span className="text-xs text-muted-foreground">只读</span>
                    )}
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
        {category.items.length === 0 && !newRow && (
          <TableRow>
            <TableCell colSpan={5} className="h-24 text-center text-xs text-muted-foreground">
              暂无差旅事项
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
            <TableCell colSpan={2} className="p-2 text-right">
              {canCreate && !newRow && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={startCreate}>
                  新增差旅
                </Button>
              )}
              {newRow && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={cancelCreate}>
                  取消新增
                </Button>
              )}
            </TableCell>
          </TableRow>
        )}
        {category.items.length === 0 && !newRow && canCreate && (
          <TableRow>
            <TableCell colSpan={5} className="p-2 text-center">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={startCreate}>
                新增差旅
              </Button>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
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
  canEdit,
  canDelete,
  onChanged,
  confirm,
}: {
  category: CategoryWithMeta;
  projectId: string;
  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => void | Promise<void>;
  confirm: (msg: string) => Promise<boolean>;
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<RateDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const startEdit = (it: ProjectBudgetItem) => {
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
    setEditingId(null);
    setEditRow(null);
  };

  const submitEdit = async () => {
    if (!editingId || !editRow) return;
    if (!editRow.title.trim()) {
      alert("费率名称不能为空");
      return;
    }
    if (editRow.minRate > editRow.maxRate) {
      alert("建议下限不能大于建议上限");
      return;
    }
    setBusy(true);
    try {
      await api.put(`/api/projects/${projectId}/budget-items/${editingId}`, {
        categoryId: category.id,
        ...editRow,
      });
      setEditingId(null);
      setEditRow(null);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (it: ProjectBudgetItem) => {
    if (!(await confirm(`确认删除「${it.title}」？`))) return;
    try {
      await api.delete(`/api/projects/${projectId}/budget-items/${it.id}`);
      await onChanged();
    } catch (e) {
      alert(e instanceof Error ? e.message : "删除失败");
    }
  };

  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-[60px]">序号</TableHead>
          <TableHead className="w-[220px]">费率名称</TableHead>
          <TableHead className="w-[140px] text-right">建议下限</TableHead>
          <TableHead className="w-[140px] text-right">建议上限</TableHead>
          <TableHead className="w-[140px] text-right">当前使用</TableHead>
          <TableHead>备注</TableHead>
          <TableHead className="w-[180px]">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {category.items.map((it, idx) => {
          const isEditing = editingId === it.id && editRow;
          const outOfRange = it.currentRate < it.minRate || it.currentRate > it.maxRate;
          return (
            <TableRow key={it.id} className={isEditing ? "bg-muted/30" : undefined}>
              <TableCell className="p-2 text-xs text-muted-foreground">{idx + 1}</TableCell>
              <TableCell className={isEditing ? "p-2" : "font-medium"}>
                {isEditing ? (
                  <Input
                    value={editRow!.title}
                    onChange={(e) => setEditRow({ ...editRow!, title: e.target.value })}
                    className="h-7 text-xs"
                  />
                ) : (
                  it.title
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "text-right text-xs tabular-nums"}>
                {isEditing ? (
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={editRow!.minRate}
                    onChange={(e) => setEditRow({ ...editRow!, minRate: Number(e.target.value) || 0 })}
                    className="h-7 text-xs tabular-nums text-right"
                  />
                ) : (
                  formatPercent(it.minRate)
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "text-right text-xs tabular-nums"}>
                {isEditing ? (
                  <Input
                    type="number"
                    min={0}
                    step={0.01}
                    value={editRow!.maxRate}
                    onChange={(e) => setEditRow({ ...editRow!, maxRate: Number(e.target.value) || 0 })}
                    className="h-7 text-xs tabular-nums text-right"
                  />
                ) : (
                  formatPercent(it.maxRate)
                )}
              </TableCell>
              <TableCell className={isEditing ? "p-2" : "text-right text-xs font-semibold tabular-nums"}>
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
              <TableCell className={isEditing ? "p-2" : "text-xs text-muted-foreground"}>
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
              <TableCell className="p-2">
                {isEditing ? (
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" className="h-7 text-xs" onClick={submitEdit} disabled={busy}>
                      保存
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={cancelEdit}
                      disabled={busy}
                    >
                      取消
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {canEdit && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => startEdit(it)}>
                        编辑
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive"
                        onClick={() => handleDelete(it)}
                      >
                        删除
                      </Button>
                    )}
                    {!canEdit && !canDelete && (
                      <span className="text-xs text-muted-foreground">只读</span>
                    )}
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
        {category.items.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} className="h-24 text-center text-xs text-muted-foreground">
              暂无档位条目
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
};
