# Modal Interaction Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify project edit, confirm, and batch-operation interactions around the approved dark modal dialog pattern.

**Architecture:** Extract a shared modal shell from the existing role-config popup pattern, keep the existing `useConfirm()` behavior contract while swapping its visual shell onto the shared modal, and migrate each page from inline editing or save-on-blur table editing to explicit modal-open → edit → confirm flows. Procurement pages share one reusable execution editor dialog so the three surfaces stay behaviorally identical.

**Tech Stack:** Next.js App Router, React client components, TypeScript, Tailwind utility classes, Vitest, Testing Library.

---

## File Structure Map

### Create

- `src/components/modal-dialog.tsx`
  - Shared dark modal shell extracted from the current `role-config` overlay pattern.
- `src/components/procurement-record-edit-dialog.tsx`
  - Shared execution-field editor dialog for required/optional/structural procurement pages.
- `src/app/procurement/__tests__/procurement-record-edit-dialog.test.tsx`
  - Focused tests for the shared procurement editing modal.

### Modify

- `src/components/confirm-dialog.tsx`
  - Re-skin existing confirmation dialog onto the new modal shell.
- `src/components/create-project-dialog.tsx`
  - Align create-project dialog shell with the same modal component if current implementation differs.
- `src/app/admin/accounts/page.tsx`
  - Replace inline edit block and persistent batch block with modal-triggered flows.
- `src/app/admin/accounts/__tests__/page.test.tsx`
  - Update tests from inline queries to modal-driven assertions.
- `src/app/projects/[projectId]/page.tsx`
  - Convert project info editing into modal and add delete confirmations.
- `src/app/procurement/required-parts/page.tsx`
  - Remove direct cell editing, add row-level edit action, wire shared procurement dialog.
- `src/app/procurement/optional-parts/page.tsx`
  - Same modal editing migration.
- `src/app/procurement/structural-parts/page.tsx`
  - Same modal editing migration.
- Existing tests for project detail / procurement pages as needed after dialog markup changes.

### Keep unchanged unless a migration step proves otherwise

- `src/state/rpms-context.tsx`
- `src/domain/services/rpmsService.ts`
- domain models and business rules already validated in the previous lifecycle milestone.

---

### Task 1: Shared dark modal infrastructure

**Files:**
- Create: `src/components/modal-dialog.tsx`
- Modify: `src/components/confirm-dialog.tsx`
- Modify: `src/components/create-project-dialog.tsx`
- Test: existing consumers verified later via page tests

- [ ] **Step 1: Write the failing test surface by updating one existing dialog assertion target first**

Use the account page test later to assert dialog semantics instead of inline form semantics. Add this expectation pattern in `src/app/admin/accounts/__tests__/page.test.tsx` before implementation:

```tsx
await userEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]);
expect(screen.getByRole("dialog", { name: "编辑账号" })).toBeInTheDocument();
expect(screen.queryByText("编辑账号")).toBeInTheDocument();
```

- [ ] **Step 2: Run targeted account page test to verify it fails before shared modal exists**

Run: `npm test -- src/app/admin/accounts/__tests__/page.test.tsx`

Expected: FAIL because the page still renders an inline form instead of a dialog.

- [ ] **Step 3: Create the shared modal shell component**

Create `src/components/modal-dialog.tsx` with this implementation:

```tsx
"use client";

import { ReactNode } from "react";

type ModalDialogSize = "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<ModalDialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-2xl",
  lg: "max-w-4xl",
  xl: "max-w-5xl",
};

interface ModalDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: ModalDialogSize;
}

export function ModalDialog({ open, title, children, footer, onClose, size = "md" }: ModalDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-6 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className={`flex w-full ${SIZE_CLASS[size]} flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="text-lg font-semibold text-slate-900">{title}</div>
          <button type="button" onClick={onClose} className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700">
            关闭
          </button>
        </div>
        <div className="max-h-[78vh] overflow-auto px-4 py-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Re-skin the reusable confirm dialog onto the shared modal shell**

