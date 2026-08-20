import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const deploymentFile = (name: string) =>
  readFileSync(resolve(process.cwd(), "deployment/windows-x86", name), "utf8");
const deploymentBytes = (name: string) =>
  readFileSync(resolve(process.cwd(), "deployment/windows-x86", name));

const updateScript = deploymentFile("update.ps1");
const installScript = deploymentFile("install.ps1");
const rollbackScript = deploymentFile("rollback.ps1");
const packageScript = deploymentFile("build-update-package.sh");
const rollbackLauncher = deploymentFile("rollback.bat");
const assistantServicesLauncher = deploymentFile("assistant-services.bat");
const assistantServicesScript = deploymentFile("assistant-services.ps1");
const assistantWatchdogScript = deploymentFile("assistant-service-watchdog.ps1");
const assistantBridgeScript = deploymentFile("assistant-service-bridge.ps1");
const assistantBridgeInstaller = deploymentFile("install-assistant-service-bridge.ps1");
const drawioMcpScript = deploymentFile("drawio-mcp.ps1");
const drawioMcpInstaller = deploymentFile("install-drawio-mcp.ps1");
const drawioMcpConfig = deploymentFile("drawio-mcp-config.json");
const releaseId = deploymentFile("release-id.txt").trim();
const imageName = deploymentFile("image-name.txt").trim();
const roleIntegrityMigration = readFileSync(
  resolve(process.cwd(), "prisma/manual-migrations/20260804_role_reference_integrity.sql"),
  "utf8",
);
const entrypoint = readFileSync(resolve(process.cwd(), "docker-entrypoint.sh"), "utf8");
const preSchemaMigration = readFileSync(
  resolve(process.cwd(), "prisma/pre-schema-migrations/20260804_unique_project_members.sql"),
  "utf8",
);
const approvalWorkflowCompatMigration = readFileSync(
  resolve(process.cwd(), "prisma/pre-schema-migrations/20260806_approval_workflow_compat.sql"),
  "utf8",
);
const prepareDatabaseScript = readFileSync(
  resolve(process.cwd(), "scripts/prepare-database.mjs"),
  "utf8",
);
const ownerInheritanceMigration = readFileSync(
  resolve(process.cwd(), "prisma/manual-migrations/20260804_gantt_owner_inheritance_v2.sql"),
  "utf8",
);

