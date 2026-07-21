# RPMS UI + 智能助手迁移设计（项目管理系统）

**日期**：2026-07-21  
**状态**：已评审通过（对话确认）  
**目标仓库**：`~/Documents/项目管理系统/dev-repo/Code`  
**参考源**：`~/Desktop/RPMS系统/dev-repo/Code`

---

## 1. 背景与目标

将 RPMS 前端的 **UI 体系（组件、动画、交互）** 与 **智能助手（用户所称「智能住搜」）** 迁移到 Ceastar 项目管理系统（PMS），并按 PMS 经营驾驶舱领域做适配。

### 1.1 已确认决策

| 项 | 选择 |
|----|------|
| 智能能力类型 | **A** 智能助手对话（非全局 Command Palette、非侧栏菜单过滤 alone） |
| 交付包 | **D** UI 打磨 + 核心查询助手一起做 |
| UI 对齐深度 | **B** 全系统组件级对齐 |
| 助手查询领域 | **B** 经营核心 + 预算 + 甘特（只读） |
| 实现路径 | **A** 从 RPMS 移植壳层/交互 + PMS 领域查询层重写 |

### 1.2 成功标准（摘要）

1. 任意业务页观感与 RPMS 同系：深色工程后台、1px 边框、34px 控件、150–180ms 克制动效。  
2. 壳层具备：顶栏 / 侧栏 / 菜单关键词过滤 / 项目切换 / 待办角标。  
3. 助手：可拖拽浮动球（位置记忆）、侧栏对话、快捷问题、来源标签（DATABASE / MODEL）。  
4. 对当前项目可查询：概况、本月/本周事项、成员、待办、预算、甘特；无项目时可答组合总览。  
5. 无 RPMS 备件/采购/审批语义泄漏；第一期无 RAG、无写操作动作流。

---

## 2. 范围

### 2.1 做

**UI**

- 全局 token / `globals.css` 与 RPMS 设计规范对齐（PMS 可用 `--app-*` 命名，语义对齐 `--rpms-*`）。  
- 基础组件：Button、Input、Textarea、Select、Dialog、Modal、Table、Badge、Card、Tooltip、Dropdown、Toast/Feedback、Confirm。  
- `app-shell`：布局结构、侧栏分组导航、菜单搜索过滤、项目切换器、待办计数展示。  
- 业务页密度与状态统一：overview、projects、monthly-items、weekly-items、预算/甘特相关面板、空态/加载/错误。

**智能助手**

- 前端壳：对齐 RPMS `rpms-assistant` 的交互模型（浮动球、侧栏、最大化、Esc 关闭、快捷 chips），产品命名为 **「项目智能助手」**（不强制「星星」品牌文案；视觉可借鉴）。  
- API：`POST /api/assistant/chat`（鉴权复用现有 JWT）。  
- 领域上下文聚合与只读查询：Project、MonthlyItem、WeeklyItem、TodoItem、ProjectMember、ProjectBudgetCategory/Item/Setting、ProjectGanttTask、跨项目总览。  
- 双源：`DATABASE` 结构化直出；`MODEL` 在配置可用时做归纳（不可用则回退 DATABASE 摘要）。

### 2.2 不做（第一期）

- RAG / 项目知识库 / `MODEL_RAG`  
- Agent 写操作、动作确认/取消卡片、导出中心  
- 人设切换、完整头像设置后台页（可选后续）  
- 全局 Command Palette（Ctrl/Cmd+K）  
- RPMS 备件、采购、审批、设备照片等领域  
- 抽离双系统共享 npm 包（路径 C，工期过长）

---

## 3. 架构

```
[ UI ]
  app-shell
  全局 shadcn/ui 风格组件（对齐 RPMS 规范）
  ProjectAssistant（浮动球 + 侧栏对话）
        │
[ API ]
  POST /api/assistant/chat
  （可选）模型配置探测 / status
        │
[ 编排 · PMS 专用 ]
  pms-assistant-context.ts   // 聚合只读上下文
  pms-assistant-query.ts     // 意图分流 + 结构化答 + 模型提示
        │
[ 数据 · Prisma SQLite ]
  现有 PMS schema（项目经营相关表）
```

### 3.1 与 RPMS 的关系

| 层 | 策略 |
|----|------|
| 视觉 token / 动效 / 组件交互 | 移植并本地化到 PMS（禁止硬编码 RPMS 业务文案） |
| 助手 UI 壳 | 移植交互，命名与文案 PMS 化 |
| 查询与工具 | **不复用** RPMS assistant-query 业务；按 PMS 表重写 |
| 鉴权 / API 响应格式 | 复用 PMS 现有 `auth` / `api-utils` |

### 3.2 助手请求数据流

1. 用户输入或点击快捷问题。  
2. `POST /api/assistant/chat`，body：`{ message, projectId?, history? }`。  
3. `buildPmsContext(projectId)` 聚合当前项目与必要组合数据。  
4. 意图分流：  
   - 可结构化回答 → `source: DATABASE`，Markdown 直出；  
   - 需归纳/对比 → 注入上下文调 MODEL；失败则 DATABASE 回退。  