Replace `src/components/confirm-dialog.tsx` body with:

```tsx
"use client";

import { type ReactNode } from "react";
import { ModalDialog } from "./modal-dialog";

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title = "请确认操作",
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <ModalDialog
      open={open}
      title={title}
      onClose={onCancel}
      size="sm"
      footer={
        <>
          <button type="button" onClick={onCancel} className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50">
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm} className="rounded-md bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-700">
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-700">{message}</p>
    </ModalDialog>
  );
}
```

- [ ] **Step 5: Align create-project dialog to the same shell if it still renders its own overlay**

Refactor `src/components/create-project-dialog.tsx` overlay/container to:

```tsx
import { ModalDialog } from "@/components/modal-dialog";

// inside render
<ModalDialog
  open={open}
  title="新建项目"
  onClose={onClose}
  size="md"
  footer={
    <>
      <button type="button" onClick={onClose}>取消</button>
      <button type="submit" form="create-project-form">创建项目</button>
    </>
  }
>
  <form id="create-project-form" onSubmit={handleSubmit} className="grid gap-3">
    {/* keep existing fields */}
  </form>
</ModalDialog>
```

- [ ] **Step 6: Run a focused verification pass for dialog consumers**

Run: `npm test -- src/app/admin/accounts/__tests__/page.test.tsx src/components/__tests__/app-shell.test.tsx`

Expected: account test still fails until Task 2 is done; unrelated shell tests stay green.

- [ ] **Step 7: Commit shared modal infrastructure**

```bash
git add src/components/modal-dialog.tsx src/components/confirm-dialog.tsx src/components/create-project-dialog.tsx src/app/admin/accounts/__tests__/page.test.tsx
git commit -m "feat: unify modal dialog shell"
```

### Task 2: Account management modal flows

**Files:**
- Modify: `src/app/admin/accounts/page.tsx`
- Modify: `src/app/admin/accounts/__tests__/page.test.tsx`
- Test: `src/domain/services/__tests__/rpmsService.test.ts`

- [ ] **Step 1: Expand page tests to cover modal edit, confirm reset, and batch modal**

Update `src/app/admin/accounts/__tests__/page.test.tsx` with these modal-oriented expectations:

```tsx
await userEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]);
const editDialog = screen.getByRole("dialog", { name: "编辑账号" });
await userEvent.clear(within(editDialog).getByPlaceholderText("显示名称"));
await userEvent.type(within(editDialog).getByPlaceholderText("显示名称"), "系统管理员-编辑");
await userEvent.click(within(editDialog).getByRole("button", { name: "保存编辑" }));

await userEvent.click(within(procRow).getByRole("button", { name: "停用" }));
expect(screen.getByRole("dialog", { name: "请确认操作" })).toBeInTheDocument();
await userEvent.click(screen.getByRole("button", { name: "确认" }));

await userEvent.click(screen.getByRole("button", { name: "批量角色调整" }));
const batchDialog = screen.getByRole("dialog", { name: "批量角色调整" });
```

- [ ] **Step 2: Run account page tests to confirm current page fails under modal expectations**

Run: `npm test -- src/app/admin/accounts/__tests__/page.test.tsx`

Expected: FAIL because edit and batch flows are still inline blocks and row actions do not open confirm dialogs.

- [ ] **Step 3: Refactor account page state from inline blocks to modal state**

Add these state flags at the top of `src/app/admin/accounts/page.tsx`:

```tsx
import { useConfirm } from "@/components/confirm-provider";
import { ModalDialog } from "@/components/modal-dialog";

const confirm = useConfirm();
const [editOpen, setEditOpen] = useState(false);
const [batchOpen, setBatchOpen] = useState(false);
```

Replace the existing `openEdit` handler with:

