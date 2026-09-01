import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { useCommitOnOutsidePointer } from "@/lib/use-commit-on-outside-pointer";

const Harness = ({ commit }: { commit: () => void }) => {
  const rowRef = useRef<HTMLDivElement>(null);
  useCommitOnOutsidePointer(true, rowRef, commit);

  return (
    <>
      <div ref={rowRef} data-testid="editing-row">
        <input aria-label="编辑值" defaultValue="草稿" />
      </div>
      <div className="gantt-context-menu" data-testid="context-menu">菜单</div>
      <button type="button">空白区域</button>
    </>
  );
};

describe("useCommitOnOutsidePointer", () => {
  it("commits on a pointer press outside the active row", () => {
    const commit = vi.fn();
    render(<Harness commit={commit} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "空白区域" }));

    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("does not commit while interacting with the row or its context menu", () => {
    const commit = vi.fn();
    render(<Harness commit={commit} />);

    fireEvent.pointerDown(screen.getByRole("textbox", { name: "编辑值" }));
    fireEvent.pointerDown(screen.getByTestId("context-menu"));

    expect(commit).not.toHaveBeenCalled();
  });
});
