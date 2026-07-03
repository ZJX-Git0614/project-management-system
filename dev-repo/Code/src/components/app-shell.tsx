"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useCallback } from "react";
import {
  CalendarDays,
  CalendarRange,
  ClipboardList,
  LayoutDashboard,
  ListTodo,
  LogOut,
  Menu,
  Search,
  ShieldAlert,
  TrendingUp,
  User,
  Wallet,
  X,
} from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { getDetailGroupPermissionKey, isDetailGroupActive } from "@/lib/navigation";
import { usePermission } from "@/lib/use-permission";
import { useCurrentProject } from "@/contexts/current-project-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { api } from "@/lib/api-client";
import { CurrentProjectSwitcher } from "@/components/current-project-switcher";
import { TODO_CHANGED_EVENT, TODO_CHANGED_STORAGE_KEY } from "@/lib/todo-events";

const AUTH_FREE_PATHS = ["/login", "/force-change-password"];

type NavMenuItem = {
  href: string;
  label: string;
  active: boolean;
  permissionKey: string;
  icon?: React.ReactNode;
  meta?: string;
};

type NavMenuGroup = {
  title: string;
  items: NavMenuItem[];
};

const SidebarContent = ({
  searchTerm,
  onSearchChange,
  filteredGroups,
  currentUser,
  onMobileClose,
  onLogout,
}: {
  searchTerm: string;
  onSearchChange: (val: string) => void;
  filteredGroups: NavMenuGroup[];
  currentUser?: { id: string; username: string; assignedRoleNames: string[] };
  onMobileClose?: () => void;
  onLogout: () => void;
}) => (
  <div className="flex h-full flex-col gap-3">
    {/* Search */}
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
      <Input
        type="text"
        value={searchTerm}
        onChange={(e) => onSearchChange(e.target.value)}
        className="h-8 pl-9 text-xs"
      />
      {searchTerm && (
        <button
          onClick={() => onSearchChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>

    {/* Nav Groups */}
    <nav className="flex-1 space-y-2.5 overflow-y-auto">
      {filteredGroups.map((group, gi) => (
        <div key={group.title}>
          {gi > 0 && <Separator className="mb-2" />}
          <div className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/60">
            {group.title}
          </div>
          <div className="space-y-0.5">
            {group.items.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => onMobileClose?.()}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs transition-all duration-150",
                  item.active
                    ? "bg-primary/10 text-foreground font-medium"
                    : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                )}
              >
                {item.icon && <span className="size-4 shrink-0 text-primary/70">{item.icon}</span>}
                <span className="truncate">{item.label}</span>
                {item.meta && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                    {item.meta}
                  </Badge>
                )}
              </Link>
            ))}
          </div>
        </div>
      ))}
      {filteredGroups.length === 0 && (
        <div className="px-2 py-4 text-xs text-muted-foreground/60">
          未找到匹配菜单
        </div>
      )}
    </nav>

    {/* User Footer */}
    <div className="border-t border-border pt-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent/40">
            <User className="size-3.5 text-primary/70" />
            <div className="flex-1 text-left min-w-0">
              <div className="font-medium text-foreground truncate text-[11px]">
                {currentUser?.username ?? "未登录"}
              </div>
              <div className="text-[10px] text-muted-foreground/60 truncate">
                {currentUser
                  ? currentUser.assignedRoleNames.join("、") || "未分配角色"
                  : "—"}
              </div>
            </div>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={8} className="w-48">
          <DropdownMenuLabel className="text-[11px]">
            {currentUser?.username} · {currentUser ? currentUser.assignedRoleNames.join("、") || "未分配角色" : "—"}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer text-destructive" onClick={onLogout}>
            <LogOut className="size-3.5" />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
);