5. 响应：`{ assistantMessage: { content, source, createdAt }, suggestions? }`。  
6. 前端渲染消息与来源徽章。

### 3.3 错误与边界

| 场景 | 行为 |
|------|------|
| 未登录 | 401，跳转登录 |
| 无当前项目 | 仅组合总览；提示先选项目 |
| 模型未配置 | 欢迎区提示；回答以 DATABASE 为主 |
| 模型超时/失败 | 错误气泡 + 可重试；保留历史 |
| 空结果 | 明确「未找到」+ 1–2 个建议问法 |
| 写操作意图 | 明确「当前版本仅支持查询」 |
| 权限 | 与现站一致（登录鉴权）；第一期不做字段级脱敏增强 |

---

## 4. UI 对齐规范（执行约束）

对齐桌面文档 `RPMS_前端编码UI实现提示词.md` 与 RPMS `globals.css`：

- 气质：深色专业工程管理中台 + 克制科技蓝；非玻璃拟态/赛博霓虹/营销大留白。  
- 布局：topbar ~56–60px；sidebar ~280–300px；main 内边距 14–16px；page 8px 圆角 + 1px 边框。  
- 控件高度约 34px；圆角 6–8px；动效 150–180ms。  
- 状态齐全：default / hover / focus / active / disabled / loading / empty / error。

PMS 已有 `--app-*` token 时，以语义对齐为主，避免两套视觉并存。

---

## 5. 助手查询能力映射

| 用户意图 | 数据源 |
|----------|--------|
| 项目概况 / 状态 / 周期 / 金额 | `Project` |
| 本月事项 | `MonthlyItem` |
| 本周事项 | `WeeklyItem` |
| 成员与角色 | `ProjectMember`（+ 角色配置展示） |
| 待办 | `TodoItem` |
| 预算分类 / 条目 / 利润目标 | `ProjectBudgetCategory` / `ProjectBudgetItem` / `ProjectBudgetSetting` |
| 甘特任务 | `ProjectGanttTask` |
| 跨项目总览 | 多 `Project` 聚合 + 事项/待办计数 |

快捷问题示例（随是否选中项目变化）：

- 当前项目进度概况？  
- 本周有哪些风险/逾期事项？  
- 预算与利润率目标？  
- 甘特关键任务有哪些？  
- 我的待办？  

---

## 6. 关键文件（预期落地）

**参考（只读）**

- `Desktop/RPMS系统/dev-repo/Code/src/components/rpms-assistant.tsx`  
- `Desktop/RPMS系统/dev-repo/Code/src/components/app-shell.tsx`  
- `Desktop/RPMS系统/dev-repo/Code/src/app/globals.css`  
- `Desktop/RPMS系统/dev-repo/Code/src/app/api/assistant/**`  
- `Desktop/RPMS系统/dev-repo/Code/src/lib/assistant-*.ts`（仅交互/外观可借鉴，业务 query 不照搬）

**PMS 目标（改/增）**

- `src/components/project-assistant.tsx`（增强至 RPMS 级交互）  
- `src/components/app-shell.tsx`  
- `src/components/ui/*`  
- `src/app/globals.css`  
- `src/app/api/assistant/chat/route.ts`  
- `src/lib/pms-assistant-context.ts`（新建）  
- `src/lib/pms-assistant-query.ts`（新建）  
- 相关业务页与面板样式统一  

---

## 7. 实施顺序

1. Token / 全局样式 / 基础 UI 组件对齐  
2. `app-shell` 与导航、项目切换、菜单过滤对齐  
3. 业务页密度与状态组件统一  
4. 助手壳层移植（UI 交互）  
5. PMS context + query + chat API 适配  
6. 验收与回归（含 chat route 与助手 UI 冒烟测试）

---

## 8. 验收清单

- [ ] 业务页视觉与 RPMS 同系（token、边框、控件、动效）  
- [ ] 侧栏菜单关键词过滤可用  
- [ ] 项目切换器可用  
- [ ] 助手球可拖拽并记忆位置；侧栏开/关/最大化  
- [ ] 当前项目可答：概况、本月/本周、成员、待办、预算、甘特  
- [ ] 无项目时可答组合总览且不崩溃  
- [ ] 模型配置开/关两条路径均可用  
- [ ] 无 RPMS 备件/审批泄漏文案  
- [ ] 关键路径具备基础自动化测试  

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 全系统 UI 对齐范围膨胀 | 严格按实施顺序；业务逻辑不重写，只统一视觉与交互壳 |
| 从 RPMS 误带业务依赖 | 查询层白名单表；代码 review 禁引入 RPMS-only 模块 |
| 模型配置环境差异 | DATABASE 回退为默认可用路径 |
| 与工作区已有未提交 UI/助手改动冲突 | 实现前先 diff 现有 `dev-repo/Code` 变更，在其上收敛而非平行重写 |

---

## 10. 后续（非本期）

- 人设 / 头像设置页  
- RAG / 项目文档知识库  
- 确认式写操作（创建事项等）  
- 全局 Command Palette  
- 双系统共享 design system 包  
