import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const deploymentDirectory = path.join(process.cwd(), "deployment", "macos");
const launcherPath = path.join(deploymentDirectory, "drawio-mcp.sh");
const installerPath = path.join(deploymentDirectory, "install-drawio-mcp.sh");
const configPath = path.join(deploymentDirectory, "drawio-mcp-config.json");

describe("macOS Draw.io MCP deployment", () => {
  it("uses the official pinned MCP package without loading an interactive shell", () => {
    const launcher = readFileSync(launcherPath, "utf8");
    const config = readFileSync(configPath, "utf8");

    expect(launcher).toContain("@drawio/mcp@1.5.0");
    expect(config).toContain('"command": "/bin/bash"');
    expect(config).toContain('"-c"');
    expect(config).not.toContain("-l");
    expect(config).toContain("$HOME/Library/Application Support/Ceastar-PMS/drawio-mcp.sh");
  });

  it.each([launcherPath, installerPath])("passes bash syntax validation: %s", (scriptPath) => {
    const result = spawnSync("/bin/bash", ["-n", scriptPath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("installs into the current macOS user support directory and records npx absolutely", () => {
    const temporaryHome = mkdtempSync(path.join(tmpdir(), "ceastar-drawio-mcp-"));
    const fakeBin = path.join(temporaryHome, "bin");
    mkdirSync(fakeBin, { recursive: true });
    const fakeNpx = path.join(fakeBin, "npx");
    writeFileSync(fakeNpx, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    try {
      const result = spawnSync("/bin/bash", [installerPath, "--source", deploymentDirectory], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: temporaryHome,
          PATH: `${fakeBin}:/usr/bin:/bin`,
        },
      });
      expect(result.status, result.stderr).toBe(0);

      const installedDirectory = path.join(temporaryHome, "Library", "Application Support", "Ceastar-PMS");
      expect(readFileSync(path.join(installedDirectory, "drawio-mcp.env"), "utf8")).toContain(fakeNpx);
      expect(readFileSync(path.join(installedDirectory, "drawio-mcp-config.json"), "utf8")).toContain("mcpServers");
      expect(statSync(path.join(installedDirectory, "drawio-mcp.sh")).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(temporaryHome, { recursive: true, force: true });
    }
  });
});
