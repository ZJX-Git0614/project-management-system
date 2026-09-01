import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TableContextMenu } from "@/components/table-context-menu";

describe("TableContextMenu", () => {
  it("opens a submenu and invokes its selected action", async () => {
    const onClose = vi.fn();
    const onPaste = vi.fn();
    render(
      <TableContextMenu
        menu={{
          x: 20,
          y: 20,
          actions: [{
            label: "粘贴",
            children: [{ label: "粘贴到行下方", onSelect: onPaste }],
          }],
        }}
        onClose={onClose}
      />,
    );

    await userEvent.hover(screen.getByRole("menuitem", { name: "粘贴" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "粘贴到行下方" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledTimes(1);
  });

  it.each([0, 2])("closes when pointer button %s is pressed outside", (button) => {
    const onClose = vi.fn();
    render(
      <TableContextMenu
        menu={{ x: 20, y: 20, actions: [{ label: "复制", onSelect: vi.fn() }] }}
        onClose={onClose}
      />,
    );

    fireEvent.pointerDown(document.body, { button });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a submenu open while the pointer crosses into it", () => {
    vi.useFakeTimers();
    render(
      <TableContextMenu
        menu={{
          x: 20,
          y: 20,
          actions: [{ label: "插入", children: [{ label: "在下方插入", onSelect: vi.fn() }] }],
        }}
        onClose={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("menuitem", { name: "插入" });
    const anchor = trigger.parentElement!;
    fireEvent.mouseEnter(anchor);
    expect(screen.getByRole("menuitem", { name: "在下方插入" })).toBeInTheDocument();

    fireEvent.mouseLeave(anchor);
    expect(screen.getByRole("menuitem", { name: "在下方插入" })).toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByRole("menu", { name: "插入" }));

    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("menuitem", { name: "在下方插入" })).toBeInTheDocument();
    vi.useRealTimers();
  });
});
