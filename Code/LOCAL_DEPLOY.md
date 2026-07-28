# 本机双环境部署说明

项目路径：`/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code`

## 目标

在同一台 Mac 上按需运行：

- 仅开发环境：http://localhost:3001
- 仅生产环境：http://localhost:3000
- 开发 + 生产一起启动

说明：
- 开发环境用于日常编码与热更新。
- 生产环境用于验证 build 后效果、做本机演示。
- 由于当前项目数据存储在浏览器 `localStorage`，3000 与 3001 端口的数据天然隔离，互不影响。

## 命令行脚本

已提供脚本：

`/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code/scripts/local-env.sh`

## 命令行用法

先进入项目目录：

```bash
cd "/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code"
```

### 启动

仅启动开发环境：

```bash
./scripts/local-env.sh start dev
```

仅启动生产环境：

```bash
./scripts/local-env.sh start prod
```

同时启动开发 + 生产环境：

```bash
./scripts/local-env.sh start all
```

### 停止

仅停止开发环境：

```bash
./scripts/local-env.sh stop dev
```

仅停止生产环境：

```bash
./scripts/local-env.sh stop prod
```

停止全部环境：

```bash
./scripts/local-env.sh stop all
```

### 重启

```bash
./scripts/local-env.sh restart dev
./scripts/local-env.sh restart prod
./scripts/local-env.sh restart all
```

### 查看状态

```bash
./scripts/local-env.sh status
```

## 可双击 .command 文件

可直接在 Finder 中双击运行：

- `/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code/启动开发环境.command`
- `/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code/启动生产环境.command`
- `/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code/启动全部环境.command`
- `/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code/停止全部环境.command`
- `/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code/查看环境状态.command`

另外还提供了“启动后顺便显示状态”的版本：

- `/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code/启动开发并查看状态.command`
- `/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code/启动生产并查看状态.command`
- `/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code/启动全部并查看状态.command`

这些文件执行后会停在终端窗口，等你按回车再关闭，方便你查看结果。

## 当前端口

- 开发环境：`3001`
- 生产环境：`3000`

## 日志与运行信息

运行目录：
`/Users/zhaojiaxin/Documents/项目管理系统/dev-repo/Code/.local-runtime`

日志文件：
- 开发环境日志：`.local-runtime/dev.log`
- 生产环境日志：`.local-runtime/prod.log`

PID 文件：
- `.local-runtime/dev.pid`
- `.local-runtime/prod.pid`

## 行为说明

### 1. 单独启动哪个环境都可以
脚本支持 `dev`、`prod`、`all` 三种目标。

### 2. 启动生产环境会自动 build
执行 `start prod` 或 `start all` 时，脚本会先自动执行 `npm run build`，然后再启动生产环境。

### 3. 同端口旧进程会先被清理
如果 3000 或 3001 已有旧进程占用，脚本会先尝试结束旧进程，再启动新进程。

### 4. 数据为什么不互通
因为当前项目使用 `localStorage`，浏览器会按协议 + 域名 + 端口隔离存储；`localhost:3000` 和 `localhost:3001` 是两份独立数据。

## 验证结果

已完成：
- 所有 `.command` 文件已创建
- 所有 `.command` 文件已赋予可执行权限
- `start dev` / `start prod` / `start all` 已实测通过
- 访问结果均返回 HTTP 200
