# Ceastar项目管理系统

**项目管理与进度追踪后台** | 基于 Next.js + Prisma + PostgreSQL

---

## 功能概览

### 已实现的核心功能

| 模块 | 功能 |
|------|------|
| **认证与权限** | 真实登录/登出、JWT 鉴权、树形权限配置、按角色控制页面和操作可见性 |
| **后台账号管理** | 账号增删改查、启用/停用、角色分配、重置密码（固定 `88888888`） |
| **项目角色管理** | 角色定义、人角色多配置、权限树逐节点勾选配置 |
| **项目列表** | 项目创建、搜索筛选、状态管理、数据导出 |
| **项目详情** | 项目信息、项目组成员、交付设备、技术协议、交付文档 |
| **必换件管理** | 必换件清单增删改、设备选择导入、CSV 导入导出、模板下载 |
| **必换件推送** | 推送前校验（项目状态/成员/设备/必换件/差异）、差异计算预览、确认推送、自动作废旧待接收版本 |
| **必换件采购** | 推送差异查看、整体接收/退回、自动生成采购记录、采购执行字段维护（单价/周期/厂家/日期/状态） |
| **选换件管理** | 选换件清单维护、推送管理、采购执行 |
| **结构件管理** | 结构件清单维护、推送管理、采购执行 |
| **待办中心** | 待办展示、待办数量红圈提示、点击"去处理"直达推送/采购页 |
| **操作历史** | 关键流程全程留痕（推送创建/接收/退回/作废、采购增删改、上游变更打标） |
| **数据持久化** | Prisma + SQLite，真实数据库，刷新不丢数据 |

---

## 技术栈

| 层 | 技术 |
|----|------|
| 前端框架 | Next.js 16.2.4 (App Router) + TypeScript |
| UI | Tailwind CSS v4 + Radix UI (shadcn/ui 风格) |
| 数据库 | PostgreSQL + Prisma ORM |
| 认证 | JWT (jsonwebtoken) + bcryptjs |
| 部署 | Docker (多阶段构建) / 本地 node 直跑 |
| 测试 | Vitest + React Testing Library |

---

## 快速启动

### 本地运行

```bash
# 安装依赖
npm ci

# 生成 Prisma Client
npx prisma generate

# 初始化数据库并写入基础数据
npx prisma db push
npx prisma db seed

# 构建并启动
npm run build
npm run start
```

访问 **http://localhost:3000**

### 初始管理员账号

| 账号 | 密码 | 角色 |
|------|------|------|
| `admin` | `admin123` | 系统管理员 |

初始化数据不包含演示项目、演示事项或普通演示账号。

### Docker 部署（Windows/macOS/Linux）

```bash
docker compose up -d --build
```

详见 `deploy-windows.md`。

---

## 项目结构

```
Code/
├── prisma/
│   ├── schema.prisma      # 10 个数据模型
│   ├── seed.ts            # 基础数据（角色/管理员/权限树）
├── src/
│   ├── app/
│   │   ├── api/            # 36+ 个 REST API 端点
│   │   ├── admin/accounts/ # 后台账号管理页
│   │   ├── procurement/    # 采购管理（必换件/选换件/结构件）
│   │   ├── projects/       # 项目列表 + 项目详情
│   │   ├── role-config/    # 项目角色与人员管理
│   │   ├── todos/          # 待办中心
│   │   ├── login/          # 登录页
│   │   ├── force-change-password/ # 首次登录改密页
│   │   ├── layout.tsx      # 根布局
│   │   └── page.tsx        # 首页（自动跳转登录）
│   ├── components/
│   │   ├── app-shell.tsx   # 全局 shell（顶部栏 + 侧边栏 + 待办红圈）
│   │   └── ...             # 可复用组件
│   ├── contexts/
│   │   ├── auth-context.tsx       # 认证上下文（登录/登出/刷新）
│   │   └── permission-context.tsx # 权限树全局状态
│   ├── domain/
│   │   ├── enums.ts        # 枚举定义
│   │   ├── models.ts       # 领域模型
│   │   └── services/       # 核心业务逻辑（推送/校验/采购规则）
│   ├── lib/
│   │   ├── auth.ts         # JWT + bcrypt 工具
│   │   ├── api-client.ts   # 前端 API 客户端（自动携带 token / 401 处理）
│   │   ├── permissions.ts  # 权限树定义
│   │   ├── operation-history.ts  # 操作历史中文格式化
│   │   └── ...             # 其他工具
│   └── state/
│       └── project-filter.tsx # 项目筛选工具
├── Dockerfile              # Docker 多阶段构建
├── docker-compose.yml      # Docker Compose 部署
├── deploy-windows.md       # Windows 部署指南
└── README.md               # 本文件
```

---

## 常用命令

```bash
npm run dev          # 开发模式（热更新）
npm run build        # 生产构建
npm run start        # 启动生产服务
npm test             # 运行单测
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 检查

npx prisma studio   # Prisma 数据库管理 UI
```

---

## 数据库

- **类型**：PostgreSQL
- **ORM**：Prisma
- **模型数量**：14 个（UserAccount, Project, ProjectGanttTask, ProjectBudgetCategory, WeeklyItem, RiskRegisterItem, TodoItem, OperationHistory, PermissionTree 等）
- **持久化**：Docker 运行时数据保存在 `pgdata` 命名卷中

---

## 许可

内部项目 - 仅供授权人员使用。
