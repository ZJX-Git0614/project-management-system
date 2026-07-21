# RPMS UI + 项目智能助手迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 WIP 上把项目管理系统的 UI 对齐 RPMS，并收口「项目智能助手」只读查询（经营+预算+甘特），达到设计 spec 验收。

**Architecture:** 不从零重写。PMS 已有 `project-assistant` UI/API/lib、对齐中的 `globals.css` 与 `ui/*`。本计划以 **收敛 + 补齐 + 验收** 为主：查询层补 monthly 语义（若表已删除则映射到 weekly/总览）、壳层与 RPMS 交互对齐、seed/schema 保证可演示、测试与 typecheck 通过。

**Tech Stack:** Next.js 16 · React 19 · Tailwind 4 · Prisma · SQLite · Vitest · JWT

**Spec:** `docs/superpowers/specs/2026-07-21-rpms-ui-assistant-migration-design.md`

**Code root:** `dev-repo/Code`

---

## 现状基线（执行前已确认）

| 能力 | 状态 |
|------|------|
| `src/lib/project-assistant.ts` | 已有 context + DATABASE 答 + MODEL 调用 |
| `src/app/api/assistant/chat/route.ts` | GET 历史 / POST 问答 |
| `src/components/project-assistant.tsx` | 浮动球、侧栏、快捷问题、拖拽 |
| `app-shell` 挂载助手 + 侧栏搜索 | 已有 |
| `ui/button` 等 | 与 RPMS 已基本同款 |
| `globals.css` | `--app-*` + 助手动画；未含 RPMS 星星头像全套（本期不做） |
| schema | 有 WeeklyItem / Budget / Gantt / Risk / Document / AssistantChatMessage；**无 MonthlyItem 模型** |
| 测试 | `project-assistant.test.ts` 3 测通过 |

---

## File map

| 文件 | 职责 |
|------|------|
| `src/lib/project-assistant.ts` | 只读上下文与意图回答（增强 monthly 语义映射、写操作拒绝） |
| `src/lib/project-assistant.test.ts` | 意图/回退用例 |
| `src/app/api/assistant/chat/route.ts` | 鉴权、持久化、模型回退 |
| `src/components/project-assistant.tsx` | 助手 UI 与交互打磨 |
| `src/components/app-shell.tsx` | 壳层挂载、菜单过滤、todo 角标 |
| `src/app/globals.css` / `src/components/ui/*` | 视觉与动效对齐（增量） |
| `prisma/schema.prisma` + seed / migrate | 确保 AssistantChatMessage 与演示数据可用 |
| 业务页（按需） | 密度/空态统一，不大改逻辑 |

---

### Task 1: 冻结 WIP 并校验 schema/seed 可运行

**Files:**
- Inspect: `prisma/schema.prisma`, `prisma/seed.ts`, `prisma/manual-migrations/*`
- Possibly modify: `prisma/seed.ts`

- [ ] **Step 1: 确认 Prisma 与 dev.db 同步**

```bash
cd "dev-repo/Code" && npx prisma db push && npx prisma generate
```

Expected: Database in sync; client generated.

- [ ] **Step 2: 确认 seed 覆盖助手演示数据**

至少包含：1 个 IN_PROGRESS 项目、成员、weeklyItems、budget、gantt、todos、open todos。若缺则补 seed 条目后：

```bash
npx prisma db seed
```

- [ ] **Step 3: 跑现有助手测试**

```bash
npm test -- --run src/lib/project-assistant.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit 已存在且正确的助手/UI WIP（若尚未入库）**

仅 stage 与本功能相关文件，避免无关噪音。

```bash
git add dev-repo/Code/src/lib/project-assistant.ts \
  dev-repo/Code/src/lib/project-assistant.test.ts \
  dev-repo/Code/src/app/api/assistant \
  dev-repo/Code/src/components/project-assistant.tsx \
  dev-repo/Code/src/components/assistant-message-content.tsx \
  # + 已对齐的 ui/globals/app-shell 等
git commit -m "feat: land project assistant and RPMS-aligned UI baseline"
```

---

### Task 2: 查询层按设计验收补齐

**Files:**
- Modify: `src/lib/project-assistant.ts`
- Modify: `src/lib/project-assistant.test.ts`

- [ ] **Step 1: 写失败测试 — 本月事项问法、写操作拒绝、预算/甘特关键词**

```ts
it("maps 本月事项 queries to weekly/ops summary without RPMS jargon", () => {
  const answer = buildDatabaseAssistantAnswer("本月事项有哪些风险", context)
  expect(answer).not.toMatch(/备件|采购审批|必换件/)
  expect(answer.length).toBeGreaterThan(20)
})

