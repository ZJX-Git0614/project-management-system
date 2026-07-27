# Ceastar PMS Windows x86 Docker 更新镜像制作指南

本文档用于在没有历史聊天、没有部署上下文的情况下，从 Ceastar PMS 源代码制作可交付给 Windows 10/11 x86-64 内网电脑的离线更新镜像和更新包。

## 1. 先明确产物性质

- 目标电脑是 Windows x86-64，但 Docker Desktop 运行的是 Linux 容器。
- 因此应用镜像的平台必须是 `linux/amd64`，不是 Windows 容器镜像。
- 更新包只包含应用镜像、更新脚本、回退脚本和说明文档。
- 更新包不得包含 PostgreSQL 数据、上传文档、备份目录、`.env`、API Key 或其他业务数据。
- 更新只重建 `pms` 应用容器，不重建 PostgreSQL 数据卷和文档数据卷。

## 2. 识别正确的源代码目录

进入同时包含以下文件和目录的仓库根目录：

```text
Dockerfile
docker-entrypoint.sh
docker-compose.yml
package.json
package-lock.json
prisma/
src/
deployment/windows-x86/
```

本项目当前仓库根目录示例：

```text
/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code
```

不要在 `deployment/windows-x86` 目录内执行 Docker 构建；Docker 构建上下文必须是仓库根目录。

## 3. 环境要求

构建电脑需要：

- Docker Desktop 或 OrbStack，Docker daemon 正常运行；
- Docker Buildx；
- Node.js 20 或更高版本；
- npm；
- 至少 5 GB 可用磁盘空间；
- 首次构建时能够访问 npm 和 Debian 软件源。

检查环境：

```bash
docker info
docker buildx version
node --version
npm --version
```

构建前检查 `.dockerignore`，至少必须排除：

```text
.env
**/.env
.local-runtime
**/.local-runtime
backups/**
*.dump
*.tar
*.tar.gz
deployment/windows-x86/images
```

`.env.example` 可以保留，但任何真实 `.env` 都不能进入 Docker build context。

不要使用 `**/backups`：该规则会同时排除源码中的
`src/app/api/admin/system-data/backups`，导致系统数据备份 API 缺失。

## 4. 确认本次要发布的源代码

构建镜像会包含当前工作目录中的全部文件，包括尚未提交的更改。构建前必须记录源代码状态：

```bash
git branch --show-current
git rev-parse HEAD
git status --short
```

如果 `git status --short` 有输出，必须确认这些更改确实属于本次更新。不要为了得到干净状态而运行 `git reset --hard` 或覆盖用户文件。

建议把以下信息写入发布记录：

```text
发布版本：YYYY.MM.DD
源分支：分支名
源提交：完整 Git commit SHA
工作区状态：clean 或包含哪些未提交文件
构建时间：YYYY-MM-DD HH:mm:ss
```

## 5. 定义版本号

每次更新使用两个版本变量：

```bash
RELEASE_VERSION=2026.07.27.2
RELEASE_STAMP=20260727-2
IMAGE_NAME=ceastar-project-management:${RELEASE_VERSION}-amd64
PACKAGE_NAME=Ceastar-PMS-更新包-${RELEASE_STAMP}
```

规则：

- `RELEASE_VERSION` 用于 Docker 镜像标签；
- `RELEASE_STAMP` 用于更新包、回退镜像和状态文件；
- 新版本不得复用旧版本号；
- 镜像标签必须以 `-amd64` 结尾，便于人工识别平台。

## 6. 更新发布模板中的版本号

发布模板位于：

```text
deployment/windows-x86/
```

至少检查以下文件：

```text
image-name.txt
update.ps1
rollback.ps1
更新手册.txt
```

需要同步修改：

- `image-name.txt` 中的新镜像标签；
- `update.ps1` 中的回退镜像标签；
- `update.ps1` 和 `rollback.ps1` 中的 `.ceastar-update-YYYYMMDD.state` 文件名；
- 更新手册中的版本号和更新包目录名。

检查是否还有旧版本号残留：

```bash
rg -n '20260724|2026\.07\.24|rollback-' deployment/windows-x86
```

将命令中的旧版本替换为上一次发布版本。所有残留都必须逐项确认，不能盲目批量替换路径中的其他日期。

Windows 脚本兼容要求：

- `.bat` 和 `.ps1` 使用 CRLF 换行；
- 为避免控制台乱码，脚本输出优先使用 ASCII 英文；
- 中文纯文本说明使用 UTF-8 with BOM；
- 不要把密钥写入脚本或镜像。

## 7. 构建前验证源代码

在仓库根目录执行：

```bash
npm ci
npm test
npm run lint
npm run typecheck
npm run build
git diff --check
```

验收条件：

- 测试全部通过；
- ESLint 无错误；
- TypeScript 类型检查通过；
- Next.js 生产构建通过；
- `git diff --check` 无空白符错误。

任何一项失败都不要继续制作正式更新包。

