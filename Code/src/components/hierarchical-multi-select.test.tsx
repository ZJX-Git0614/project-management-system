import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { HierarchicalMultiSelect } from "@/components/hierarchical-multi-select";

const options = [
  { id: "task-1", label: "Task1", secondaryLabel: "软件开发" },
  { id: "task-1-1", label: "Task1.1", secondaryLabel: "前端开发", parentId: "task-1" },
  { id: "task-2", label: "Task2", secondaryLabel: "测试" },
];

function TestSelect() {
  const [value, setValue] = useState<string[]>([]);
  return <HierarchicalMultiSelect ariaLabel="关联任务" options={options} value={value} onChange={setValue} />;
}

describe("HierarchicalMultiSelect", () => {
  it("can render its options open on mount for single-click inline editing", () => {
    render(
      <HierarchicalMultiSelect
        ariaLabel="关联项目事项"
        options={options}
        value={[]}
        onChange={() => undefined}
        multiple={false}
        defaultOpen
      />,
    );

    expect(screen.getByRole("textbox", { name: "关联项目事项搜索" })).toBeInTheDocument();
  });

  it("never opens or emits a value change while disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <HierarchicalMultiSelect
        ariaLabel="只读负责人"
        options={options}
        value={["task-1"]}
        onChange={onChange}
        disabled
        defaultOpen
      />,
    );

    expect(screen.queryByRole("textbox", { name: "只读负责人搜索" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "只读负责人" }));
    expect(screen.queryByRole("textbox", { name: "只读负责人搜索" })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("selects descendants and marks a parent indeterminate after a child is cleared", async () => {
    const user = userEvent.setup();
    render(<TestSelect />);

    await user.click(screen.getByRole("button", { name: "关联任务" }));
    await user.click(screen.getByRole("checkbox", { name: "选择 Task1" }));

    expect(screen.getByRole("checkbox", { name: "选择 Task1" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "展开 Task1" }));
    expect(screen.getByRole("checkbox", { name: "选择 Task1.1" })).toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "选择 Task1.1" }));

    const parent = screen.getByRole<HTMLInputElement>("checkbox", { name: "选择 Task1" });
    expect(parent.checked).toBe(false);
    expect(parent.indeterminate).toBe(true);
  });

  it("filters with highlighted matching text", async () => {
    const user = userEvent.setup();
    render(<TestSelect />);

    await user.click(screen.getByRole("button", { name: "关联任务" }));
    await user.type(screen.getByRole("textbox", { name: "关联任务搜索" }), "前端");

    expect(screen.getByText("前端").tagName).toBe("MARK");
    expect(screen.queryByRole("checkbox", { name: "选择 Task2" })).not.toBeInTheDocument();
  });
});