```tsx
const openEdit = (accountId: string) => {
  const target = db.userAccounts.find((item) => item.id === accountId);
  if (!target) return;
  setEditingId(accountId);
  setEditingDisplayName(target.displayName);
  setEditingAppRole(target.assignedAppRole);
  setEditingRoleNamesText(target.assignedRoleNames.join(", "));
  setEditOpen(true);
};
```

Replace the old inline edit-closing behavior with:

```tsx
const closeEdit = () => {
  setEditOpen(false);
  setEditingId(null);
  setEditingDisplayName("");
  setEditingRoleNamesText("");
};
```

- [ ] **Step 4: Convert account actions to explicit confirmation flows**

Replace `toggleEnabled` and `resetPassword` with:

```tsx
const toggleEnabled = async (accountId: string, nextEnabled: boolean, username: string) => {
  const ok = await confirm(`确认${nextEnabled ? "启用" : "停用"}账号「${username}」？`);
  if (!ok) return;
  try {
    setUserAccountEnabledAction(accountId, nextEnabled);
    alert(nextEnabled ? "账号已启用" : "账号已停用");
  } catch (error) {
    alert(error instanceof Error ? error.message : "状态更新失败");
  }
};

const resetPassword = async (accountId: string, username: string) => {
  const ok = await confirm(`确认重置账号「${username}」的密码状态？`);
  if (!ok) return;
  try {
    resetUserPasswordAction(accountId);
    alert("已重置密码并要求下次登录修改");
  } catch (error) {
    alert(error instanceof Error ? error.message : "重置密码失败");
  }
};
```

Update row button bindings accordingly:

```tsx
<button type="button" onClick={() => toggleEnabled(account.id, !account.enabled, account.username)}>
  {account.enabled ? "停用" : "启用"}
</button>
<button type="button" onClick={() => resetPassword(account.id, account.username)}>
  重置密码
</button>
```

- [ ] **Step 5: Move edit form and batch form into modals**

Replace the inline edit block and persistent batch form with:

```tsx
<button type="button" onClick={() => setBatchOpen(true)} disabled={selectedCount === 0}>
  批量角色调整
</button>

<ModalDialog
  open={editOpen}
  title="编辑账号"
  onClose={closeEdit}
  size="md"
  footer={
    <>
      <button type="button" onClick={closeEdit}>取消</button>
      <button type="submit" form="account-edit-form">保存编辑</button>
    </>
  }
>
  <form id="account-edit-form" className="grid gap-2 md:grid-cols-3" onSubmit={saveEdit}>
    {/* existing edit fields unchanged */}
  </form>
</ModalDialog>

<ModalDialog
  open={batchOpen}
  title="批量角色调整"
  onClose={() => setBatchOpen(false)}
  size="md"
  footer={
    <>
      <button type="button" onClick={() => setBatchOpen(false)}>取消</button>
      <button type="submit" form="account-batch-form">应用到所选账号</button>
    </>
  }
>
  <form id="account-batch-form" className="grid gap-2" onSubmit={runBatchAssign}>
    {/* existing batch fields and helper text */}
  </form>
</ModalDialog>
```

Inside `runBatchAssign`, close and clear selection after success:

```tsx
setSelectedIds([]);
setBatchOpen(false);
```

Inside `saveEdit`, replace `setEditingId(null)` with `closeEdit()`.

- [ ] **Step 6: Run account-specific tests and service regression tests**

Run: `npm test -- src/app/admin/accounts/__tests__/page.test.tsx src/domain/services/__tests__/rpmsService.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit account page modal migration**

```bash
git add src/app/admin/accounts/page.tsx src/app/admin/accounts/__tests__/page.test.tsx src/domain/services/__tests__/rpmsService.test.ts
git commit -m "feat: migrate account operations to modal flows"
```

### Task 3: Project detail editing and delete confirmations

**Files:**
- Modify: `src/app/projects/[projectId]/page.tsx`
- Test: existing project detail tests or add focused assertions where project detail behaviors are covered

- [ ] **Step 1: Add failing test coverage for modal project editing and delete confirmation behavior**

If no dedicated project-detail page test exists yet, add one under `src/app/projects/[projectId]/__tests__/page.test.tsx` with these checks:

```tsx
await userEvent.click(screen.getByRole("button", { name: "编辑项目信息" }));
expect(screen.getByRole("dialog", { name: "编辑项目信息" })).toBeInTheDocument();

await userEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
expect(screen.getByRole("dialog", { name: "请确认操作" })).toHaveTextContent("确认删除");
```

- [ ] **Step 2: Run the focused project detail test to confirm it fails first**

Run: `npm test -- src/app/projects/[projectId]/__tests__/page.test.tsx`

Expected: FAIL because project editing is inline and member/device/part deletion is immediate.

- [ ] **Step 3: Replace inline project info form with modal-triggered editing**

In `ProjectInfoTab`, replace local always-on form state with:

```tsx
import { ModalDialog } from "@/components/modal-dialog";

const [editOpen, setEditOpen] = useState(false);

const resetProjectDraft = () => {
  setName(project.name);
  setCode(project.code);
  setClientName(project.clientName);
  setAmount(project.amountWan);
};
```

Add toolbar trigger above the form area:

```tsx
{canEdit && (
  <button
    type="button"
    onClick={() => {
      resetProjectDraft();
      setEditOpen(true);
    }}
  >
    编辑项目信息
  </button>
)}
```

Move the existing form into:

```tsx
<ModalDialog
  open={editOpen}
  title="编辑项目信息"
  onClose={() => setEditOpen(false)}
  size="md"
  footer={
    <>
      <button type="button" onClick={() => setEditOpen(false)}>取消</button>
      <button type="submit" form="project-info-form" disabled={!canEdit}>保存项目信息</button>
    </>
  }
>
  <form
    id="project-info-form"
    className="grid gap-2 md:grid-cols-2"
    onSubmit={(event) => {
      event.preventDefault();
      updateProjectAction(projectId, { name, code, clientName, amountWan: amount });
      setEditOpen(false);
      alert("项目信息已更新");
    }}
  >
    {/* existing field labels/inputs */}
  </form>
</ModalDialog>
```

- [ ] **Step 4: Add confirmation wrappers for member/device/part deletion**

Use `const confirm = useConfirm();` in each table/tab that performs deletion and replace direct delete handlers with:

```tsx
const handleDeleteMember = async (memberId: string, roleName: string, personName: string) => {
  if (!(await confirm(`确认删除项目成员「${roleName} / ${personName}」？`))) return;
  removeProjectMemberAction(memberId);
};
```

Similarly add:

```tsx
const handleDeleteDevice = async (deviceId: string, deviceName: string) => {
  if (!(await confirm(`确认删除交付设备「${deviceName}」？`))) return;
  removeDeliveryDeviceAction(deviceId);
};

const handleDeleteRequiredPart = async (partId: string, partName: string) => {
  if (!(await confirm(`确认删除必换件「${partName}」？`))) return;
  removeRequiredPartAction(partId);
};

const handleDeleteOptionalPart = async (partId: string, partName: string) => {
  if (!(await confirm(`确认删除选换件「${partName}」？`))) return;
  removeOptionalPartAction(partId);
};
```

- [ ] **Step 5: Run focused project detail tests**

Run: `npm test -- src/app/projects/[projectId]/__tests__/page.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit project detail modal migration**

```bash
git add src/app/projects/[projectId]/page.tsx src/app/projects/[projectId]/__tests__/page.test.tsx
git commit -m "feat: move project detail edits into dialogs"
```

### Task 4: Shared procurement execution edit dialog

**Files:**
- Create: `src/components/procurement-record-edit-dialog.tsx`
- Create: `src/app/procurement/__tests__/procurement-record-edit-dialog.test.tsx`

