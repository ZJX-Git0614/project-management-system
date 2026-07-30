Ceastar PMS 飞牛 OS（fnOS）Docker 离线部署说明
================================================

适用范围
--------
1. 飞牛 OS 设备的 CPU 架构必须是 x86_64/amd64。
2. 飞牛 OS 中已经安装并启动 Docker，且支持 docker compose。
3. 本包包含 Ceastar PMS、PostgreSQL 16 离线镜像、数据库和项目文档，不包含大模型。
4. 本包包含项目数据，请只在受控内网中保存和传输。

重要说明
--------
1. 不要在飞牛 OS 上使用 Windows 完整部署包中的 .bat 或 .ps1 文件。
2. 飞牛 OS 不能直接运行依赖 Microsoft Project COM 的本机 MPP 导出服务。
   Excel 和 Project XML 导出可正常使用；二进制 MPP 导出需要另行连接一台安装了 Microsoft Project 的 Windows 服务端。
3. 安装脚本发现已有 Ceastar PMS 数据卷时会停止，不会覆盖已有数据库。
4. PostgreSQL 和项目文档使用 Docker 命名卷保存；容器重启、系统重启和重新创建容器不会删除数据。
5. 不要执行 docker compose down -v，-v 会删除数据库和项目文档卷。
6. 默认数据卷名称可在 .env 的 PMS_DATABASE_VOLUME 和 PMS_DOCUMENT_VOLUME 中调整。

最简单的安装步骤
----------------
1. 在飞牛 OS 文件管理器中创建一个长期保留的目录，例如：
   Docker/Ceastar-PMS

2. 将整个 Ceastar-PMS-fnOS-x86-日期版本 文件夹上传到该目录并解压。

3. 在飞牛 OS 中启用 SSH，然后用管理员账号连接 NAS。

4. 进入解压后的目录。实际路径以飞牛文件管理器显示的路径为准：
   cd "/实际路径/Ceastar-PMS-fnOS-x86-日期版本"

5. 执行安装：
   chmod +x *.sh
   ./install.sh

6. 安装完成后，浏览器访问：
   http://飞牛OS的IP地址:3000

常用命令
--------
启动服务：
  ./start.sh

停止服务（不会删除数据）：
  ./stop.sh

查看状态和最近日志：
  ./status.sh

持续查看日志，按 Ctrl+C 退出：
  ./logs.sh

手动备份数据库和项目文档：
  ./backup.sh

备份文件位于本部署目录的 backups/manual-日期时间 文件夹中。

恢复指定备份（会先自动生成一份保护备份）：
  ./restore.sh backups/manual-YYYYMMDD-HHMMSS RESTORE

开机自动恢复
------------
Compose 中两个服务都配置了 restart: unless-stopped。
只要 Docker 在飞牛 OS 启动后自动运行，数据库和 PMS 容器异常退出后会自动重启。

端口冲突
--------
默认端口为 3000。如 3000 已被占用，编辑 .env：
  PMS_PORT=3001

然后执行：
  ./start.sh

智能助手连接本地模型
--------------------
本包不包含 Ollama 或模型。若 Ollama 在飞牛 OS 宿主机上运行，可在系统的智能助手设置中尝试：
  http://host.docker.internal:11434

若模型运行在内网其他电脑上，请填写：
  http://模型电脑IP:11434

卸载注意事项
------------
普通停止只执行 ./stop.sh。
除非已经完成数据库和项目文档备份，并且确认不再需要数据，否则不要删除：
  ceastar-pms_pgdata
  ceastar-pms_document_storage

也不要执行：
  docker compose down -v
