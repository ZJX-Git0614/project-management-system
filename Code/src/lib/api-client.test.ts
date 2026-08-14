import { afterEach, describe, expect, it, vi } from "vitest";

import { api, parseDownloadFileName } from "@/lib/api-client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("download filename parsing", () => {
  it("decodes UTF-8 RFC 5987 filenames", () => {
    expect(parseDownloadFileName(
      "attachment; filename*=UTF-8''F26007-%E9%A1%B9%E7%9B%AE%E9%A2%84%E7%AE%97%E5%88%86%E6%9E%90.xlsx",
    )).toBe("F26007-项目预算分析.xlsx");
  });

  it("supports quoted legacy filenames and strips path segments", () => {
    expect(parseDownloadFileName('attachment; filename="reports\\risk-register.xlsx"')).toBe("risk-register.xlsx");
  });

  it("does not reuse a cached business-data response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }),
    );

    await api.get("/api/projects/project-1/gantt-tasks");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/project-1/gantt-tasks",
      expect.objectContaining({ cache: "no-store" }),
    );
  });
});
