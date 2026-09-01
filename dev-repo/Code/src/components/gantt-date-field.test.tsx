import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GanttDateField } from "@/components/gantt-date-field";

describe("GanttDateField", () => {
  it("renders a compact display-only date without disabled input geometry", () => {
    render(
      <GanttDateField
        ariaLabel="计划开始"
        onChange={vi.fn()}
        onCommit={vi.fn()}
        readOnly
        slot="PM"
        value="2026-08-03"
      />,
    );

    const date = screen.getByLabelText("计划开始");
    expect(date).toHaveClass("gantt-date-display");
    expect(date).toHaveTextContent("2026-08-03");
    expect(date).toHaveTextContent("↓");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("renders an abstract relative label without treating it as a date", () => {
    render(
      <GanttDateField
        ariaLabel="计划完成"
        displayValue="T0+5"
        onChange={vi.fn()}
        onCommit={vi.fn()}
        readOnly
        value=""
      />,
    );

    expect(screen.getByLabelText("计划完成")).toHaveTextContent("T0+5");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
