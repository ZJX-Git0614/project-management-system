import { describe, expect, it } from "vitest";

import {
  buildGanttNetworkDiagramDownloadResponse,
  buildGanttNetworkDiagramXml,
  escapeDrawioXml,
} from "@/lib/gantt-network-diagram";

const tasks = [
  { id: "summary", taskCode: "Task1", taskName: "设计", sortOrder: 1, startDate: "2026-08-01", finishDate: "2026-08-05", durationDays: 5 },
  { id: "api", taskCode: "Task1.2", taskName: "接口 <设计>", parentId: "summary", sortOrder: 2, startDate: "2026-08-03", finishDate: "2026-08-05", durationDays: 3 },
  { id: "architecture", taskCode: "Task1.1", taskName: "架构设计", parentId: "summary", sortOrder: 1, startDate: "2026-08-01", finishDate: "2026-08-02", durationDays: 2 },
];

describe("gantt network diagram", () => {
  it("creates an editable AON diagram from leaf tasks in hierarchy order", () => {
    const xml = buildGanttNetworkDiagramXml({
      projectName: "网络设备项目",
      kind: "AON",
      tasks,
      dependencies: [{ predecessorTaskId: "architecture", successorTaskId: "api", type: 1, lag: 480 }],
    });

    expect(xml).toContain('name="单代号网络图"');
    expect(xml).toContain("Task1.1");
    expect(xml).toContain("架构设计");
    expect(xml).toContain("接口 &lt;设计&gt;");
    expect(xml).toContain("时间范围：2026-08-01 至 2026-08-05，共 5 天");
    expect(xml).toContain("2026-08-01 至 2026-08-02");
    expect(xml).toContain("工期");
    expect(xml).toContain("2 天");
    expect(xml).toContain("FS +48 分钟");
    expect(xml.indexOf("Task1.1")).toBeLessThan(xml.indexOf("Task1.2"));
    expect(xml).not.toContain('value="Task1&lt;br/&gt;');
  });

  it("creates AOA task arrows and dashed dependency links without fabricating tasks", () => {
    const xml = buildGanttNetworkDiagramXml({
      projectName: "网络设备项目",
      kind: "AOA",
      tasks,
      dependencies: [{ predecessorTaskId: "architecture", successorTaskId: "api", type: 3, lag: -120 }],
    });

    expect(xml).toContain('name="双代号网络图"');
    expect(xml).toContain('id="activity-architecture"');
    expect(xml).toContain('id="logic-0"');
    expect(xml).toContain("dashed=1");
    expect(xml).toContain("2026-08-03 至 2026-08-05");
    expect(xml).toContain("SS -12 分钟");
    expect(xml).not.toContain("summary</b>");
  });

  it("expands a summary dependency to its executable leaf tasks", () => {
    const xml = buildGanttNetworkDiagramXml({
      projectName: "网络设备项目",
      kind: "AON",
      tasks: [
        ...tasks,
        { id: "release", taskCode: "Task2", taskName: "发布", sortOrder: 4, startDate: "2026-08-06", finishDate: "2026-08-06", durationDays: 1 },
      ],
      dependencies: [{ predecessorTaskId: "summary", successorTaskId: "release", type: 1 }],
    });

    expect(xml).toContain('source="task-architecture" target="task-release"');
    expect(xml).toContain('source="task-api" target="task-release"');
    expect(xml).not.toContain('source="task-summary"');
  });

  it("creates a critical path network only from passed critical markers", () => {
    const xml = buildGanttNetworkDiagramXml({
      projectName: "网络设备项目",
      kind: "CRITICAL_PATH",
      tasks: [
        ...tasks,
        { id: "build", taskCode: "Task2", taskName: "构建", sortOrder: 4, startDate: "2026-08-06", finishDate: "2026-08-07", durationDays: 2, scheduleStatus: "CRITICAL", totalFloatMinutes: 0 },
        { id: "review", taskCode: "Task3", taskName: "评审", sortOrder: 5, startDate: "2026-08-08", finishDate: "2026-08-08", durationDays: 1 },
      ],
      dependencies: [
        { predecessorTaskId: "api", successorTaskId: "build", type: 1 },
        { predecessorTaskId: "build", successorTaskId: "review", type: 1 },
      ],
    });

    expect(xml).toContain('name="关键路径网络图"');
    expect(xml).toContain("不重新计算关键路径");
    expect(xml).toContain("构建");
    expect(xml).toContain("TF");
    expect(xml).toContain("0 小时");
    expect(xml).toContain("strokeColor=#dc2626");
    expect(xml).not.toContain("评审");
    expect(xml).not.toContain('source="task-build" target="task-review"');
  });

  it("does not fabricate critical tasks when no critical marker is passed", () => {
    const xml = buildGanttNetworkDiagramXml({
      projectName: "网络设备项目",
      kind: "CRITICAL_PATH",
      tasks: [
        ...tasks,
        { id: "float-only", taskCode: "Task2", taskName: "只有时差指标", sortOrder: 4, startDate: "2026-08-06", finishDate: "2026-08-06", durationDays: 1, totalFloatMinutes: 0 },
      ],
      dependencies: [{ predecessorTaskId: "architecture", successorTaskId: "api", type: 1 }],
    });

    expect(xml).toContain("当前项目没有传入关键路径标记");
    expect(xml).not.toContain('id="task-architecture"');
    expect(xml).not.toContain("只有时差指标");
    expect(xml).not.toContain('id="dependency-0"');
  });

  it("creates a milestone timeline from milestone markers and dates", () => {
    const xml = buildGanttNetworkDiagramXml({
      projectName: "网络设备项目",
      kind: "MILESTONE_TIMELINE",
      tasks: [
        ...tasks,
        { id: "m1", taskCode: "M1", taskName: "方案冻结", sortOrder: 4, startDate: "2026-08-06", finishDate: "2026-08-06", durationDays: 0, isMilestone: true },
        { id: "regular", taskCode: "Task2", taskName: "普通任务", sortOrder: 5, startDate: "2026-08-07", finishDate: "2026-08-08", durationDays: 2 },
      ],
      dependencies: [],
    });

    expect(xml).toContain('name="里程碑时间线"');
    expect(xml).toContain('id="milestone-m1"');
    expect(xml).toContain("方案冻结");
    expect(xml).toContain("2026-08-06");
    expect(xml).toContain("shape=rhombus");
    expect(xml).not.toContain("普通任务");
  });

  it("creates a time-scaled network with a date axis and FS logic arrows", () => {
    const xml = buildGanttNetworkDiagramXml({
      projectName: "网络设备项目",
      kind: "TIME_SCALED_NETWORK",
      tasks: [
        ...tasks,
        { id: "build", taskCode: "Task2", taskName: "构建", sortOrder: 4, startDate: "2026-08-06", finishDate: "2026-08-07", durationDays: 2, scheduleStatus: "CRITICAL", totalFloatMinutes: 0 },
      ],
      dependencies: [{ predecessorTaskId: "api", successorTaskId: "build", type: 1 }],
    });

    expect(xml).toContain('name="时标网络图"');
    expect(xml).toContain('id="time-scaled-activity-api"');
    expect(xml).toContain('id="time-scaled-dependency-0"');
    expect(xml).toContain("2026-08-01");
    expect(xml).toContain("虚线箭线表示 FS 逻辑关系");
  });

  it("safely escapes XML and emits an explanation for an empty project", () => {
    expect(escapeDrawioXml(`<&\"'>`)).toBe("&lt;&amp;&quot;&apos;&gt;");
    const xml = buildGanttNetworkDiagramXml({ projectName: "A & B", kind: "AON", tasks: [], dependencies: [] });
    expect(xml).toContain("A &amp; B");
    expect(xml).toContain("当前项目没有可用于网络图的甘特叶子任务");
  });

  it("sets a UTF-8 drawio download response", async () => {
    const response = buildGanttNetworkDiagramDownloadResponse("<mxfile/>", "网络设备-单代号网络图.drawio");
    expect(response.headers.get("Content-Type")).toContain("application/vnd.jgraph.mxfile");
    expect(response.headers.get("Content-Disposition")).toContain(encodeURIComponent("网络设备-单代号网络图.drawio"));
    await expect(response.text()).resolves.toBe("<mxfile/>");
  });
});
