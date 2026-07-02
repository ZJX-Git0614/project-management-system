# Sidebar Navigation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将侧边栏重构为 4 个真正的一级菜单分组，把“项目列表”收纳到“项目经营驾驶舱”下，并把整体视觉调整为更轻、更清晰的企业后台风格，同时保持现有路由与权限逻辑不变。

**Architecture:** 只修改 `src/components/app-shell.tsx` 这一层的导航信息架构与样式类组合；保留现有 `usePermission`、`navigation`、路由地址和页面逻辑，采用“子项可见则父组显示”的现有权限收口方式。通过新增/调整 `AppShell` 组件测试来锁定层级结构与权限显示行为，再做最小实现，最后跑 targeted tests、typecheck 与 lint 验证。

**Tech Stack:** Next.js App Router、React、TypeScript、Vitest、Testing Library、现有 Tailwind/项目 CSS 类名体系。

---

## 文件职责与改动边界

- **修改：** `src/components/app-shell.tsx`
  - 侧边栏菜单信息架构重组
  - 一级/二级菜单渲染结构调整
  - 视觉层级优化（更轻的二级项、更清晰的一级标题）
- **修改：** `src/components/__tests__/app-shell.test.tsx`
  - 锁定新的一级/二级菜单结构
  - 锁定“项目列表”归属变化
  - 锁定“项目采购管理”继续按子权限显示
- **回归验证：** `src/lib/__tests__/navigation.test.ts`
  - 不一定修改，但需要回归执行，确认导航公共逻辑未被误伤

> 不改文件：`src/lib/permissions.ts`、`src/lib/navigation.ts`、任何 procurement page、todo route、service/context/domain 文件。

---

### Task 1: 用测试锁定新的侧边栏信息架构

**Files:**
- Modify: `src/components/__tests__/app-shell.test.tsx`
- Test: `src/components/__tests__/app-shell.test.tsx`

- [ ] **Step 1: 写出失败测试，覆盖新的一级/二级菜单结构**

在现有 `describe("AppShell")`（如果没有则新建）中补 3 个测试：

```tsx
it("项目列表应显示在项目经营驾驶舱分组下，而不是独立一级入口", async () => {
  renderAppShell((seed) => {
    seed.currentRole = AppRole.PROJECT_MANAGER;
  });

  const dashboardGroup = await screen.findByText("项目经营驾驶舱");
  expect(dashboardGroup).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "项目列表" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "项目信息管理" })).toBeInTheDocument();
});

it("四个分组标题应作为真正的一级菜单出现", async () => {
  renderAppShell((seed) => {
    seed.currentRole = AppRole.ADMIN;
  });

  expect(await screen.findByText("项目经营驾驶舱")).toBeInTheDocument();
  expect(screen.getByText("项目范围管理")).toBeInTheDocument();
  expect(screen.getByText("项目采购管理")).toBeInTheDocument();
  expect(screen.getByText("系统设置")).toBeInTheDocument();
});

it("项目采购管理分组下应继续显示三个采购二级菜单", async () => {
  renderAppShell((seed) => {
    seed.currentRole = AppRole.PROCUREMENT_MANAGER;
  });

  const procurementGroup = await screen.findByText("项目采购管理");
  expect(procurementGroup).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /必换件采购管理/ })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /选换件采购管理/ })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /结构件采购管理/ })).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试，确认它们先失败**

Run:

```bash
npm test -- --run src/components/__tests__/app-shell.test.tsx
```

Expected:

```text
FAIL
- 项目列表仍是独立一级入口，未出现在“项目经营驾驶舱”分组下
- 分组标题数量/层级与预期不一致
```

- [ ] **Step 3: 如测试选择器不稳，先修测试前提，不改业务代码**

若现有测试文件还没有稳定的 `renderAppShell()` 帮助函数，补一个最小版本：

```tsx
function renderAppShell(mutate?: (seed: ReturnType<typeof createSeedDatabase>) => void) {
  const seed = createSeedDatabase();
  mutate?.(seed);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seed));

  return render(
    <RpmsProvider>
      <ConfirmProvider>
        <AppShell>
          <div>content</div>
        </AppShell>
      </ConfirmProvider>
    </RpmsProvider>,
  );
}
```

- [ ] **Step 4: 重新跑测试，确保失败原因只剩结构未实现**

Run:

```bash
npm test -- --run src/components/__tests__/app-shell.test.tsx
```

Expected:

```text
FAIL with assertions about missing/new menu hierarchy only
```

---

### Task 2: 重构 `AppShell` 的菜单信息架构

**Files:**
- Modify: `src/components/app-shell.tsx`
- Test: `src/components/__tests__/app-shell.test.tsx`

- [ ] **Step 1: 重组 groupedMenus，让“项目列表”进入项目经营驾驶舱**

把当前独立的 `showProjectList` 顶层 Link 逻辑并入 `groupedMenus` 第一组，目标结构类似：

```tsx
const groupedMenus = [
  {
    title: "项目经营驾驶舱",
    permissionKey: NAV_GROUP_PERMISSION_KEYS.projectDashboard,
    items: [
      {
        href: "/projects",
        label: "项目列表",
        active: pathname === "/projects",
        permissionKey: "project-list:view",
      },
      {
        href: detailHrefs.project,
        label: "项目信息管理",
        active: isDetailGroupActive(fullPath, "project"),
        permissionKey: getDetailGroupPermissionKey("project"),
      },
    ],
  },
  // 其余三组继续保留
];
```

注意：这里不要再单独渲染顶层 `项目列表` Link。

- [ ] **Step 2: 统一 4 个一级分组的过滤逻辑**

保留现有模式：

```tsx
const visibleGroups = groupedMenus
  .map((group) => ({
    ...group,
    items: group.items.filter((item) => can(item.permissionKey)),
  }))
  .filter((group) => group.items.length > 0);
