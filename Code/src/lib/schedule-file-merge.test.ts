import * as XLSX from "@e965/xlsx";
import { describe, expect, it } from "vitest";

import { parseGanttExcel } from "@/lib/gantt-file-transfer";
import { convertScheduleFile, mergeScheduleFiles } from "@/lib/schedule-file-merge";

const buildFrontendWorkbook = () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { 模块: "界面", 子模块: "登录", 功能项: "登录页面", 功能描述: "登录", 技术实现: "忽略此列" },
    { 模块: "界面", 子模块: "首页", 功能项: "项目看板", 功能描述: "看板", 技术实现: "忽略此列" },
  ]), "功能清单");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { 模块名称: "界面", 数量: 2 },
  ]), "统计汇总");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
};

describe("schedule file merge", () => {
  it("converts one supported schedule file into a verified system import workbook", async () => {
    const result = await convertScheduleFile({
      fileName: "前端任务列表.xlsx",
      buffer: buildFrontendWorkbook(),
    }, "2026-07-01");

    expect(result.tasks.map((task) => task.taskName)).toEqual(["登录页面", "项目看板"]);
    const workbook = XLSX.read(result.workbook, { type: "buffer" });
    expect(workbook.SheetNames).toEqual(["项目进度", "转换说明"]);
    expect(parseGanttExcel(result.workbook, "2026-07-01")).toHaveLength(2);
  });

  it("rejects formats outside the single-file gantt conversion contract", async () => {
    await expect(convertScheduleFile({
      fileName: "计划.md",
      buffer: Buffer.from("# 计划"),
    }, "2026-07-01")).rejects.toThrow("不是可转换的甘特计划格式");
  });

  it("merges Markdown and generic Excel tasks into a verified system import workbook", async () => {
    const markdown = [
      "# 后端任务",
      "",
      "| 任务编号 | 任务名称 | 任务描述 | 依赖 |",
      "| --- | --- | --- | --- |",
      "| BE-01 | 用户接口 | 实现接口 | 无 |",
      "| BE-02 | 权限校验 | 校验权限 | BE-01 |",
    ].join("\n");

    const result = await mergeScheduleFiles([
      { fileName: "后端任务列表.md", buffer: Buffer.from(markdown, "utf8") },
      { fileName: "前端任务列表.xlsx", buffer: buildFrontendWorkbook() },
    ], "2026-07-01");

    expect(result.tasks.map((task) => task.externalId)).toEqual(["Task001", "Task002", "Task003", "Task004"]);
    expect(result.tasks.map((task) => task.taskName)).toEqual(["用户接口", "权限校验", "登录页面", "项目看板"]);
    expect(result.tasks[1].predecessorExternalIds).toEqual(["Task001"]);
    expect(result.tasks[2].taskCategory).toBe("界面 / 登录");
    expect(result.tasks.every((task) => task.startDate === "2026-07-01")).toBe(true);
    expect(result.tasks.some((task) => task.taskName.includes("技术实现"))).toBe(false);

    const workbook = XLSX.read(result.workbook, { type: "buffer" });
    expect(workbook.SheetNames).toEqual(["项目进度", "合并说明"]);
    expect(parseGanttExcel(result.workbook, "2026-07-01")).toHaveLength(4);
    expect(result.warnings.some((warning) => warning.message.includes("按 1 天"))).toBe(true);
  });

  it("does not invent an unresolved dependency", async () => {
    const first = [
      "| 任务编号 | 任务名称 | 依赖 |",
      "| --- | --- | --- |",
      "| A-01 | 已知任务 | UNKNOWN-01 |",
    ].join("\n");
    const second = [
      "| 任务编号 | 任务名称 | 依赖 |",
      "| --- | --- | --- |",
      "| B-01 | 另一任务 | 无 |",
    ].join("\n");

    const result = await mergeScheduleFiles([
      { fileName: "计划一.md", buffer: Buffer.from(first) },
      { fileName: "计划二.md", buffer: Buffer.from(second) },
    ], "2026-07-01");

    expect(result.tasks[0].predecessorExternalIds).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ message: expect.stringContaining("UNKNOWN-01") }));
  });

  it("requires a real project start date when source tasks have no dates", async () => {
    const source = Buffer.from([
      "| 任务编号 | 任务名称 |",
      "| --- | --- |",
      "| A-01 | 任务一 |",
    ].join("\n"));

    await expect(mergeScheduleFiles([
      { fileName: "计划一.md", buffer: source },
      { fileName: "计划二.md", buffer: source },
    ], "")).rejects.toThrow("当前项目未设置开始日期");
  });
});
