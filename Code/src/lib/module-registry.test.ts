import { describe, expect, it } from "vitest";

import { formatProjectModuleRegistry, getProjectModuleRegistry } from "@/lib/module-registry";

describe("project module registry", () => {
  it("contains the execution module without duplicate keys", () => {
    const modules = getProjectModuleRegistry();
    const keys = modules.map((module) => module.key);

    expect(keys).toContain("execution");
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("provides a stable assistant-readable summary", () => {
    expect(formatProjectModuleRegistry()).toContain("项目执行阶段(execution)");
  });
});