- [ ] **Step 1: Write focused failing tests for procurement record dialog submit behavior**

Create `src/app/procurement/__tests__/procurement-record-edit-dialog.test.tsx` with:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProcurementProgressStatus, PaymentStatus } from "@/domain/enums";
import { ProcurementRecordEditDialog } from "@/components/procurement-record-edit-dialog";

describe("ProcurementRecordEditDialog", () => {
  it("应在确认前仅维护本地草稿，确认后一次性提交", async () => {
    const onSubmit = vi.fn();
    render(
      <ProcurementRecordEditDialog
        open
        title="编辑采购执行信息"
        record={{
          id: "r1",
          sourcePartName: "叶轮",
          unitPrice: 10,
          cycleDays: 20,
          vendor: "旧厂家",
          purchaseDate: "2026-05-21",
          progressStatus: ProcurementProgressStatus.NOT_PURCHASED,
          paymentStatus: PaymentStatus.UNPAID,
        }}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "编辑采购执行信息" });
    await userEvent.clear(within(dialog).getByLabelText("厂家"));
    await userEvent.type(within(dialog).getByLabelText("厂家"), "新厂家");
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ vendor: "新厂家" }));
  });
});
```

- [ ] **Step 2: Run the focused procurement dialog test and confirm failure before component creation**

Run: `npm test -- src/app/procurement/__tests__/procurement-record-edit-dialog.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the shared procurement record edit dialog**

Create `src/components/procurement-record-edit-dialog.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { PaymentStatus, ProcurementProgressStatus } from "@/domain/enums";
import { PAYMENT_STATUS_LABEL, PROCUREMENT_PROGRESS_LABEL } from "@/lib/constants";
import { ModalDialog } from "@/components/modal-dialog";

interface EditableProcurementRecord {
  id: string;
  sourcePartName: string;
  unitPrice?: number;
  cycleDays?: number;
  vendor?: string;
  purchaseDate?: string;
  progressStatus: ProcurementProgressStatus;
  paymentStatus: PaymentStatus;
}

interface ProcurementRecordEditDialogProps {
  open: boolean;
  title: string;
  record: EditableProcurementRecord | null;
  onClose: () => void;
  onSubmit: (patch: {
    unitPrice?: number;
    cycleDays?: number;
    vendor?: string;
    purchaseDate?: string;
    progressStatus: ProcurementProgressStatus;
    paymentStatus: PaymentStatus;
  }) => void;
}

export function ProcurementRecordEditDialog({ open, title, record, onClose, onSubmit }: ProcurementRecordEditDialogProps) {
  const [unitPrice, setUnitPrice] = useState("");
  const [cycleDays, setCycleDays] = useState("");
  const [vendor, setVendor] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [progressStatus, setProgressStatus] = useState(ProcurementProgressStatus.NOT_PURCHASED);
  const [paymentStatus, setPaymentStatus] = useState(PaymentStatus.UNPAID);

  useEffect(() => {
    if (!record) return;
    setUnitPrice(record.unitPrice?.toString() ?? "");
    setCycleDays(record.cycleDays?.toString() ?? "");
    setVendor(record.vendor ?? "");
    setPurchaseDate(record.purchaseDate ?? "");
    setProgressStatus(record.progressStatus);
    setPaymentStatus(record.paymentStatus);
  }, [record]);

  return (
    <ModalDialog
      open={open && !!record}
      title={title}
      onClose={onClose}
      size="md"
      footer={
        <>
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            onClick={() =>
              onSubmit({
                unitPrice: unitPrice ? Number(unitPrice) : undefined,
                cycleDays: cycleDays ? Number(cycleDays) : undefined,
                vendor,
                purchaseDate,
                progressStatus,
                paymentStatus,
              })
            }
          >
            保存
          </button>
        </>
      }
    >
      {record ? (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1"><span className="text-xs text-slate-500">单价</span><input type="number" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} /></label>
          <label className="space-y-1"><span className="text-xs text-slate-500">周期(天)</span><input type="number" value={cycleDays} onChange={(e) => setCycleDays(e.target.value)} /></label>
          <label className="space-y-1"><span className="text-xs text-slate-500">厂家</span><input aria-label="厂家" value={vendor} onChange={(e) => setVendor(e.target.value)} /></label>
          <label className="space-y-1"><span className="text-xs text-slate-500">采购日期</span><input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} /></label>
          <label className="space-y-1"><span className="text-xs text-slate-500">采购状态</span><select value={progressStatus} onChange={(e) => setProgressStatus(e.target.value as ProcurementProgressStatus)}>{Object.values(ProcurementProgressStatus).map((status) => <option key={status} value={status}>{PROCUREMENT_PROGRESS_LABEL[status]}</option>)}</select></label>
          <label className="space-y-1"><span className="text-xs text-slate-500">付款状态</span><select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value as PaymentStatus)}>{Object.values(PaymentStatus).map((status) => <option key={status} value={status}>{PAYMENT_STATUS_LABEL[status]}</option>)}</select></label>
        </div>
      ) : null}
    </ModalDialog>
  );
}
```