## 8. 构建 Windows x86 目标镜像

即使构建电脑是 Apple Silicon，也必须显式指定 `linux/amd64`：

```bash
docker buildx build \
  --platform linux/amd64 \
  --tag "${IMAGE_NAME}" \
  --load \
  .
```

PowerShell 等价命令：

```powershell
$ReleaseVersion = "2026.07.27.2"
$ImageName = "ceastar-project-management:$ReleaseVersion-amd64"
docker buildx build --platform linux/amd64 --tag $ImageName --load .
```

不要省略 `--platform linux/amd64`。否则在 ARM Mac 上生成的镜像会在 x86 Windows 上报 `exec format error`。

## 9. 验证镜像平台和关键运行文件

验证镜像架构：

```bash
docker image inspect "${IMAGE_NAME}" --format '{{.Os}}/{{.Architecture}} {{.Id}}'
```

必须看到：

```text
linux/amd64
```

验证容器内 Node 平台、应用产物、Prisma、Java MPXJ 转换器和迁移文件：

```bash
docker run --rm --entrypoint sh "${IMAGE_NAME}" -lc '
  node -p "process.platform + \"/\" + process.arch" &&
  java -version &&
  test -d /app/.next &&
  test -f /app/prisma/schema.prisma &&
  test -f /opt/ceastar/mpp-converter.jar &&
  pg_dump --version | grep "PostgreSQL) 16\." &&
  pg_restore --version | grep "PostgreSQL) 16\." &&
  test -f /app/.next/server/app/api/admin/system-data/backups/route.js &&
  find /app/prisma/manual-migrations -maxdepth 1 -type f -name "*.sql" -print
'
```

第一行必须是：

```text
linux/x64
```

如果 Java 或 `/opt/ceastar/mpp-converter.jar` 不存在，MPP 导入在旧款 x86 Windows Docker 环境中会失败，不能发布该镜像。生产环境不再依赖需要 AVX2 的 mppjs 原生转换器。
如果 `pg_dump` 或 `pg_restore` 不是 16.x，系统备份无法连接 PostgreSQL 16，也不能发布该镜像。

## 10. 可选的临时运行验证

正式更新前，优先使用独立测试数据库做一次容器启动验证。不要把测试容器连接到生产数据卷。

最低限度应确认：

- 容器能够启动；
- `/login` 返回 HTTP 200；
- Prisma Client 能加载；
- 手动增量迁移无错误；
- MPP 样例能够转换为 Project XML；
- 不会执行生产种子数据覆盖。

Windows 生产部署使用以下保护变量：

```yaml
SKIP_PRISMA_DB_PUSH: "true"
SKIP_PRISMA_SEED: "true"
```

这两个变量必须保留。现有数据库结构通过 `prisma/manual-migrations/*.sql` 中可重复执行的增量 SQL 更新。

## 11. 导出离线镜像

创建更新包目录：

```bash
mkdir -p "/目标目录/${PACKAGE_NAME}/images"
```

导出镜像：

```bash
docker save \
  --output "/目标目录/${PACKAGE_NAME}/images/ceastar-pms-${RELEASE_VERSION}-amd64.tar" \
  "${IMAGE_NAME}"
```

镜像 tar 可能有数百 MB，不能用文本编辑器打开或重新压缩其中内容。

## 12. 生成 SHA-256 校验值

macOS/Linux：

```bash
shasum -a 256 "/目标目录/${PACKAGE_NAME}/images/ceastar-pms-${RELEASE_VERSION}-amd64.tar"
```

将输出中的纯哈希值写入：

```text
image.sha256
```

Windows PowerShell：

```powershell
(Get-FileHash ".\images\ceastar-pms-2026.07.27.2-amd64.tar" -Algorithm SHA256).Hash.ToLowerInvariant()
```

同时创建 `image-name.txt`，内容必须与构建时的镜像标签完全一致：

```text
ceastar-project-management:2026.07.27.2-amd64
```

## 13. 组装更新包

最终目录结构必须是：

```text
Ceastar-PMS-更新包-YYYYMMDD/
├── image-name.txt
├── image.sha256
├── update.bat
├── update.ps1
├── rollback.bat
├── rollback.ps1
├── 更新手册.txt
└── images/
    └── ceastar-pms-YYYY.MM.DD-amd64.tar
```

从 `deployment/windows-x86/` 复制脚本和手册。不要复制以下内容：

```text
.env
backups/
database.dump
project-documents.tar.gz
data/
node_modules/
.next/
```

更新包中只允许有一个 `.tar` 镜像文件，否则 `update.ps1` 会拒绝执行。

## 14. 更新脚本必须具备的行为

`update.ps1` 必须按以下顺序执行：

