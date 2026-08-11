import { describe, expect, it } from "vitest";

import {
  buildGanttNetworkDiagramDownloadResponse,
  buildGanttNetworkDiagramXml,
  escapeDrawioXml,
} from "@/lib/gantt-network-diagram";

const tasks = [
  { id: "summary", taskCode: "Task1", taskName: "设计", sortOrder: 1 },
  { id: "api", taskCode: "Task1.2", taskName: "接口 <设计>", parentId: "summary", sortOrder: 2 },
  { id: "architecture", taskCode: "Task1.1", taskName: "架构设计", parentId: "summary", sortOrder: 1 },
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
    expect(xml).toContain("SS -12 分钟");
    expect(xml).not.toContain("summary</b>");
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