- [ ] **Step 4: Run focused dialog tests to verify the reusable component passes**

Run: `npm test -- src/app/procurement/__tests__/procurement-record-edit-dialog.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit shared procurement dialog**

```bash
git add src/components/procurement-record-edit-dialog.tsx src/app/procurement/__tests__/procurement-record-edit-dialog.test.tsx
git commit -m "feat: add procurement record edit dialog"
```

### Task 5: Migrate the three procurement pages to modal row editing

**Files:**
- Modify: `src/app/procurement/required-parts/page.tsx`
- Modify: `src/app/procurement/optional-parts/page.tsx`
- Modify: `src/app/procurement/structural-parts/page.tsx`
- Test: procurement page tests if present, otherwise add one focused page test per first migrated page and smoke-check the others through full suite

- [ ] **Step 1: Write failing page test for one procurement page before cloning the pattern**

For `src/app/procurement/required-parts/__tests__/page.test.tsx` add:

```tsx
await userEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]);
const dialog = screen.getByRole("dialog", { name: "编辑采购执行信息" });
await userEvent.clear(within(dialog).getByLabelText("厂家"));
await userEvent.type(within(dialog).getByLabelText("厂家"), "统一新厂家");
await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
expect(screen.getByText("统一新厂家")).toBeInTheDocument();
```

- [ ] **Step 2: Run the required-parts page test to verify failure**

Run: `npm test -- src/app/procurement/required-parts/__tests__/page.test.tsx`

Expected: FAIL because the table has no row-level edit button and still uses direct field editing.

- [ ] **Step 3: Refactor required-parts page from inline cells to row action + modal**

In `src/app/procurement/required-parts/page.tsx`:

```tsx
import { ProcurementRecordEditDialog } from "@/components/procurement-record-edit-dialog";

const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
const editingRecord = records.find((item) => item.id === editingRecordId) ?? null;
```

Replace editable table cells with plain text cells plus an action column:

```tsx
<th>操作</th>
...
<td>{record.unitPrice ?? "-"}</td>
<td>{record.cycleDays ?? "-"}</td>
<td>{record.vendor || "-"}</td>
<td>{record.purchaseDate ? formatDate(record.purchaseDate) : "-"}</td>
<td>{PROCUREMENT_PROGRESS_LABEL[record.progressStatus]}</td>
<td>{PAYMENT_STATUS_LABEL[record.paymentStatus]}</td>
...
<td>
  <button type="button" disabled={!canEditFields} onClick={() => setEditingRecordId(record.id)}>
    编辑
  </button>
