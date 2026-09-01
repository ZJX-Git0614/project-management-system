import { describe, expect, it } from "vitest";

import {
  GANTT_HIDEABLE_COLUMN_KEYS,
  GANTT_DEFAULT_HIDDEN_COLUMN_KEYS,
  GANTT_EXPANDED_COLUMN_KEYS,
  GANTT_COLUMN_MIN_WIDTHS,
  fitGanttColumnWidth,
  fitGanttColumnWidths,
  ganttColumnTemplate,
  ganttColumnsWidth,
  ganttTaskDepths,
  ganttVisibleColumnKeys,
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

  it("reserves width for filter controls and aggregated task owners", () => {
    const widths = fitGanttColumnWidths([
      ...tasks,
      {
        id: "owners",
        taskCode: "Task2",
        taskName: "联调任务",
        ownerMembers: [
          { personName: "张三", roleName: "项目经理" },
          { personName: "李四", roleName: "软件开发" },
          { personName: "王五", roleName: "系统测试" },
        ],
      },
    ]);

    expect(widths.durationDays).toBeGreaterThan(GANTT_COLUMN_MIN_WIDTHS.durationDays);
    expect(widths.owner).toBeGreaterThan(GANTT_COLUMN_MIN_WIDTHS.owner);
  });

  it("keeps the default owner column wide enough for the selector chrome", () => {
    expect(GANTT_COLUMN_MIN_WIDTHS.owner).toBeGreaterThanOrEqual(176);
    expect(fitGanttColumnWidth("owner", [{
      id: "owner",
      ownerMember: { personName: "赵佳鑫", roleName: "项目经理" },
    }])).toBeGreaterThanOrEqual(176);
  });

  it("uses the same widths for the grid template and panel total", () => {
    const widths = fitGanttColumnWidths(tasks);
    const templateWidths = ganttColumnTemplate(widths, true).split(" ").map((value) => Number(value.replace("px", "")));
    expect(templateWidths.reduce((total, value) => total + value, 0)).toBe(ganttColumnsWidth(widths, true));
  });

  it("hides optional columns without removing pinned task columns", () => {
    const widths = fitGanttColumnWidths(tasks);
    const hidden = new Set(["owner", "predecessor"] as const);
    const visibleKeys = ganttVisibleColumnKeys(false, hidden);

    expect(GANTT_HIDEABLE_COLUMN_KEYS).toContain("owner");
    expect(visibleKeys).toEqual(expect.arrayContaining(["drag", "taskCode", "taskName"]));
    expect(visibleKeys).not.toContain("owner");
    expect(visibleKeys).not.toContain("predecessor");
    expect(ganttColumnTemplate(widths, false, hidden).split(" ")).toHaveLength(visibleKeys.length);
    expect(ganttColumnsWidth(widths, false, hidden)).toBe(
      visibleKeys.reduce((total, key) => total + widths[key], 0),
    );
  });

  it("keeps task description next to the task name and remark at the end", () => {
    expect(GANTT_EXPANDED_COLUMN_KEYS.indexOf("taskDescription")).toBe(
      GANTT_EXPANDED_COLUMN_KEYS.indexOf("taskName") + 1,
    );
    expect(GANTT_EXPANDED_COLUMN_KEYS.at(-1)).toBe("remark");
  });

  it("places priority between owner and duration so scheduling inputs stay grouped", () => {
    expect(GANTT_EXPANDED_COLUMN_KEYS.indexOf("priority")).toBe(
      GANTT_EXPANDED_COLUMN_KEYS.indexOf("owner") + 1,
    );
    expect(GANTT_EXPANDED_COLUMN_KEYS.indexOf("durationDays")).toBe(
      GANTT_EXPANDED_COLUMN_KEYS.indexOf("priority") + 1,
    );
  });

  it("shows every expanded column by default", () => {
    expect(GANTT_DEFAULT_HIDDEN_COLUMN_KEYS).toEqual([]);
    expect(ganttVisibleColumnKeys(false, new Set(GANTT_DEFAULT_HIDDEN_COLUMN_KEYS))).toEqual(GANTT_EXPANDED_COLUMN_KEYS);
  });
});