it("refuses write intents", () => {
  const answer = buildDatabaseAssistantAnswer("帮我新建一个本周事项", context)
  expect(answer).toMatch(/仅支持查询|只读|不支持修改|不能创建/)
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm test -- --run src/lib/project-assistant.test.ts
```

- [ ] **Step 3: 实现**

在 `buildDatabaseAssistantAnswer`：
1. `asks(["本月","月度"])` 走事项汇总（当前 schema 仅 WeeklyItem 时用 weekly + 说明「事项已收敛为本周执行」）。
2. 检测写意图关键词（新建/删除/修改/更新/作废…）→ 固定只读拒绝文案。
3. 确保预算/甘特/成员/待办/总览分支覆盖设计表映射。
4. 禁止出现 RPMS 备件/审批文案。

- [ ] **Step 4: 测试通过并 commit**

```bash
npm test -- --run src/lib/project-assistant.test.ts
git add src/lib/project-assistant.ts src/lib/project-assistant.test.ts
git commit -m "feat(assistant): harden read-only PMS query intents"
```

---

### Task 3: 助手 UI 对齐 RPMS 交互细节

**Files:**
- Modify: `src/components/project-assistant.tsx`
- Modify: `src/app/globals.css`（仅缺啥补啥）

对照 RPMS `rpms-assistant.tsx` 应具备且本期要有的：
- 浮动球拖拽 + localStorage（已有）
- Esc / 点击外侧关闭（已有）
- 最大化（已有）
- 快捷 chips（已有）
- 来源徽章 DATABASE/MODEL（已有）
- 模型未配置提示（补强欢迎文案）
- `prefers-reduced-motion` 下关闭 idle 动画（若 globals 缺则补）

- [ ] **Step 1: 补 reduced-motion 与欢迎区模型提示**

```css
@media (prefers-reduced-motion: reduce) {
  .app-assistant-launcher,
  .app-assistant-launcher[data-thinking="true"] {
    animation: none !important;
  }
}
```

- [ ] **Step 2: 快捷问题与设计对齐**

有项目：`项目概况` / `本周风险事项` / `预算与利润率` / `甘特关键任务` / `我的待办`  
无项目：`项目组合概况` / `进行中的项目` / `我的待办`

- [ ] **Step 3: 手动或组件级冒烟（可选 vitest + testing-library）**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(assistant): polish launcher interactions and prompts"
```

---

### Task 4: 壳层与全局组件对齐收口

**Files:**
- Modify: `src/components/app-shell.tsx`
- Modify: `src/components/ui/*`（与 RPMS diff 仍不同的文件）
- Modify: 业务页仅在明显密度/空态不一致时

- [ ] **Step 1: diff RPMS vs PMS 的 ui 与 app-shell 关键差异**

```bash
diff -u Desktop/RPMS.../ui/input.tsx PMS.../ui/input.tsx | head
# 对 dialog/table/select/textarea/card/tooltip 等同理
```

- [ ] **Step 2: 把仍偏差的 class/动效/高度对齐到 RPMS（保持 PMS 命名 --app-*）**

- [ ] **Step 3: 确认侧栏搜索过滤、项目切换、ProjectAssistant 挂载、todo 角标**

- [ ] **Step 4: Commit**

```bash
git commit -m "style: align shell and UI components with RPMS design system"
```

---

### Task 5: 端到端验收

- [ ] **Step 1: typecheck + lint + test**

```bash
cd dev-repo/Code
npm run typecheck
npm run lint
npm test
```

- [ ] **Step 2: 启动 dev（非 3000）**

```bash
npm run dev:local   # PORT=3002
```

手工检查设计验收清单：
1. 深色工程后台观感  
2. 侧栏过滤 + 项目切换  
3. 助手拖拽/开闭/最大化  
4. 问：概况、本周、成员、待办、预算、甘特  
5. 无项目组合总览  
6. 写操作被拒绝  
7. 无 RPMS 泄漏词  

- [ ] **Step 3: 更新 memory.md 进度（可选）与最终 commit**

```bash
git commit -m "chore: verify RPMS UI + assistant migration acceptance"
```

---

## Spec coverage check

| Spec 要求 | Task |
|-----------|------|
| 全系统 UI 对齐 | T1 baseline + T4 |
| 助手浮动球/侧栏/快捷问题 | T3（基线已有） |
| 只读经营+预算+甘特 | T2 |
| 无 RAG/写操作 | T2 拒绝写 + 不做 RAG |
| DATABASE/MODEL 双源 | 已有 chat route；T2/T5 验收 |
| 无 RPMS 业务语义 | T2 测试 |
| 测试 | T2 + T5 |

## Out of scope（严格执行）

RAG、动作卡、导出、人设设置页、Command Palette、共享 npm 包。
