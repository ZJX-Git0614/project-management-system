import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  Table,
  TableActionButton,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

describe("transparent table component library", () => {
  it("renders the shared transparent table structure and empty state", () => {
    render(
      <Table wrapperClassName="max-h-40">
        <TableHeader><TableRow><TableHead>名称</TableHead></TableRow></TableHeader>
        <TableBody><TableEmptyState colSpan={1}>没有记录</TableEmptyState></TableBody>
      </Table>,
    );

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("没有记录")).toHaveAttribute("colspan", "1");
    expect(screen.getByRole("table").parentElement).toHaveClass("max-h-40");
  });

  it("provides borderless row actions with normal button behavior", async () => {
    const onClick = vi.fn();
    render(
      <Table><TableBody><TableRow><TableCell><TableActionButton onClick={onClick}>下载</TableActionButton></TableCell></TableRow></TableBody></Table>,
    );

    const button = screen.getByRole("button", { name: "下载" });
    expect(button).toHaveClass("border-0", "bg-transparent");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps headers and cells transparent without segmented cell borders", () => {
    render(
      <Table>
        <TableHeader><TableRow><TableHead>名称</TableHead></TableRow></TableHeader>
        <TableBody><TableRow><TableCell>任务</TableCell></TableRow></TableBody>
      </Table>,
    );

    expect(screen.getByRole("columnheader", { name: "名称" })).toHaveClass("border-0", "bg-transparent");
    expect(screen.getByRole("cell", { name: "任务" })).toHaveClass("border-0", "bg-transparent");
  });
});
