import { describe, expect, it } from "vitest";

import {
  GANTT_COLUMN_MIN_WIDTHS,
  fitGanttColumnWidth,
  fitGanttColumnWidths,
  ganttColumnTemplate,
  ganttColumnsWidth,
  ganttTaskDepths,
} from "@/lib/gantt-column-layout";

const tasks = [
  { id: "root", taskCode: "Task1", taskName: "后端开发", taskCategory: "软件", startDate: "2026-07-01", finishDate: "2026-07-03" },
  { id: "child", parentId: "root", taskCode: "Task1.1.1.1.1", taskName: "需要完整展示的多层级任务名称", taskCategory: "软件 / 登录", startDate: "2026-07-02", finishDate: "2026-07-03" },
];

describe("gantt column layout", () => {
  it("calculates hierarchy depth from stable parent ids", () => {
    expect(ganttTaskDepths(tasks).get("child")).toBe(1);
  });

  it("expands task id and name columns for long hierarchy content", () => {
    const widths = fitGanttColumnWidths(tasks);
    expect(widths.taskCode).toBeGreaterThan(GANTT_COLUMN_MIN_WIDTHS.taskCode);
    expect(widths.taskName).toBeGreaterThan(GANTT_COLUMN_MIN_WIDTHS.taskName);
    expect(fitGanttColumnWidth("taskCode", tasks)).toBe(widths.taskCode);
  });

  it("uses the same widths for the grid template and panel total", () => {
    const widths = fitGanttColumnWidths(tasks);
    const templateWidths = ganttColumnTemplate(widths, true).split(" ").map((value) => Number(value.replace("px", "")));
    expect(templateWidths.reduce((total, value) => total + value, 0)).toBe(ganttColumnsWidth(widths, true));
  });
});
