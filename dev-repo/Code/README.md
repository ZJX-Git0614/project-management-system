# Ceastar项目管理系统

面向项目执行、绩效、进度、成本、事项和风险管理的内部 Web 系统。项目基于 Next.js App Router、Prisma 和 PostgreSQL 构建，支持角色权限、挣值分析、项目进度甘特图、预算成本管理、项目事项、风险登记册、项目智能助手和操作留痕。

## 当前功能

| 模块 | 能力 |
| --- | --- |
| 认证与权限 | JWT 登录、登出、登录态刷新、角色权限树、按权限控制菜单和操作入口 |
| 后台账号管理 | 账号增删改查、启用/停用、角色分配、密码重置 |
| 项目角色管理 | 系统人员库、项目角色配置、项目组成员来源统一到后台账号/人员数据 |
| 项目管理 | 项目创建、编辑、状态维护、项目列表筛选和导出 |
| 项目范围管理 | 按项目阶段维护文档文件夹，上传、下载和删除项目文档，记录目录关联和操作日志 |
| 项目绩效管理 | 按状态日期计算 PV、EV、AC、SV、CV、SPI、CPI、ETC、BAC、EAC、VAC 和 TCPI，支持典型/非典型偏差预测 |
| 项目进度管理 | 项目甘特任务增删改、父子任务、稳定主键依赖、关键路径标记、进度条、拖拽排序、列折叠、多档日期缩放，以及 MPP/XML/Excel 导入导出 |
| 项目事项管理 | 事项增删改、选择删除、责任人下拉、关联任务、风险被动关联、事项 ID 自动编号、拖拽排序和导出 |
| 项目成本管理 | 项目预算分类、预算明细、合同金额、利润率目标、公摊/审价/风险费率管理 |
| 项目风险管理 | 风险登记册增删改、风险 ID 自动编号、关联项目事项、选择删除和拖拽排序 |
| 项目智能助手 | 实时数据库问答、OpenAI 兼容/Ollama 模型供应商、RAGLite 知识检索、回答来源追踪、会话历史，以及需用户确认的待办创建、任务进度更新和项目数据导出 |
| 智能助手设置 | 超级管理员可配置助手启停、名称、欢迎语、人设、外观、模型、向量检索、Agent 工具范围、会话保留策略和连接测试；密钥加密保存 |
| 系统数据管理 | 超级管理员可按项目清空业务模块或整个项目并写入操作日志；支持手动/定时数据库备份、备份导入导出和 WebDAV 云盘目录 |
| 操作历史 | 项目、成员、预算、事项、风险、模块清理等关键操作留痕 |

## 技术栈

| 层 | 技术 |
| --- | --- |
| 前端 | Next.js 16 App Router, React 19, TypeScript |
| UI | Tailwind CSS v4, Radix UI, lucide-react, shadcn/ui 风格组件 |
| 数据库 | PostgreSQL + Prisma ORM |
| 认证 | JWT, bcryptjs |
| 测试 | Vitest, React Testing Library |
| 部署 | 本地 Node.js 或 Docker Compose |

## 快速启动

### 1. 安装依赖

```bash
npm ci
```

### 2. 配置环境变量

创建本地 `.env` 文件，至少包含：

```bash
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DB?schema=public"
JWT_SECRET="replace-with-a-private-secret"
PROJECT_DOCUMENT_STORAGE_DIR="/absolute/path/to/project-document-storage"
ASSISTANT_MODEL_BASE_URL="https://your-model-provider.example/v1"
ASSISTANT_MODEL="your-model-name"
ASSISTANT_MODEL_API_KEY="your-api-key"
ASSISTANT_CONFIG_ENCRYPTION_KEY="replace-with-a-private-encryption-key"
RAGLITE_SERVICE_URL="http://your-raglite-service:8001"
RAGLITE_SERVICE_TOKEN="your-raglite-token"
```

助手模型和 RAGLite 变量可选，也可以由超级管理员在“系统设置 → 智能助手设置”中维护；未配置模型时使用 PostgreSQL 实时数据检索模式。供应商密钥和 RAGLite Token 会使用 `ASSISTANT_CONFIG_ENCRYPTION_KEY` 加密后存入数据库，生产环境必须配置独立高强度密钥。`.env` 不会提交到 GitHub。Docker Compose 中的默认密码、JWT secret 和加密密钥仅用于本地演示，生产环境必须替换。

