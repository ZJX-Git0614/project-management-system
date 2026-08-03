"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface TableContextMenuAction {
  label: string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  destructive?: boolean;
  icon?: ReactNode;
}

interface ContextMenuState {
  x: number;
  y: number;
  actions: TableContextMenuAction[];
}

export const useTableContextMenu = () => {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const openContextMenu = (event: React.MouseEvent<HTMLElement>, actions: TableContextMenuAction[]) => {
    event.preventDefault();
    event.stopPropagation();
    if (actions.length === 0) {
      setMenu(null);
      return;
    }
    setMenu({ x: event.clientX, y: event.clientY, actions });
  };

  return {
    menu,
    openContextMenu,
    closeContextMenu: () => setMenu(null),
  };
};

export const TableContextMenu = ({
  menu,
  onClose,
}: {
  menu: ContextMenuState | null;
  onClose: () => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menu, onClose]);

  if (!menu || typeof document === "undefined") return null;

  const maxX = Math.max(8, window.innerWidth - 232);
  const maxY = Math.max(8, window.innerHeight - Math.min(360, menu.actions.length * 38 + 16));

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="表格操作菜单"
      className="fixed z-[100] min-w-[208px] rounded-lg border border-border/80 bg-popover p-1.5 text-popover-foreground shadow-2xl"
      style={{ left: Math.min(menu.x, maxX), top: Math.min(menu.y, maxY) }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.actions.map((action) => (
        <button
          key={action.label}
          type="button"
          role="menuitem"
          disabled={action.disabled}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs transition-colors",
            "hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40",
            action.destructive && "text-destructive hover:bg-destructive/10 hover:text-destructive",
          )}
          onClick={() => {
            onClose();
            void action.onSelect();
          }}
        >
          {action.icon}
          <span>{action.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
};
