# Ceastar项目管理系统 — Docker 部署指南（Windows）

## 前置条件

- 安装 **Docker Desktop for Windows**
  - 下载：https://www.docker.com/products/docker-desktop/
  - 安装后启动 Docker，确保右下角 Docker 图标显示"Running"
- 可选：安装 **Git Bash**（用于执行 shell 命令，非必需，PowerShell 也可用）

---

## 快速部署

### 1. 获取代码

将 `dev-repo/Code` 目录（含以下文件的完整目录）拷贝到 Windows 机器的任意路径：

```
Dockerfile
docker-compose.yml
docker-entrypoint.sh
.dockerignore
package.json
next.config.ts
...
```

### 2. 构建并启动

打开 **PowerShell** 或 **命令提示符**，进入代码目录：

```powershell
cd D:\path\to\pms-code
docker compose up -d --build
```

首次构建约 2-5 分钟（拉取 Node 镜像 + 安装依赖 + 编译 Next.js）。

### 3. 访问系统

浏览器打开：**http://localhost:3000**

### 4. 默认账号

| 账号 | 密码 | 角色 |
|------|------|------|
| `admin` | `88888888` | 系统管理员 |
| `pm.zhangsan` | `88888888` | 项目经理 |
| `proc.lisi` | `88888888` | 采购负责人 |

> 首次登录后会要求修改密码。

---

## 常用命令

```powershell
# 构建并启动
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止服务
docker compose down

# 停止并删除数据（谨慎！清除所有数据）
docker compose down -v

# 重启
docker compose restart

# 查看运行状态
docker compose ps
```

---

## 数据持久化

- PostgreSQL 数据存储在 Docker 命名卷 `pgdata` 中
- 即使容器删除、重新构建，数据也不会丢失
- 要彻底清除数据：`docker compose down -v`

---

## 自定义配置

如需修改 JWT 密钥或数据库路径，编辑 `docker-compose.yml` 中的 `environment` 字段：

```yaml
environment:
  - JWT_SECRET=你的自定义密钥
```

改完后重新部署：`docker compose up -d --build`

---

## 升级版本

```powershell
# 拉取最新代码后
docker compose down
docker compose up -d --build
```

---

## 常见问题

**Q: 端口 3000 被占用？**
改 `docker-compose.yml` 中的端口映射，例如：
```yaml
ports:
  - "3001:3000"   # 宿主用 3001 访问
```

**Q: 启动失败，日志显示数据库错误？**
```powershell
docker compose down -v   # 清除旧数据重新初始化
docker compose up -d --build
```

**Q: Windows 上文件权限问题？**
如遇 docker-entrypoint.sh 执行错误，确保该文件使用 LF 换行符（非 CRLF）。在 VS Code 右下角点击"CRLF"切换为"LF"即可。