describe("Windows staged blue-green deployment", () => {
  it("keeps the image and release identifiers aligned", () => {
    const match = releaseId.match(/^(\d{4})(\d{2})(\d{2})-(.+)$/);
    expect(match).not.toBeNull();
    const [, year, month, day, revision] = match!;
    expect(imageName).toBe(
      `ceastar-project-management:${year}.${month}.${day}.${revision}-amd64`,
    );
    expect(packageScript).toContain('COMPATIBLE_BASE_RELEASE="20260806-4"');
    expect(packageScript).toContain("Compatible base release:");
  });

  it("uses one versioned state contract for update and rollback", () => {
    for (const script of [updateScript, rollbackScript]) {
      expect(script).toContain('"release-id.txt"');
      expect(script).toContain('".ceastar-update-$releaseId.state"');
      expect(script).toContain('"strategy=blue-green-staged"');
      expect(script).not.toMatch(/\.ceastar-update-\d{8}-\d+\.state/);
    }
  });

  it("health-checks a one-worker candidate before switching port 3000", () => {
    for (const [script, healthUrl] of [
      [updateScript, 'http://127.0.0.1:$candidatePort/api/health/ready'],
      [rollbackScript, 'http://127.0.0.1:$candidatePort/login'],
    ] as const) {
      const candidateIndex = script.indexOf(
        '@("compose", "run", "--detach", "--no-deps"',
      );
      const healthInvocation = script === updateScript
        ? `Wait-ForApplication "${healthUrl}" $script:CandidateContainer`
        : `Wait-ForApplication "${healthUrl}"`;
      const candidateHealthIndex = script.indexOf(
        healthInvocation,
      );
      const cutoverIndex = script.indexOf(
        '@("compose", "up", "-d", "--no-deps", "--force-recreate", "pms")',
        candidateHealthIndex,
      );

      expect(script).toContain('"--env", "PMS_WEB_WORKERS=1"');
      expect(candidateIndex).toBeGreaterThan(-1);
      expect(candidateHealthIndex).toBeGreaterThan(candidateIndex);
      expect(cutoverIndex).toBeGreaterThan(candidateHealthIndex);
    }

    expect(updateScript).toContain('"--env", "SKIP_PRISMA_DB_PUSH=false"');
    expect(updateScript).toContain('"--env", "SKIP_PRISMA_SEED=true"');
  });

  it("validates migrations against an isolated candidate database", () => {
    expect(updateScript).toContain("function New-CandidateDatabase");
    expect(updateScript).toContain('"pms_candidate_$safeReleaseId"');
    expect(updateScript).toContain('"DATABASE_URL=$CandidateDatabaseUrl"');
    expect(updateScript).toContain("Remove-CandidateDatabase");
    expect(updateScript).toContain('Wait-ForApplication "http://localhost:3000/api/health/ready"');
    expect(updateScript).toContain("$response.StatusCode -lt 300");
    expect(updateScript).not.toContain("$response.StatusCode -lt 500");
  });

  it("migrates the production database only after the green candidate is healthy", () => {
    const candidateHealthIndex = updateScript.indexOf(
      'Wait-ForApplication "http://127.0.0.1:$candidatePort/api/health/ready" $script:CandidateContainer',
    );
    const productionMigrationIndex = updateScript.lastIndexOf("Upgrade-ProductionDatabase");
    const cutoverIndex = updateScript.indexOf(
      '@("compose", "up", "-d", "--no-deps", "--force-recreate", "pms")',
      candidateHealthIndex,
    );

    expect(updateScript).toContain('"compose", "run", "--rm", "--no-deps"');
    expect(updateScript).toContain('"正式数据库结构同步失败，未切换 3000 端口。"');
    expect(updateScript).toContain("候选容器最近日志");
    expect(candidateHealthIndex).toBeGreaterThan(-1);
    expect(productionMigrationIndex).toBeGreaterThan(candidateHealthIndex);
    expect(cutoverIndex).toBeGreaterThan(productionMigrationIndex);
  });

  it("runs duplicate-member protection before Prisma creates the unique index", () => {
    const preSchemaIndex = entrypoint.indexOf("prisma/pre-schema-migrations/*.sql");
    const dbPushIndex = entrypoint.indexOf("prisma db push --skip-generate");
    expect(preSchemaIndex).toBeGreaterThan(-1);
    expect(dbPushIndex).toBeGreaterThan(preSchemaIndex);
    expect(preSchemaMigration).toContain('column_name = \'accountId\'');
    expect(preSchemaMigration).toContain('to_regclass(\'public."ProjectGanttTaskOwner"\')');
  });

  it("prepares approval todo columns without globally accepting data loss", () => {
    expect(approvalWorkflowCompatMigration).toContain('ADD COLUMN IF NOT EXISTS "approvalAssignmentId" TEXT');
    expect(approvalWorkflowCompatMigration).toContain('ADD COLUMN IF NOT EXISTS "approvalInstanceId" TEXT');
    expect(approvalWorkflowCompatMigration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "TodoItem_approvalAssignmentId_key"');
    expect(packageScript).toContain("20260806_approval_workflow_compat.sql");
    expect(entrypoint).not.toContain("--accept-data-loss");
    expect(prepareDatabaseScript).not.toContain("--accept-data-loss");
  });

  it("does not repeat the legacy owner inheritance backfill on every restart", () => {
    expect(ownerInheritanceMigration).toContain('"PmsDataMigration"');
    expect(ownerInheritanceMigration).toContain("20260804_gantt_owner_inheritance_v2");
    expect(ownerInheritanceMigration).toContain("ON CONFLICT (\"key\") DO NOTHING");
  });

  it("backs up data and restores the active application on a failed cutover", () => {
    expect(updateScript).toContain("Assert-VerifiedBackup $preUpdateBackupDirectory");
    expect(updateScript).toContain("Restore-BlueApplication");
    expect(rollbackScript).toContain("Assert-VerifiedBackup $safetyBackupDirectory");
    expect(rollbackScript).toContain("Restore-CurrentApplication");

    const rollbackBackupIndex = rollbackScript.indexOf(
      'Write-Step 3 8 "备份当前数据库与项目文档"',
    );
    const rollbackTagIndex = rollbackScript.indexOf(
      "docker tag $rollbackImage $composeImage",
    );
    expect(rollbackBackupIndex).toBeGreaterThan(-1);
    expect(rollbackTagIndex).toBeGreaterThan(rollbackBackupIndex);
  });

  it("rejects the wrong image architecture and destructive volume operations", () => {
    expect(updateScript).toContain('$newImageArchitecture -ne "amd64"');
    for (const script of [updateScript, rollbackScript]) {
      expect(script).not.toMatch(/docker compose down\s+-v/);
      expect(script).not.toContain("docker volume rm");
      expect(script).not.toContain("--accept-data-loss");
    }
  });

  it("uses native exit codes instead of treating Compose progress on stderr as failure", () => {
    for (const script of [updateScript, rollbackScript]) {
      expect(script).toContain("function Invoke-DockerCommand");
      expect(script).toContain('$ErrorActionPreference = "Continue"');
      expect(script).toContain("$output = @(& docker @Arguments 2>&1)");
      expect(script).toContain("if ($exitCode -ne 0)");
      expect(script).not.toMatch(/^\s*docker compose (run|up)/m);
    }
  });

  it("builds and validates a data-free linux/amd64 Windows update ZIP", () => {
    expect(packageScript).toContain("--platform linux/amd64");
    expect(packageScript).toContain('IMAGE_PLATFORM" = "linux/amd64"');
    expect(packageScript).toContain("unzip -tq");
    expect(packageScript).toContain("__MACOSX");
    expect(packageScript).toContain("database\\.dump");
    expect(packageScript).toContain('"$PACKAGE_DIR/Windows-Update-Guide-CN.txt"');
    expect(packageScript).toContain('"$PACKAGE_DIR/Database-Migration-Guide-CN.txt"');
    expect(packageScript).toContain('"$PACKAGE_DIR/Data-Security-Guide-CN.txt"');
    expect(packageScript).toContain("assistant-services.bat");
    expect(packageScript).toContain("assistant-service-watchdog.ps1");
    expect(packageScript).toContain("assistant-service-bridge.ps1");
    expect(packageScript).toContain("install-assistant-service-bridge.ps1");
    expect(packageScript).toContain("drawio-mcp.ps1");
    expect(packageScript).toContain("drawio-mcp-config.json");
    expect(packageScript).toContain("install-drawio-mcp.ps1");
    expect(packageScript).toContain("20260805_wbs_resource_optimization.sql");
    expect(packageScript).toContain("20260807_gantt_auto_manual_scheduling.sql");
    expect(packageScript).toContain('"$PACKAGE_DIR/Assistant-Services-Guide-CN.txt"');
    expect(packageScript).toContain('"$PACKAGE_DIR/Draw.io-MCP-Guide-CN.txt"');
    expect(packageScript).toContain("Windows PowerShell 5.1");
    expect(packageScript).toContain("\\xEF\\xBB\\xBF");
    expect(packageScript).toContain("PowerShell script is missing the UTF-8 BOM");
    expect(packageScript).toContain("CEASTAR_WINDOWS_UPDATE_ZIP_SHA256=");
  });

  it("uses the UTF-8 console code page for Chinese rollback output", () => {
    expect(rollbackLauncher).toContain("chcp 65001 >nul");
    expect(rollbackLauncher).toContain("rollback.ps1");
  });

  it("ships independent Ollama and RAGLite service management with opt-in startup recovery", () => {
    for (const scriptName of [
      "assistant-services.ps1",
      "assistant-service-watchdog.ps1",
      "assistant-service-bridge.ps1",
      "install-assistant-service-bridge.ps1",
    ]) {
      expect([...deploymentBytes(scriptName).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    }
    expect(assistantServicesLauncher).toContain("chcp 65001 >nul");
    expect(assistantServicesLauncher).toContain("assistant-services.ps1");
    expect(assistantServicesScript).toContain('ValidateSet("All", "Ollama", "RagLite")');
    expect(assistantServicesScript).toContain('Join-Path $env:ProgramData "Ceastar-PMS\\raglite-data"');
    expect(assistantServicesScript).toContain('New-ScheduledTaskTrigger -AtStartup');
    expect(assistantServicesScript).toContain('Register-ScheduledTask');
    expect(assistantServicesScript).toContain('Disable-AutoStart');
    expect(assistantServicesScript).toContain('Test-HttpHealth');
    expect(assistantServicesScript).toContain('AppData\\Local\\Programs\\Ollama\\ollama.exe');
    expect(assistantServicesScript).toContain('$allowPrompt = $Interactive -or $Action -eq "Menu"');
    expect(assistantServicesScript).toContain('("$Name.pid")');
    expect(assistantServicesScript).toContain('Set-Content -LiteralPath (Join-Path $script:RuntimeDirectory "Ollama.pid")');
    expect(assistantServicesScript).toContain('[System.IO.Path]::GetFullPath($sourcePath) -ne [System.IO.Path]::GetFullPath($destinationPath)');
    expect(assistantServicesScript).toContain('Stop-ScheduledTask -TaskName $taskName');
    expect(assistantWatchdogScript).toContain('Start-Sleep -Seconds 15');
    expect(assistantWatchdogScript).toContain('-Action Ensure');
    expect(assistantBridgeScript).toContain('Headers["Authorization"]');
    expect(assistantBridgeScript).toContain('"/configure-raglite"');
    expect(assistantBridgeScript).toContain('"-RagLiteArguments", $ragArguments');
    expect(assistantBridgeInstaller).toContain('"Ceastar-PMS-Assistant-Service-Bridge"');
    expect(assistantBridgeInstaller).toContain('ASSISTANT_SERVICE_MANAGER_TOKEN');
    expect(assistantBridgeInstaller).toContain('New-NetFirewallRule');
    expect(assistantBridgeInstaller).toContain('-RemoteAddress LocalSubnet');
    expect(assistantBridgeInstaller).toContain('Stop-ScheduledTask -TaskName $taskName');
    expect(updateScript).toContain("install-assistant-service-bridge.ps1");
  });

  it("ships a Windows Draw.io MCP launcher with a predictable managed location", () => {
    for (const scriptName of ["drawio-mcp.ps1", "install-drawio-mcp.ps1"]) {
      expect([...deploymentBytes(scriptName).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    }
    expect(drawioMcpScript).toContain("@drawio/mcp");
    expect(drawioMcpScript).toContain("npx.cmd");
    expect(drawioMcpScript).toContain("$npx.Path");
    expect(drawioMcpInstaller).toContain('Join-Path $env:ProgramData "Ceastar-PMS"');
    expect(drawioMcpInstaller).toContain("drawio-mcp-config.json");
    expect(drawioMcpConfig).toContain("C:\\\\ProgramData\\\\Ceastar-PMS\\\\drawio-mcp.ps1");
    expect(installScript).toContain("install-drawio-mcp.ps1");
    expect(updateScript).toContain("install-drawio-mcp.ps1");
  });

  it("preserves malformed role and permission JSON during integrity repair", () => {
    expect(roleIntegrityMigration).toContain("pg_temp.try_parse_jsonb");
    expect(roleIntegrityMigration).toContain("normalized_role_names := NULL");
    expect(roleIntegrityMigration).toContain("normalized_role_names IS NOT NULL");
    expect(roleIntegrityMigration).not.toContain('normalized_role_names := \'[]\'');
    expect(roleIntegrityMigration).not.toContain('ON COMMIT DROP AS');
  });
});
