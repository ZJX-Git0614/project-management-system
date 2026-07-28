旧部署包 Windows 乱码兼容修复
=============================

使用方法
--------
1. 将整个 WINDOWS-COMPAT-FIX 文件夹复制到昨天解压后的部署包根目录中。
2. 先运行 0-verify-artifacts.bat，等待全部核心文件校验通过。
3. 右键 1-prepare-wsl2.bat，选择“以管理员身份运行”。
4. 重启 Windows 后运行 2-install-docker-desktop.bat。
5. Ollama 和本地模型是可选项，需要时运行 3-install-ollama-models.bat。
6. 如果 Ollama 已经安装完成但旧脚本仍停在安装提示，直接运行 4-import-models-only.bat。

说明
----
修复脚本会递归查找安装文件，不依赖原部署包中的中文目录名称。
脚本采用 UTF-8 BOM 和 CRLF，兼容 Windows PowerShell 5.1。
