import { describe, expect, it } from "vitest";
import * as XLSX from "@e965/xlsx";

import type { ProjectGanttTask } from "@/domain/models";
import { buildGanttExcel, buildGanttExcelTemplate, buildProjectXml, parseGanttExcel, parseProjectXml, parseProjectXmlBundle } from "@/lib/gantt-file-transfer";

const tasks: ProjectGanttTask[] = [
  {
    id: "root",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    projectId: "project-1",
    parentId: null,
    taskCode: "Task1",
    taskCategory: "设计",
    taskName: "总体设计",
    startDate: "2026-07-24",
    durationDays: 3,
    actualStartDate: "2026-07-24",
    actualEndDate: "",
    estimatedWorkHours: 24,
    actualWorkHours: 10,
    progress: 50,
    predecessorTask: "",
    sortOrder: 1,
  },
  {
    id: "child",
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    projectId: "project-1",
    parentId: "root",
    taskCode: "Task1.1",
    taskCategory: "设计",
    taskName: "接口设计",
    startDate: "2026-07-25",
    durationDays: 2,
    actualStartDate: "",
    actualEndDate: "",
    estimatedWorkHours: 16,
    actualWorkHours: 0,
    progress: 0,
    predecessorTask: "总体设计",
    predecessorTaskIds: ["root"],
    predecessorDependencies: [{
      id: "dependency-1",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      projectId: "project-1",
      predecessorTaskId: "root",
      successorTaskId: "child",
      type: 1,
      lag: 480,
      lagFormat: 7,
    }],
    sortOrder: 1,
  },
];

describe("gantt file transfer", () => {
  it("round-trips task hierarchy through Excel", () => {
    const imported = parseGanttExcel(buildGanttExcel(tasks));

    expect(imported).toHaveLength(2);
    expect(imported[0]).toMatchObject({
      externalId: "Task1",
      parentExternalId: null,
      taskName: "总体设计",
      estimatedWorkHours: 24,
      actualWorkHours: 10,
    });
    expect(imported[1]).toMatchObject({ externalId: "Task1.1", parentExternalId: "Task1", taskName: "接口设计" });
  });

  it("builds an empty system Excel import template with the supported columns", () => {
    const workbook = XLSX.read(buildGanttExcelTemplate(), { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    const headers = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0];

    expect(rows).toHaveLength(0);
    expect(headers).toEqual(expect.arrayContaining([
      "任务ID",
      "任务名称",
      "计划开始",
      "预计工时(小时)",
      "实际工时(小时)",
      "紧前任务ID",
    ]));
  });

  it("uses the project start date for unscheduled Excel tasks", () => {
    const worksheet = XLSX.utils.json_to_sheet([{
      任务ID: "FE-T001",
      任务类别: "前端",
      任务名称: "模块导航卡片",
      计划开始: "",
      计划完成: "",
    }]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "项目进度");

    const imported = parseGanttExcel(
      Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })),
      "2024-01-01",
    );

    expect(imported[0]).toMatchObject({
      startDate: "2024-01-01",
      finishDate: "2024-01-01",
      durationDays: 1,
    });
  });

  it("round-trips task hierarchy through Microsoft Project XML", () => {
    const imported = parseProjectXml(buildProjectXml("测试项目", tasks).toString("utf8"));

    expect(imported).toHaveLength(2);
    expect(imported[0]).toMatchObject({
      externalId: "1",
      parentExternalId: null,
      taskName: "总体设计",
      progress: 50,
      estimatedWorkHours: 24,
      actualWorkHours: 10,
    });
    expect(imported[1]).toMatchObject({ externalId: "2", parentExternalId: "1", taskName: "接口设计" });
    expect(imported[1].predecessorExternalIds).toEqual(["1"]);
    expect(imported[1].predecessorDependencies[0]).toMatchObject({ type: 1, lag: 480, lagFormat: 7 });
  });

  it("preserves Project duration semantics and non-task metadata", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <Project xmlns="http://schemas.microsoft.com/project">
        <MinutesPerDay>480</MinutesPerDay>
        <Tasks>
          <Task>
            <UID>1</UID><ID>1</ID><Name>手动任务</Name><OutlineLevel>1</OutlineLevel>
            <Start>2009-11-16T09:00:00</Start><Finish>2009-11-17T09:00:00</Finish>
            <Duration>PT8H0M0S</Duration><DurationFormat>39</DurationFormat><Manual>1</Manual>
            <WBS>1</WBS><OutlineNumber>1</OutlineNumber><Text1>开发</Text1><Milestone>0</Milestone>
            <Baseline><Number>0</Number><Start>2009-11-16T09:00:00</Start><Finish>2009-11-17T09:00:00</Finish><Cost>1200</Cost></Baseline>
            <ActualCost>300</ActualCost>
          </Task>
        </Tasks>
        <Calendars><Calendar><UID>1</UID><Name>标准</Name></Calendar></Calendars>
        <Resources><Resource><UID>1</UID><Name>工程师</Name></Resource></Resources>
        <Assignments><Assignment><UID>1</UID><TaskUID>1</TaskUID><ResourceUID>1</ResourceUID></Assignment></Assignments>
      </Project>`;

    const bundle = parseProjectXmlBundle(xml);
    expect(bundle.tasks[0]).toMatchObject({
      taskCategory: "开发",
      durationDays: 1,
      durationMinutes: 480,
      finishDate: "2009-11-17",
      taskMode: "MANUAL",
      isMilestone: false,
      wbsCode: "1",
      baselineCost: 1200,
      budgetAtCompletion: 1200,
      actualCost: 300,
    });
    expect(bundle.metadata?.calendars).toHaveProperty("Calendar");
    expect(bundle.metadata?.resources).toHaveProperty("Resource");
    expect(bundle.metadata?.assignments).toHaveProperty("Assignment");
  });

  it("round-trips calendars, resources and assignment task references", () => {
    const exported = buildProjectXml("测试项目", [{
      ...tasks[0],
      externalUid: "11",
      finishDate: "2026-07-26",
      durationMinutes: 1440,
      taskMode: "MANUAL",
    }], {
      projectSettings: { MinutesPerDay: 480 },
      calendars: { Calendar: { UID: 1, Name: "标准" } },
      resources: { Resource: { UID: 8, Name: "工程师" } },
      assignments: { Assignment: { UID: 3, TaskUID: 11, ResourceUID: 8 } },
      taskUidMap: { "11": "root" },
    });
    const roundTripped = parseProjectXmlBundle(exported.toString("utf8"));

    expect(roundTripped.tasks[0]).toMatchObject({
      externalId: "11",
      durationMinutes: 1440,
      taskMode: "MANUAL",
      finishDate: "2026-07-26",
    });
    expect(roundTripped.metadata?.resources).toEqual({ Resource: { UID: 8, Name: "工程师" } });
    expect(roundTripped.metadata?.assignments).toEqual({ Assignment: { UID: 3, TaskUID: 11, ResourceUID: 8 } });
  });
});