</td>
```

Mount the shared dialog under the table:

```tsx
<ProcurementRecordEditDialog
  open={!!editingRecord}
  title="编辑采购执行信息"
  record={editingRecord && {
    id: editingRecord.id,
    sourcePartName: editingRecord.sourcePartName,
    unitPrice: editingRecord.unitPrice,
    cycleDays: editingRecord.cycleDays,
    vendor: editingRecord.vendor,
    purchaseDate: editingRecord.purchaseDate,
    progressStatus: editingRecord.progressStatus,
    paymentStatus: editingRecord.paymentStatus,
  }}
  onClose={() => setEditingRecordId(null)}
  onSubmit={(patch) => {
    if (!editingRecord) return;
    updateProcurementAction(editingRecord.id, patch);
    setEditingRecordId(null);
    alert("采购执行信息已更新");
  }}
/>
```

- [ ] **Step 4: Apply the same pattern to optional and structural procurement pages**

Mirror the required-parts migration in:

- `src/app/procurement/optional-parts/page.tsx` using the optional record fields and `updateOptionalProcurementAction`
- `src/app/procurement/structural-parts/page.tsx` using the structural record fields and `updateStructuralProcurementAction`

Use the same action-column markup:

```tsx
<button type="button" disabled={!canEditFields} onClick={() => setEditingRecordId(record.id)}>
  编辑
</button>
```

and the same dialog title:

```tsx
title="编辑采购执行信息"
```

- [ ] **Step 5: Run targeted procurement tests**

Run: `npm test -- src/app/procurement/required-parts/__tests__/page.test.tsx src/app/procurement/__tests__/procurement-record-edit-dialog.test.tsx`

If optional/structural page tests exist, include them too.

Expected: PASS.

- [ ] **Step 6: Commit procurement modal migration**

```bash
git add src/app/procurement/required-parts/page.tsx src/app/procurement/optional-parts/page.tsx src/app/procurement/structural-parts/page.tsx src/app/procurement/required-parts/__tests__/page.test.tsx src/app/procurement/__tests__/procurement-record-edit-dialog.test.tsx
git commit -m "feat: move procurement editing into dialogs"
```

### Task 6: Final verification and cleanup

**Files:**
- Modify only if verification exposes regressions

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 3: Run targeted high-risk tests together**

Run: `npm test -- src/app/admin/accounts/__tests__/page.test.tsx src/app/projects/[projectId]/__tests__/page.test.tsx src/app/procurement/required-parts/__tests__/page.test.tsx src/domain/services/__tests__/rpmsService.test.ts`

Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`

Expected: PASS across the full suite, with only pre-existing warnings allowed if no new failures are introduced.

- [ ] **Step 5: Review changed files before any final delivery or optional commit squash**

Run:

```bash
git status
git diff -- src/components src/app/admin/accounts src/app/projects src/app/procurement
```

Expected: only modal-unification changes are present.

- [ ] **Step 6: Final commit**

```bash
git add src/components src/app/admin/accounts src/app/projects src/app/procurement
git commit -m "feat: unify edit interactions with modal dialogs"
```

## Self-Review

### Spec coverage

- Shared modal shell: covered by Task 1.
- Account edit / enable-disable / reset / batch modalization: covered by Task 2.
- Project info modalization and delete confirmations: covered by Task 3.
- Procurement pages moving from inline cell editing to modal editing: covered by Tasks 4-5.
- Verification and regression protection: covered by Task 6.

No spec requirement is currently uncovered.

### Placeholder scan

- No `TBD`, `TODO`, or “implement later” placeholders remain.
- Commands and target file paths are explicit.
- Repeated migration patterns for the three procurement pages are spelled out with concrete handler names and markup.

### Type consistency

- Shared modal shell is consistently named `ModalDialog`.
- Shared procurement editor is consistently named `ProcurementRecordEditDialog`.
- Confirmation flow keeps `useConfirm()` unchanged.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-21-modal-interaction-unification.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