### 3. 初始化数据库

```bash
npx prisma generate
npx prisma db push
npm run db:seed
```

`PROJECT_DOCUMENT_STORAGE_DIR` 可选；未配置时使用项目目录下的 `.local-runtime/project-documents`。`db:seed` 只初始化非业务基础数据：管理员账号、系统角色和默认权限树。仓库不会写入示例项目、预算、事项、风险或甘特任务数据。

### 4. 构建并启动

```bash
npm run build
PORT=3000 npm run start
```

访问 [http://localhost:3000](http://localhost:3000)。

## 初始账号

| 用户名 | 初始密码 | 角色 |
| --- | --- | --- |
| `admin` | `admin123` | 管理员 |

首次部署后建议立即修改默认密码。

## Docker 启动

```bash
docker compose up -d --build
```

Docker 会启动 PostgreSQL 和 Web 服务，数据库数据保存在 `pgdata` 命名卷中。

## 常用命令

```bash
npm run dev        # 开发模式
npm run build      # 生产构建
npm run start      # 启动生产服务
npm run typecheck  # TypeScript 类型检查
npm run lint       # ESLint 检查
npm test           # 单元测试
npm run db:seed    # 初始化基础账号/角色/权限
npx prisma studio  # Prisma 数据库管理界面
```

## 目录结构

```text
Code/
├── prisma/
│   ├── schema.prisma          # Prisma 数据模型
│   └── seed.ts                # 非业务基础数据初始化
├── src/
│   ├── app/                   # Next.js App Router 页面和 API
│   │   ├── admin/             # 后台账号、操作历史、数据清理
│   │   ├── api/               # REST API 路由
│   │   ├── projects/          # 项目列表和项目详情
│   │   ├── weekly-items/      # 项目事项管理
│   │   ├── risk-register/     # 风险登记册
│   │   └── role-config/       # 角色与人员配置
│   ├── components/            # 页面组件、智能助手和 UI 组件
│   ├── contexts/              # 登录态、权限、当前项目上下文
│   ├── domain/                # 枚举和领域模型
│   └── lib/                   # API、鉴权、权限、甘特图、工具函数
├── docker-compose.yml
├── Dockerfile
└── README.md
```

## 数据与安全说明

- 仓库不应包含 `.env`、数据库文件、导出表格或真实业务数据。
- `prisma/seed.ts` 只写入基础账号、角色和权限树，不写入项目数据。
- 业务元数据存储在 PostgreSQL 中；上传的项目文档存储在 `PROJECT_DOCUMENT_STORAGE_DIR`，Docker 部署使用独立持久化卷。数据库与文件目录都应纳入备份策略，不应提交到 GitHub。
- Docker 生产启动会先执行 Prisma 的结构同步，再按顺序执行 `prisma/manual-migrations/*.sql` 的增量回填脚本；当前脚本只增加字段、索引、外键并回填关联键，不删除业务数据。
- 超级管理员的数据清理功能会记录操作日志，但清理动作不可恢复，使用前需确认项目和模块。

### 数据备份与恢复

生产环境发布前应同时备份 PostgreSQL 和文档存储目录。示例：

```bash
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --no-owner --no-privileges \
  -h "$POSTGRES_HOST" -U "$POSTGRES_USER" "$POSTGRES_DB" > pms_$(date +%Y%m%d%H%M%S).sql
tar -czf project-documents_$(date +%Y%m%d%H%M%S).tar.gz "$PROJECT_DOCUMENT_STORAGE_DIR"
```

Docker PostgreSQL 数据保存在 `pgdata` 命名卷，项目文档保存在 `document_storage` 命名卷；删除容器不会删除卷。禁止使用 `docker compose down -v`，该命令会删除数据库和文档卷。

## 验证状态

当前主要验证命令：

```bash
npm run typecheck
npm run lint
npm test -- --run
npm run build
```

## 许可

内部项目，仅供授权人员使用。