```

这里的关键点：

- 一级分组是否显示，取决于子项是否还有可见项
- 不要新增新的业务权限键
- 不要再用旧的 `showProjectList` 单独参与渲染

- [ ] **Step 3: 让“项目采购管理”也并入统一分组体系**

将原先单独渲染的 `showProjectProcurementGroup` 区块，改为 groupedMenus 中的一个正常组，而不是额外的独立 JSX 分支。结构示意：

```tsx
{
  title: "项目采购管理",
  permissionKey: NAV_GROUP_PERMISSION_KEYS.projectProcurement,
  items: [
    {
      href: "/procurement/required-parts",
      label: "必换件采购管理",
      active: pathname.startsWith("/procurement/required-parts"),
      permissionKey: "required-parts-procurement:view",
      meta: "按权限显示",
    },
    {
      href: "/procurement/optional-parts",
      label: "选换件采购管理",
      active: pathname.startsWith("/procurement/optional-parts"),
      permissionKey: "optional-parts-procurement:view",
      meta: "按权限显示",
    },
    {
      href: "/procurement/structural-parts",
      label: "结构件采购管理",
      active: pathname.startsWith("/procurement/structural-parts"),
      permissionKey: "structural-parts-procurement:view",
      meta: "按权限显示",
    },
  ],
}
```

实现时可以给 item 扩展可选字段 `meta?: string`，并在渲染时兼容：

```tsx
{item.meta && <span className="rpms-nav-link-meta">{item.meta}</span>}
```

- [ ] **Step 4: 跑测试，确认层级结构已转绿**

Run:

```bash
npm test -- --run src/components/__tests__/app-shell.test.tsx
```

Expected:

```text
PASS
```

---

### Task 3: 优化侧边栏视觉层级为企业后台风格

**Files:**
- Modify: `src/components/app-shell.tsx`
- Test: `src/components/__tests__/app-shell.test.tsx`

- [ ] **Step 1: 调整一级菜单标题的视觉层级**

把一级标题从当前普通文本升级为更稳定的标题条样式。优先在现有类名基础上微调，不引入新样式文件。目标 JSX 可保持：

```tsx
<div className="rpms-nav-group-title">项目经营驾驶舱</div>
```

但配套容器类建议更像：

```tsx
<div key={group.title} className="rpms-nav-group space-y-2 border-t border-slate-800/80 pt-3 first:border-t-0 first:pt-0">
```

目标视觉：

- 分组之间用留白和细分割，而不是重复大块卡片
- 一级标题字重更高、字号更清楚
- 一级标题与二级项的距离更稳定

- [ ] **Step 2: 把二级菜单从“厚卡片”改成更轻的列表项**

将二级项类名从现在的大块按钮感，调整为更轻、更紧凑。例如：

```tsx
className={`rpms-nav-link rpms-nav-link-child min-h-0 px-3 py-2 text-sm ${item.active ? "rpms-nav-link-active" : ""}`}
```

若当前 `rpms-nav-link` 自带过厚的块感，可在本组件内通过补充类名来弱化：

- 更小的 padding
- 更低的背景对比
- 更轻的边框存在感
- 更清晰的 active 对比

不要改成树控件；仍保持列表式后台导航。

- [ ] **Step 3: 保留“待办中心”为独立入口，但让它与分组视觉更协调**

`待办中心` 不并组，但应与四个一级分组在视觉上更和谐。最小调整方向：

```tsx
<Link href="/todos" className={`rpms-nav-link ${pathname.startsWith("/todos") ? "rpms-nav-link-active" : ""}`}>
  <span>待办中心</span>
  <span className="rpms-nav-link-meta">第一阶段保留</span>
</Link>
```

保持功能不变，只让它不要显得像“另一种体系的按钮”。

- [ ] **Step 4: 手动检查 active 态是否仍准确**

至少检查以下路径下高亮是否正确：

```text
/projects
/projects/{id}?nav=project
/projects/{id}?nav=scope-tech
/procurement/required-parts
/procurement/optional-parts
/procurement/structural-parts
/role-config
/admin/permissions
/todos
```

如果 active 错乱，只修 `app-shell.tsx` 的 active 判定，不改路由工具层。

---

### Task 4: 回归验证并收口

**Files:**
- Modify: `src/components/__tests__/app-shell.test.tsx`（如为稳定断言需要微调）
- Test: `src/components/__tests__/app-shell.test.tsx`
- Test: `src/lib/__tests__/navigation.test.ts`

- [ ] **Step 1: 跑侧边栏 targeted tests**

Run:

```bash
npm test -- --run src/components/__tests__/app-shell.test.tsx src/lib/__tests__/navigation.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 2: 跑类型检查**

Run:

```bash
npm run typecheck
```

Expected:

```text
tsc --noEmit exits 0
```

- [ ] **Step 3: 跑 lint**

Run:

```bash
npm run lint
```

Expected:

```text
eslint exits 0
```

- [ ] **Step 4: 输出变更摘要并确认验收点**

最终回报时必须明确说明：

- 项目列表已进入“项目经营驾驶舱”二级菜单
- 四个一级分组已经统一为真正一级菜单
- 项目采购管理仍按子权限显示
- 只动了导航展示层，没有改业务逻辑
- 附上测试、typecheck、lint 结果