1. 找到原部署目录中的 `docker-compose.yml` 和 `backup.ps1`；
2. 检查 Docker Desktop；
3. 校验镜像 tar 的 SHA-256；
4. 把当前运行镜像标记为本次发布专用的 rollback 镜像；
5. 调用原部署目录中的 `backup.ps1` 备份 PostgreSQL 和上传文档；
6. `docker load` 加载新镜像；
7. 把新镜像标记成原 `docker-compose.yml` 当前引用的镜像名；
8. 只执行 `docker compose up -d --no-deps --force-recreate pms`；
9. 等待 `http://localhost:3000/login` 恢复；
10. 写入本次版本独立的状态文件，供 `rollback.ps1` 使用。

更新脚本不得执行：

```text
install.bat
install.ps1 -Force
docker compose down -v
docker volume rm
prisma db push --accept-data-loss
```

## 15. 压缩和完整性检查

在 macOS 上制作给 Windows 使用的 ZIP 时，不要包含 `__MACOSX` 和 `.DS_Store`：

```bash
cd /目标目录
zip -r -X "${PACKAGE_NAME}.zip" "${PACKAGE_NAME}"
```

检查 ZIP：

```bash
unzip -t "/目标目录/${PACKAGE_NAME}.zip"
unzip -l "/目标目录/${PACKAGE_NAME}.zip"
```

检查包内没有数据或密钥：

```bash
unzip -l "/目标目录/${PACKAGE_NAME}.zip" | rg '__MACOSX|\.DS_Store|\.env|backups/|database\.dump|project-documents'
```

该命令应无输出。

## 16. 交付到 Windows 内网电脑后的操作

1. 把整个 ZIP 复制到目标电脑；
2. 解压得到完整更新包目录；
3. 把更新包目录放到原部署目录内，与 `docker-compose.yml` 直接相邻；
4. 启动 Docker Desktop；
5. 等待当前用户保存操作并退出系统；
6. 双击更新包中的 `update.bat`；
7. 等待窗口显示 `Ceastar PMS update completed successfully.`；
8. 打开 `http://localhost:3000`，使用原账号登录；
9. 检查项目、任务、事项、风险、预算和文档数据；
10. 检查本次新增功能和数据库迁移结果。

如果更新失败，运行同一更新包中的 `rollback.bat`。回退脚本只恢复应用镜像，不删除数据库中的更新后数据。

## 17. 发布验收清单

- [ ] 源分支和 commit SHA 已记录；
- [ ] 未提交更改已逐项确认；
- [ ] `.dockerignore` 已排除密钥、数据库、备份、上传文档和历史镜像；
- [ ] `npm test` 通过；
- [ ] `npm run lint` 通过；
- [ ] `npm run typecheck` 通过；
- [ ] `npm run build` 通过；
- [ ] 镜像平台为 `linux/amd64`；
- [ ] 容器内 Node 平台为 `linux/x64`；
- [ ] Java 21 运行时与 MPXJ 转换 JAR 存在；
- [ ] 真实 MPP 样例已在 `linux/amd64` 容器内转换为 Project XML；
- [ ] Prisma schema 和增量迁移已进入镜像；
- [ ] 镜像 tar 的 SHA-256 已复核；
- [ ] 更新脚本和回退脚本使用本次版本号；
- [ ] 更新包不含 `.env`、数据库、上传文档和备份；
- [ ] ZIP 完整性检查通过；
- [ ] 更新前自动备份逻辑仍然存在；
- [ ] 更新过程只重建 `pms` 容器；
- [ ] 回退镜像和状态文件使用本次独立版本号。

## 18. 常见问题

### 构建时网络错误

`apt-get` 或 `npm ci` 下载失败时，确认构建电脑网络和代理后重新执行同一个 `docker buildx build` 命令。不要在失败镜像上继续打包。

### Windows 报 `exec format error`

镜像架构不是 `linux/amd64`。重新使用 `--platform linux/amd64` 构建，并在导出前执行架构检查。

### MPP 导入提示转换器不存在

检查镜像内是否存在：

```text
/opt/ceastar/mpp-converter.jar
```

同时执行 `java -version`。任一项失败都说明更新镜像不完整，需重新导入本次离线镜像。

### MPP 导入出现 `path argument ... number`

新版生产镜像应优先调用 Java MPXJ 转换器：

```text
/opt/ceastar/mpp-converter.jar
```

### 更新后页面无法访问

在原部署目录执行：

```powershell
docker compose ps
docker compose logs --tail 200 pms
docker compose logs --tail 200 postgres
```

### 数据是否会进入 Docker 镜像

正常构建不会包含 PostgreSQL 数据卷或上传文档卷。仍需检查 Docker build context 中不存在数据库 dump、`.env` 和备份目录，并确保 `.dockerignore` 排除了这些内容。

## 19. 最终发布记录

每次发布至少保存以下信息：

```text
Release version:
Release stamp:
Git branch:
Git commit:
Working tree status:
Docker image name:
Docker image ID:
Image platform:
Image tar SHA-256:
Package ZIP SHA-256:
Build operator:
Build time:
Test results:
Known limitations:
```

该记录和更新包一起归档，但不得在记录中写入数据库密码、JWT 密钥、模型 API Key 或云盘认证信息。
