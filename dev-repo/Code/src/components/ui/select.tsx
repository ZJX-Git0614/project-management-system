"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange"> {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, value, onChange, disabled, name, ...rest }, ref) => {
    const [open, setOpen] = React.useState(false);
    const buttonRef = React.useRef<HTMLButtonElement>(null);
    const justSelected = React.useRef(false);

    const options: Array<{ value: string; label: string }> = [];
    React.Children.forEach(children, (child) => {
      if (React.isValidElement<{ value?: string; children?: React.ReactNode }>(child) && child.type === "option") {
        options.push({
          value: child.props.value ?? "",
          label: typeof child.props.children === "string" ? child.props.children : child.props.value ?? "",
        });
      }
    });

    const selectedOption = options.find((opt) => opt.value === value);

    const triggerChange = (optionValue: string) => {
      if (onChange) {
        const syntheticEvent = {
          target: { value: optionValue, name: name ?? "" },
          currentTarget: { value: optionValue, name: name ?? "" },
          preventDefault: () => {},
          stopPropagation: () => {},
          nativeEvent: new Event("change"),
          type: "change",
          bubbles: true,
          cancelable: true,
          defaultPrevented: false,
          isDefaultPrevented: () => false,
          isPropagationStopped: () => false,
          persist: () => {},
          timeStamp: Date.now(),
        } as unknown as React.ChangeEvent<HTMLSelectElement>;
        onChange(syntheticEvent);
      }
    };

    const handleSelect = (optionValue: string) => {
      justSelected.current = true;
      triggerChange(optionValue);
      setOpen(false);
      setTimeout(() => {
        justSelected.current = false;
      }, 100);
    };

    const handleFocus = () => {
      if (!justSelected.current && !open) {
        setOpen(true);
      }
    };

    return (
      <DropdownMenuPrimitive.Root open={open} onOpenChange={setOpen}>
        <DropdownMenuPrimitive.Trigger asChild disabled={disabled}>
          <button
            ref={buttonRef}
            type="button"
            data-slot="select"
            className={cn(
              "flex h-9 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors duration-200",
              "focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
              className
            )}
            disabled={disabled}
            onFocus={handleFocus}
          >
            <span className={cn("flex-1 truncate text-left", !selectedOption && "text-muted-foreground")}>
              {selectedOption?.label ?? ""}
            </span>
            <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")} />
          </button>
        </DropdownMenuPrimitive.Trigger>
        <DropdownMenuPrimitive.Portal>
          <DropdownMenuPrimitive.Content
            className="z-50 max-h-60 min-w-[8rem] overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
            align="start"
            sideOffset={4}
          >
            {options.map((option) => (
              <DropdownMenuPrimitive.Item
                key={option.value}
                className={cn(
                  "relative flex cursor-pointer select-none items-center rounded-sm px-3 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground",
                  option.value === value && "bg-accent/50"
                )}
                onSelect={() => handleSelect(option.value)}
              >
                <span className="flex-1">{option.label}</span>
                {option.value === value && <Check className="h-4 w-4 shrink-0 text-primary" />}
              </DropdownMenuPrimitive.Item>
            ))}
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
    );
  }
);
Select.displayName = "Select";

export { Select };
