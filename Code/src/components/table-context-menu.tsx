"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TableContextMenuAction {
  label: string;
  onSelect?: () => void | Promise<void>;
  disabled?: boolean;
  destructive?: boolean;
  icon?: ReactNode;
  shortcut?: string;
  separatorBefore?: boolean;
  children?: TableContextMenuAction[];
}

interface ContextMenuState {
  x: number;
  y: number;
  actions: TableContextMenuAction[];
  title?: string;
  description?: string;
}

export const useTableContextMenu = () => {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const openContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    actions: TableContextMenuAction[],
    context?: { title?: string; description?: string },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (actions.length === 0) {
      setMenu(null);
      return;
    }
    const menuWidth = 286;
    const menuHeight = Math.min(430, actions.length * 38 + (context?.title || context?.description ? 58 : 16));
    const offset = 6;
    setMenu({
      x: Math.max(8, Math.min(event.clientX + offset, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY + offset, window.innerHeight - menuHeight - 8)),
      actions,
      ...context,
    });
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
  const submenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);

  const cancelSubmenuClose = () => {
    if (submenuCloseTimerRef.current) {
      clearTimeout(submenuCloseTimerRef.current);
      submenuCloseTimerRef.current = null;
    }
  };

  const showSubmenu = (label: string) => {
    cancelSubmenuClose();
    setOpenSubmenu(label);
  };

  const scheduleSubmenuClose = (label: string) => {
    cancelSubmenuClose();
    submenuCloseTimerRef.current = setTimeout(() => {
      setOpenSubmenu((current) => current === label ? null : current);
      submenuCloseTimerRef.current = null;
    }, 160);
  };

  useEffect(() => {
    cancelSubmenuClose();
    setOpenSubmenu(null);
    return cancelSubmenuClose;
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const handleScroll = () => onClose();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [menu, onClose]);

  if (!menu || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="表格操作菜单"
      className={cn(
        "gantt-context-menu fixed z-[130] rounded-md border border-border bg-card text-card-foreground shadow-[var(--app-shadow-popover)]",
        menu.x > window.innerWidth / 2 && "gantt-context-menu-open-left",
      )}
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {(menu.title || menu.description) && (
        <div className="gantt-context-menu-header">
          {menu.title && <div className="truncate font-medium text-foreground">{menu.title}</div>}
          {menu.description && <div className="mt-0.5 truncate">{menu.description}</div>}
        </div>
      )}
      {menu.actions.map((action) => {
        const hasChildren = Boolean(action.children?.length);
        return (
          <div
            key={action.label}
            className={hasChildren ? "gantt-context-menu-submenu-anchor" : undefined}
            onMouseEnter={() => hasChildren && !action.disabled && showSubmenu(action.label)}
            onMouseLeave={() => hasChildren && scheduleSubmenuClose(action.label)}
          >
            {action.separatorBefore && <div className="gantt-context-menu-separator" />}
            <button
              type="button"
              role="menuitem"
              disabled={action.disabled}
              className={cn(
                "gantt-context-menu-item",
                action.destructive && "gantt-context-menu-item-danger",
              )}
              onClick={() => {
                if (hasChildren) {
                  cancelSubmenuClose();
                  setOpenSubmenu((current) => current === action.label ? null : action.label);
                  return;
                }
                onClose();
                void action.onSelect?.();
              }}
            >
              {action.icon}
              <span>{action.label}</span>
              {action.shortcut && <kbd>{action.shortcut}</kbd>}
              {hasChildren && <ChevronRight className="ml-auto size-3.5" />}
            </button>
            {hasChildren && openSubmenu === action.label && (
              <div
                className="gantt-context-submenu"
                role="menu"
                aria-label={action.label}
                onMouseEnter={cancelSubmenuClose}
                onMouseLeave={() => scheduleSubmenuClose(action.label)}
              >
                {action.children!.map((child) => (
                  <div key={child.label}>
                    {child.separatorBefore && <div className="gantt-context-menu-separator" />}
                    <button
                      type="button"
                      role="menuitem"
                      disabled={child.disabled}
                      className={cn(
                        "gantt-context-menu-item",
                        child.destructive && "gantt-context-menu-item-danger",
                      )}
                      onClick={() => {
                        onClose();
                        void child.onSelect?.();
                      }}
                    >
                      {child.icon}
                      <span>{child.label}</span>
                      {child.shortcut && <kbd>{child.shortcut}</kbd>}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
};
