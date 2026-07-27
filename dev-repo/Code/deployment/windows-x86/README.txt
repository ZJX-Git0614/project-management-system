Ceastar Project Management System - Windows x86 Deployment Package
==================================================================

Target environment
------------------
1. Windows 10 or Windows 11, x86-64 CPU.
2. Docker Desktop with Linux containers enabled.
3. At least 8 GB RAM and 10 GB free disk space.

First installation
------------------
1. Install and start Docker Desktop.
2. Keep this deployment directory intact. Do not move individual files out of it.
3. Open PowerShell in this directory.
4. Run:

   Set-ExecutionPolicy -Scope Process Bypass
   .\install.ps1

5. Open http://localhost:3000 on the deployment computer.
6. Other computers on the same LAN can open http://DEPLOYMENT-PC-IP:3000.

Normal operation
----------------
- Start:  .\start.ps1
- Stop:   .\stop.ps1
- Backup: .\backup.ps1

Data protection
---------------
- PostgreSQL and uploaded documents are stored in Docker volumes.
- Running stop.ps1 or docker compose stop does not delete data.
- Never run: docker compose down -v
- Never delete the ceastar-pms_pgdata or ceastar-pms_document_storage volumes.
- Run backup.ps1 regularly and copy the backups directory to another disk.
- To store automatic backups on another Windows drive, add for example
  PMS_BACKUP_HOST_DIR=D:/Ceastar-PMS-Backups to .env, recreate the pms container,
  then select /data/system-backups in System Data Management.
- install.ps1 is intended for first installation. Running install.ps1 -Force replaces
  the target database with the database included in this package.

Assistant configuration
-----------------------
- Existing assistant settings and encrypted provider keys are included in the database.
- The current active LLM provider is an external network service. The deployment computer
  must be able to reach that service for AI chat to work.
- For local Ollama on Windows, install Ollama and pull the configured model. In Assistant
  Settings, use http://host.docker.internal:11434 instead of http://127.0.0.1:11434 because
  Ceastar PMS runs inside Docker.

Troubleshooting
---------------
- Docker Desktop must be running before any script is executed.
- Allow inbound TCP port 3000 in Windows Firewall when other LAN computers need access.
- Check service state: docker compose ps
- Check application logs: docker compose logs --tail 200 pms
- Check database logs: docker compose logs --tail 200 postgres
