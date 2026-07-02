import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 text-sm font-medium outline-none transition-[color,background-color,border-color,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-primary/50 bg-primary/85 text-primary-foreground shadow-[0_0_24px_rgba(113,112,255,0.18)] hover:bg-primary",
        destructive:
          "border border-destructive/50 bg-destructive/15 text-destructive hover:bg-destructive/25",
        outline:
          "border border-border bg-background/35 text-foreground hover:border-primary/45 hover:bg-primary/10 hover:text-primary-foreground",
        secondary:
          "border border-border bg-secondary/65 text-secondary-foreground hover:bg-secondary",
        ghost: "bg-transparent text-muted-foreground hover:text-foreground",
        link: "border-0 bg-transparent px-0 text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-9 h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-lg px-6",
        icon: "h-9 w-9 p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
