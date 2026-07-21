import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Select } from "@/components/ui/select";

function ControlledSelect({ onValueChange = vi.fn() }: { onValueChange?: (value: string) => void }) {
  const [value, setValue] = useState("NORMAL");

  return (
    <Select
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
        onValueChange(event.target.value);
      }}
    >
      <option value="LOW">低</option>
      <option value="NORMAL">普通</option>
      <option value="HIGH">高</option>
      <option value="URGENT">紧急</option>
    </Select>
  );
}

describe("Select", () => {
  it("opens on click and keeps the selected value visible", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<ControlledSelect onValueChange={onValueChange} />);

    await user.click(screen.getByRole("button", { name: "普通" }));
    await user.click(screen.getByText("高"));

    expect(onValueChange).toHaveBeenCalledWith("HIGH");
    expect(screen.getByRole("button", { name: "高" })).toBeInTheDocument();
  });
});
