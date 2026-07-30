import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const installer = readFileSync(
  resolve(process.cwd(), "deployment/windows-x86/install-mpp-export-service.ps1"),
  "utf8",
);
const fullInstaller = readFileSync(
  resolve(process.cwd(), "deployment/windows-x86/install.ps1"),
  "utf8",
);
const updater = readFileSync(
  resolve(process.cwd(), "deployment/windows-x86/update.ps1"),
  "utf8",
);

describe("Windows MPP export service installer", () => {
  it("reuses the configured token instead of rotating it on every update", () => {
    expect(installer).toContain('Get-EnvValue $envPath "PROJECT_MPP_EXPORT_SERVICE_TOKEN"');
    expect(installer).toContain("if (-not $token) { $token = New-ServiceToken }");
  });

  it("stops an existing scheduled task before replacing and starting it", () => {
    const stopIndex = installer.indexOf("Stop-ScheduledTask -TaskName $taskName");
    const registerIndex = installer.indexOf("Register-ScheduledTask -TaskName $taskName");
    expect(stopIndex).toBeGreaterThan(-1);
    expect(registerIndex).toBeGreaterThan(stopIndex);
  });

  it("retries an authenticated loopback health check after restart", () => {
    expect(installer).toContain("function Wait-ForServiceHealth");
    expect(installer).toContain('http://127.0.0.1:$ServicePort/health');
    expect(installer).toContain("for ($attempt = 1; $attempt -le 15; $attempt++)");
    expect(installer).toContain("Wait-ForServiceHealth $Port $token");
  });

  it("detects Microsoft Project through both Windows PowerShell bitnesses and preserves the resolved COM ProgID", () => {
    expect(installer).toContain("System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe");
    expect(installer).toContain("SysWOW64\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe");
    expect(installer).toContain("MSProject.Application.16");
    expect(installer).toContain("-ProjectProgId");
    expect(installer).toContain("-Execute $projectAutomation.PowerShellPath");
  });

  it("keeps optional MPP service setup out of the installation and update critical paths", () => {
    expect(fullInstaller).not.toContain('& $mppInstaller');
    expect(updater).not.toContain('& $mppInstaller');
    expect(fullInstaller).toContain("repair-mpp-export-service.bat");
    expect(updater).toContain("repair-mpp-export-service.bat");
  });
});
