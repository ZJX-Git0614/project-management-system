"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const Select = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<"select">
>(({ className, children, ...props }, ref) => {
  return (
    <select
      ref={ref}
      data-slot="select"
      className={cn(
        "flex h-9 w-full min-w-0 cursor-pointer appearance-none rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-sm transition-colors duration-200",
        "focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "bg-[image:url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%23808894'%3E%3Cpath d='m3 5 3 3 3-3'/%3E%3C/svg%3E\")] bg-[length:12px_12px] bg-[right_10px_center] bg-no-repeat pr-8",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
});
Select.displayName = "Select";

export { Select };
