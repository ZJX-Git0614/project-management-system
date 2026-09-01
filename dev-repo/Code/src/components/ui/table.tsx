import * as React from "react";
import { cn } from "@/lib/utils";

type TableProps = React.ComponentProps<"table"> & {
  wrapperClassName?: string;
};

function Table({ className, wrapperClassName, ...props }: TableProps) {
  return (
    <div data-slot="table-wrapper" className={cn("relative w-full overflow-auto rounded-lg border border-border/70 bg-transparent", wrapperClassName)}>
      <table
        data-slot="table"
        className={cn("w-full caption-bottom border-collapse bg-transparent text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("border-b border-border/80 bg-muted/55 [&_tr]:border-b-0", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-border bg-transparent transition-[background-color,box-shadow] duration-150 ease-out hover:bg-primary/[0.05] data-[state=selected]:bg-primary/10",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-8 border-0 bg-transparent px-3 text-left align-middle text-xs font-semibold text-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "h-8 border-0 bg-transparent px-3 align-middle text-xs [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

const TableToolbar = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(function TableToolbar(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="table-toolbar"
      className={cn("flex flex-wrap items-center justify-between gap-2 border-b border-border/70 pb-3", className)}
      {...props}
    />
  );
});

type TableActionButtonProps = React.ComponentProps<"button"> & {
  tone?: "default" | "destructive";
};

const TableActionButton = React.forwardRef<HTMLButtonElement, TableActionButtonProps>(function TableActionButton(
  { className, tone = "default", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-slot="table-action-button"
      className={cn(
        "inline-flex h-7 items-center justify-center gap-1.5 border-0 bg-transparent px-2 text-xs font-medium outline-none transition-colors",
        "hover:bg-primary/[0.07] hover:text-primary focus-visible:text-primary disabled:pointer-events-none disabled:opacity-40",
        tone === "destructive" && "text-destructive hover:bg-destructive/[0.07] hover:text-destructive focus-visible:text-destructive",
        className,
      )}
      {...props}
    />
  );
});

const TableIconButton = React.forwardRef<HTMLButtonElement, TableActionButtonProps>(function TableIconButton(
  { className, tone = "default", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-slot="table-icon-button"
      className={cn(
        "inline-flex size-7 items-center justify-center border-0 bg-transparent p-0 text-muted-foreground outline-none transition-colors",
        "hover:text-primary focus-visible:text-primary disabled:pointer-events-none disabled:opacity-35",
        tone === "destructive" && "text-destructive hover:text-destructive focus-visible:text-destructive",
        className,
      )}
      {...props}
    />
  );
});

function TableEmptyState({ colSpan, children = "暂无数据", className }: { colSpan: number; children?: React.ReactNode; className?: string }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className={cn("h-20 text-center text-muted-foreground", className)}>{children}</TableCell>
    </TableRow>
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableToolbar,
  TableActionButton,
  TableIconButton,
  TableEmptyState,
};
