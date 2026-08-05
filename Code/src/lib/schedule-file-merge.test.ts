import * as XLSX from "@e965/xlsx";
import { describe, expect, it } from "vitest";

import { parseGanttExcel } from "@/lib/gantt-file-transfer";
import {
  convertScheduleFile,
  mergeScheduleFiles,
  orderImportedScheduleTasksByHierarchy,
  parseScheduleImportSource,
} from "@/lib/schedule-file-merge";

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
    expect(result.warnings.some((warning) => warning.message.includes("按未排期任务"))).toBe(true);
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

  it("parses a single Markdown schedule directly for WBS import preview", async () => {
    const result = await parseScheduleImportSource({
      fileName: "实施排期.md",
      buffer: Buffer.from([
        "| 任务编号 | 任务名称 | 计划开始 | 工期 | 依赖 |",
        "| --- | --- | --- | --- | --- |",
        "| A-01 | 需求确认 | 2026-08-05 | 2 | 无 |",
        "| A-02 | 方案设计 | 2026-08-07 | 3 | A-01 |",
      ].join("\n")),
    }, "2026-08-01", { hierarchyMode: "FLAT" });

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[1]).toMatchObject({ taskName: "方案设计", predecessorExternalIds: ["A-01"] });
  });

  it("retains owners from a generic CSV and orders parents before children", async () => {
    const result = await parseScheduleImportSource({
      fileName: "排期.csv",
      buffer: Buffer.from([
        "任务ID,父任务ID,任务名称,负责人,计划开始,工期",
        "child,parent,子任务,张三,2026-08-06,1",
        "parent,,父任务,李四,2026-08-05,2",
      ].join("\n")),
    }, "2026-08-01", { hierarchyMode: "FLAT" });

    expect(result.tasks.find((task) => task.externalId === "child")?.ownerName).toBe("张三");
    expect(orderImportedScheduleTasksByHierarchy(result.tasks).map((task) => task.externalId)).toEqual(["parent", "child"]);
  });

  it("parses an extracted DOCX numbered task list and retains recognizable fields", async () => {
    const extractedText = [
      "# 实施阶段",
      "1. 需求确认 | 开始：2026-08-05 工期：2天 负责人：张三 进度：20%",
      "2. 方案设计 | 开始：2026-08-07 工期：3天 依赖：document-row-2",
    ].join("\n");
    const result = await parseScheduleImportSource({
      fileName: "实施排期.docx",
      buffer: Buffer.from("placeholder"),
      extractedText,
    }, "2026-08-01", { hierarchyMode: "FLAT" });

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({ taskName: "需求确认", ownerName: "张三", progress: 20, durationDays: 2 });
    expect(result.tasks[1].predecessorExternalIds).toEqual(["document-row-2"]);
  });

  it("generates WBS parent nodes from generic category paths unless flat mode is selected", async () => {
    const result = await parseScheduleImportSource({
      fileName: "模块排期.csv",
      buffer: Buffer.from([
        "模块,子模块,任务名称,计划开始,工期",
        "平台,权限,角色配置,2026-08-05,2",
        "平台,权限,账号授权,2026-08-07,1",
      ].join("\n")),
    }, "2026-08-01");

    expect(result.tasks.map((task) => task.taskName)).toEqual(["平台", "权限", "角色配置", "账号授权"]);
    const permission = result.tasks.find((task) => task.taskName === "权限");
    expect(result.tasks.find((task) => task.taskName === "角色配置")?.parentExternalId).toBe(permission?.externalId);
  });

  it("blocks a PDF import when no text was extracted", async () => {
    await expect(parseScheduleImportSource({
      fileName: "扫描排期.pdf",
      buffer: Buffer.from("%PDF"),
      extractedText: "",
    }, "2026-08-01")).rejects.toThrow("OCR");
  });
});
