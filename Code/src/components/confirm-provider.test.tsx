import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { ConfirmProvider, useConfirm } from "@/components/confirm-provider";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

function NestedDialogHarness() {
  const confirm = useConfirm();
  const [result, setResult] = useState("未确认");

  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>正式自动排期预览</DialogTitle>
        <button
          type="button"
          onClick={async () => setResult(await confirm("确认写入正式计划？") ? "已确认" : "已取消")}
        >
          打开确认框
        </button>
        <span>{result}</span>
      </DialogContent>
    </Dialog>
  );
}

describe("ConfirmProvider", () => {
  it("allows confirming above an already open dialog", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <NestedDialogHarness />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "打开确认框" }));
    expect(screen.getByRole("heading", { name: "请确认操作" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认" }));

    expect(await screen.findByText("已确认")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "请确认操作" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "正式自动排期预览" })).toBeInTheDocument();
  });

  it("allows cancelling above an already open dialog", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <NestedDialogHarness />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "打开确认框" }));
    await user.click(screen.getByRole("button", { name: "取消" }));

    expect(await screen.findByText("已取消")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "请确认操作" })).not.toBeInTheDocument();
  });
});
