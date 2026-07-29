import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const installer = readFileSync(
  resolve(process.cwd(), "deployment/windows-x86/install-mpp-export-service.ps1"),
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
});
