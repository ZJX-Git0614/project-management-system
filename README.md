# 项目管理系统

Ceastar 项目管理系统是一个面向项目经营、进度跟踪和预算管理的后台系统。当前代码位于 `dev-repo/Code`，基于 Next.js、React、TypeScript、Prisma 和 SQLite 构建。

## 当前完成情况

已完成的主要模块：

- 登录认证：JWT 登录、登出、Token 刷新、首次改密保护。
- 权限体系：角色配置、树形权限、按角色控制页面和操作入口。
- 项目列表：项目创建、查询、状态维护、当前项目切换。
- 项目信息管理：项目基础信息、项目成员、状态流转。
- 项目进度甘特图：任务排期、关键路径、紧前关系、行内编辑、选择删除、拖拽排序。
- 项目预算管理：预算分类、明细维护、人力/采购/差旅/费率类预算统计。
- 项目进度追踪：项目进度总揽、本月事项、本周事项。
- 待办中心：待办数量和待处理入口。
- 系统设置：角色与人员管理、后台账号管理、操作历史。

## 技术栈

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS v4
- Prisma ORM
- SQLite
- Vitest
- Docker / Docker Compose

## 目录结构

```text
项目管理系统/
├── dev-repo/
│   └── Code/                 # 当前可运行项目
│       ├── prisma/            # Prisma schema 和种子数据
│       ├── src/
│       │   ├── app/           # 页面和 API 路由
│       │   ├── components/    # UI 与业务组件
│       │   ├── contexts/      # 认证、权限、当前项目上下文
│       │   ├── domain/        # 领域枚举和模型
│       │   ├── lib/           # API、权限、鉴权、甘特图等工具
│       │   └── state/
│       ├── Dockerfile
│       ├── docker-compose.yml
│       └── package.json
├── docs/                      # 需求和设计文档
└── prod-repo/                 # 生产目录预留，目前未初始化
```

## 本地启动

进入代码目录：

```bash
cd dev-repo/Code
```

安装依赖：

```bash
npm ci
```

初始化数据库：

```bash
npx prisma generate
npx prisma db push
npx prisma db seed
```

开发模式：

```bash
npm run dev
```

生产构建并启动：

```bash
npm run build
npm run start
```

默认访问地址：

```text
http://localhost:3000
```

## 默认账号

种子数据包含以下账号：

| 账号 | 密码 | 角色 |
| --- | --- | --- |
| `admin` | `admin123` | 管理员 |
| `pm1` | `pm123` | 项目经理 |
| `user1` | `user123` | 项目成员 |

## 常用命令

```bash
npm run lint        # ESLint 检查
npm run typecheck   # TypeScript 类型检查
npm test            # 运行单元测试
npm run build       # 生产构建
npm run start       # 启动生产服务
npx prisma studio   # 打开 Prisma Studio
```

## 数据与版本控制说明

仓库只提交源码、配置和正式文档。本地生成内容不会上传，包括：

- `node_modules`
- `.next`
- `.env`
- `prisma/dev.db`
- 日志文件
- 本地运行状态文件

部署或新环境运行时，请通过 Prisma 命令创建数据库并执行种子数据。

## 当前分支约定

- `main`：已推送到 GitHub 的基础版本。
- `zhaojiaxin_worktree`：后续本地开发和修改分支。