export const AppShell = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const fullPath = queryString ? `${pathname}?${queryString}` : pathname;
  const { user: authUser, loading: authLoading, logout: authLogout } = useAuth();
  const { can } = usePermission();
  const { currentProjectId, clearCurrentProject } = useCurrentProject();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [todoCount, setTodoCount] = useState<number>(0);

  const isAuthFree = AUTH_FREE_PATHS.includes(pathname);

  useEffect(() => {
    if (isAuthFree || authLoading) return;
    if (!authUser) {
      router.replace("/login");
    }
  }, [pathname, isAuthFree, router, authUser, authLoading]);

  // 回到「项目列表」= 视为重选起点：清空 currentProjectId，菜单折叠回「项目列表」一项
  // 只在 pathname 变化时检查（避免在 /projects 页面写入 currentProjectId 时被此 effect 误清）
  useEffect(() => {
    if (pathname === "/projects" && currentProjectId) {
      clearCurrentProject();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // 项目列表是唯一项目入口：只有点击项目列表并写入当前项目后才展开项目详情导航。
  const hasSelectedProject = Boolean(currentProjectId);

  const refreshTodoCount = useCallback(async () => {
    if (isAuthFree || !authUser) return;
    try {
      const data = await api.get<{ count: number }>("/api/todos/count");
      setTodoCount(data.count);
    } catch {
      // ignore badge refresh failure
    }
  }, [isAuthFree, authUser]);

  useEffect(() => {
    if (isAuthFree || !authUser) return;
    void Promise.resolve().then(refreshTodoCount);
    const handleTodoChanged = () => {
      void refreshTodoCount();
    };
    const handleTodoStorageChanged = (event: StorageEvent) => {
      if (event.key === TODO_CHANGED_STORAGE_KEY) {
        void refreshTodoCount();
      }
    };
    window.addEventListener(TODO_CHANGED_EVENT, handleTodoChanged);
    window.addEventListener("storage", handleTodoStorageChanged);
    window.addEventListener("focus", handleTodoChanged);
    const interval = setInterval(handleTodoChanged, 30000);
    return () => {
      window.removeEventListener(TODO_CHANGED_EVENT, handleTodoChanged);
      window.removeEventListener("storage", handleTodoStorageChanged);
      window.removeEventListener("focus", handleTodoChanged);
      clearInterval(interval);
    };
  }, [isAuthFree, authUser, refreshTodoCount]);

  const handleLogout = () => {
    authLogout();
  };

  const currentUser = authUser
    ? {
        id: authUser.id,
        username: authUser.username,
        assignedRoleNames: authUser.assignedRoleNames,
      }
    : undefined;

  const detailHrefs = useMemo(
    () => ({
      project: currentProjectId
        ? `/projects/${currentProjectId}?nav=project`
        : "/projects",
    }),
    [currentProjectId],
  );

  const allGroups: NavMenuGroup[] = [
    {
      title: "项目经营驾驶舱",
      items: [
        {
          href: "/projects",
          label: "项目列表",
          active: pathname === "/projects",
          permissionKey: "project-list:view",
          icon: <LayoutDashboard className="size-4" />,
        },
        ...(hasSelectedProject
          ? [
              {
                href: detailHrefs.project,
                label: "项目信息管理",
                active: isDetailGroupActive(fullPath, "project"),
                permissionKey: getDetailGroupPermissionKey("project"),
                icon: <ClipboardList className="size-4" />,
              } as NavMenuItem,


            ]
          : []),
      ],
    },
    {
      title: "项目进度管理",
      items: hasSelectedProject
        ? [
            {
              href: currentProjectId ? `/projects/${currentProjectId}?nav=gantt` : "/projects",
              label: "项目进度甘特图",
              active: isDetailGroupActive(fullPath, "gantt"),
              permissionKey: getDetailGroupPermissionKey("gantt"),
              icon: <TrendingUp className="size-4" />,
            },
            {
              href: "/monthly-items",
              label: "本月事项",
              active: pathname === "/monthly-items",
              permissionKey: "monthly-items:view",
              icon: <CalendarRange className="size-4" />,
            },
            {
              href: "/weekly-items",
              label: "本周事项",
              active: pathname === "/weekly-items",
              permissionKey: "weekly-items:view",
              icon: <CalendarDays className="size-4" />,
            },
          ]
        : [],
    },
    {
      title: "项目成本管理",
      items: hasSelectedProject
        ? [
            {
              href: currentProjectId ? `/projects/${currentProjectId}?nav=budget` : "/projects",
              label: "项目预算管理",
              active: isDetailGroupActive(fullPath, "budget"),
              permissionKey: getDetailGroupPermissionKey("budget"),
              icon: <Wallet className="size-4" />,
            },
          ]
        : [],
    },
    {
      title: "项目风险管理",
      items: hasSelectedProject
        ? [
            {
              href: "/risk-register",
              label: "风险登记册",
              active: pathname === "/risk-register",
              permissionKey: "risk-register:view",
              icon: <ShieldAlert className="size-4" />,
            },
          ]
        : [],
    },
    {
      title: "系统设置",
      items: [
        {
          href: "/role-config",
          label: "项目角色与人员管理",
          active: pathname === "/role-config",
          permissionKey: "role-config:view",
          icon: <User className="size-4" />,
        },
        {
          href: "/admin/accounts",
          label: "后台账号管理",
          active: pathname === "/admin/accounts",
          permissionKey: "account-management:view",
          icon: <ListTodo className="size-4" />,
        },
      ],
    },
  ];

  const visibleGroups = allGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => can(item.permissionKey)),
    }))
    .filter((group) => group.items.length > 0);

  const filteredGroups = searchTerm
    ? visibleGroups
        .map((group) => ({
          ...group,
          items: group.items.filter((item) =>
            item.label.toLowerCase().includes(searchTerm.toLowerCase()) ||
            group.title.toLowerCase().includes(searchTerm.toLowerCase()),
          ),
        }))
        .filter((group) => group.items.length > 0)
    : visibleGroups;

  if (isAuthFree) {
    return <>{children}</>;
  }

  const sidebarProps = {
    searchTerm,
    onSearchChange: setSearchTerm,
    filteredGroups,
    currentUser,
    onMobileClose: () => setMobileOpen(false),
    onLogout: handleLogout,
  };

  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col bg-background">
        {/* Topbar */}
        <header className="sticky top-0 z-40 w-full border-b border-border bg-card/80 backdrop-blur-md supports-[backdrop-filter]:bg-card/60">
          <div className="flex h-11 items-center gap-3 px-3">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden size-8"
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              {mobileOpen ? <X className="size-4" /> : <Menu className="size-4" />}
            </Button>

            <div className="flex items-center gap-2 shrink-0">
              <div className="size-2 rounded-full bg-primary shadow-[0_0_8px_var(--color-primary)]" />
              <div className="hidden sm:block">
                <div className="text-xs font-semibold tracking-tight text-foreground">
                  Ceastar项目管理系统
                </div>
                <div className="text-[10px] text-muted-foreground/60">
                  项目进度与事项追踪平台
                </div>
              </div>
            </div>

            <div className="flex-1" />

            <CurrentProjectSwitcher />

            <Tooltip>
              <TooltipTrigger asChild>
                <Link href="/todos">
                  <Button
                    variant={pathname.startsWith("/todos") ? "default" : "ghost"}
                    size="sm"
                    className="h-8 text-xs relative"
                  >
                    待办中心
                    {todoCount > 0 && (
                      <span className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white leading-none">
                        {todoCount > 99 ? "99+" : todoCount}
                      </span>
                    )}
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent>第一阶段保留</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <div className="flex flex-1">
          <aside className="hidden md:flex sticky top-11 h-[calc(100vh-44px)] w-56 shrink-0 flex-col border-r border-border bg-card/60 p-2.5">
            <SidebarContent {...sidebarProps} />
          </aside>

          {mobileOpen && (
            <div className="fixed inset-0 z-50 md:hidden">
              <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={() => setMobileOpen(false)}
              />
              <aside className="absolute left-0 top-0 h-full w-60 border-r border-border bg-card p-3 animate-in slide-in-from-left-4 duration-200">
                <SidebarContent {...sidebarProps} />
              </aside>
            </div>
          )}

          <main className="flex-1 overflow-auto p-4 lg:p-6">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
};
