"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  AlertTriangle,
  CalendarDays,
  ChartNoAxesCombined,
  ClipboardList,
  DatabaseBackup,
  FileText,
  LayoutDashboard,
  ListTodo,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
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
import { CurrentProjectSwitcher } from "@/components/current-project-switcher";
import { ADMIN_ROLE_NAME } from "@/lib/permissions";
import { ProjectAssistant } from "@/components/project-assistant";
import { api } from "@/lib/api-client";
import { TODO_CHANGED_EVENT } from "@/lib/todo-events";

const AUTH_FREE_PATHS = ["/login", "/force-change-password"];
const SIDEBAR_VISIBILITY_STORAGE_KEY = "pms.desktopSidebarVisible";

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
          <div className="mb-1.5 px-2 text-[10px] font-semibold tracking-normal text-muted-foreground/60">
            {group.title}
          </div>
          <div className="space-y-0.5">
            {group.items.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                data-slot="sidebar-nav-link"
                aria-current={item.active ? "page" : undefined}
                onClick={() => onMobileClose?.()}
                className={cn(
                  "group relative flex items-center gap-2.5 overflow-hidden rounded-md border border-transparent px-2.5 py-1.5 text-xs transition-[color,background-color,border-color,box-shadow,transform] duration-150 active:scale-[0.985]",
                  item.active
                    ? "border-primary/30 bg-primary/15 font-medium text-foreground shadow-[inset_3px_0_0_rgba(59,130,246,0.9),0_6px_18px_rgba(37,99,235,0.10)]"
                    : "text-muted-foreground hover:border-primary/15 hover:bg-primary/[0.07] hover:text-foreground hover:shadow-[0_4px_14px_rgba(0,0,0,0.14)]",
                )}
              >
                {item.icon && (
                  <span className={cn(
                    "size-4 shrink-0 transition-colors duration-150 group-hover:text-primary",
                    item.active ? "text-primary" : "text-muted-foreground/70",
                  )}>
                    {item.icon}
                  </span>
                )}
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
          <button className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-xs transition-[background-color,border-color,transform] hover:border-primary/15 hover:bg-primary/[0.07] active:scale-[0.985]">
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
  const { currentProjectId, currentProject, clearCurrentProject } = useCurrentProject();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopSidebarVisible, setDesktopSidebarVisible] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [todoCounts, setTodoCounts] = useState({ count: 0, notificationCount: 0 });

  const isAuthFree = AUTH_FREE_PATHS.includes(pathname);

  useEffect(() => {
    setDesktopSidebarVisible(
      window.localStorage.getItem(SIDEBAR_VISIBILITY_STORAGE_KEY) !== "hidden",
    );
  }, []);

  const toggleDesktopSidebar = () => {
    setDesktopSidebarVisible((current) => {
      const next = !current;
      window.localStorage.setItem(SIDEBAR_VISIBILITY_STORAGE_KEY, next ? "visible" : "hidden");
      return next;
    });
  };

  useEffect(() => {
    if (isAuthFree || authLoading) return;
    if (!authUser) {
      router.replace("/login");
    }
  }, [pathname, isAuthFree, router, authUser, authLoading]);

  useEffect(() => {
    if (!authUser || isAuthFree) return;
    const loadTodoCounts = () => {
      void api.get<{ count: number; notificationCount?: number }>("/api/todos/count")
        .then((result) => setTodoCounts({ count: result.count, notificationCount: result.notificationCount ?? 0 }))
        .catch(() => undefined);
    };
    loadTodoCounts();
    const interval = window.setInterval(loadTodoCounts, 30_000);
    window.addEventListener(TODO_CHANGED_EVENT, loadTodoCounts);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(TODO_CHANGED_EVENT, loadTodoCounts);
    };
  }, [authUser, isAuthFree]);

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
  const isSuperAdmin = authUser?.assignedRoleNames.includes(ADMIN_ROLE_NAME) ?? false;

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
      title: "项目绩效管理",
      items: hasSelectedProject
        ? [
            {
              href: currentProjectId ? `/projects/${currentProjectId}?nav=performance` : "/projects",
              label: "挣值分析",
              active: isDetailGroupActive(fullPath, "performance"),
              permissionKey: getDetailGroupPermissionKey("performance"),
              icon: <ChartNoAxesCombined className="size-4" />,
            },
          ]
        : [],
    },
    {
      title: "项目进度管理",
      items: hasSelectedProject
        ? [
            {
              href: currentProjectId ? `/projects/${currentProjectId}?nav=gantt` : "/projects",
              label: "项目进度管理",
              active: isDetailGroupActive(fullPath, "gantt"),
              permissionKey: getDetailGroupPermissionKey("gantt"),
              icon: <TrendingUp className="size-4" />,
            },
            {
              href: "/weekly-items",
              label: "项目事项管理",
              active: pathname === "/weekly-items",
              permissionKey: "weekly-items:view",
              icon: <CalendarDays className="size-4" />,
            },
          ]
        : [],
    },
    {
      title: "项目范围管理",
      items: hasSelectedProject
        ? [
            {
              href: currentProjectId ? `/projects/${currentProjectId}?nav=documents` : "/projects",
              label: "文档清单管理",
              active: isDetailGroupActive(fullPath, "documents"),
              permissionKey: getDetailGroupPermissionKey("documents"),
              icon: <FileText className="size-4" />,
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
        ...(isSuperAdmin
          ? [
              {
                href: "/admin/assistant-settings",
                label: "智能助手设置",
                active: pathname === "/admin/assistant-settings",
                permissionKey: "account-management:view",
                icon: <Bot className="size-4" />,
              } as NavMenuItem,
              {
                href: "/admin/data-cleanup",
                label: "系统数据管理",
                active: pathname === "/admin/data-cleanup",
                permissionKey: "account-management:view",
                icon: <DatabaseBackup className="size-4" />,
              } as NavMenuItem,
            ]
          : []),
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
        <header className="sticky top-0 z-40 w-full border-b border-border/90 bg-card/85 shadow-[0_1px_0_rgba(255,255,255,0.025),0_8px_24px_rgba(0,0,0,0.12)] backdrop-blur-md supports-[backdrop-filter]:bg-card/70">
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

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="hidden size-8 md:inline-flex"
                  onClick={toggleDesktopSidebar}
                  aria-label={desktopSidebarVisible ? "收起侧边栏" : "展开侧边栏"}
                >
                  {desktopSidebarVisible ? <PanelLeftClose /> : <PanelLeftOpen />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{desktopSidebarVisible ? "收起侧边栏" : "展开侧边栏"}</TooltipContent>
            </Tooltip>

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
                    {todoCounts.count > 0 && (
                      <span className="ml-1 inline-flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground">
                        {todoCounts.count > 99 ? "99+" : todoCounts.count}
                      </span>
                    )}
                  </Button>
                </Link>
              </TooltipTrigger>
              <TooltipContent>查看待办事项</TooltipContent>
            </Tooltip>
          </div>
        </header>

        {todoCounts.notificationCount > 0 && !pathname.startsWith("/todos") && (
          <div className="app-feedback-toast fixed right-4 top-14 z-[115] flex w-[min(420px,calc(100vw-2rem))] items-start gap-3 rounded-md border border-amber-500/35 bg-amber-950/95 px-3 py-3 text-amber-50 shadow-[var(--app-shadow-popover)] backdrop-blur-md">
            <div className="flex min-w-0 items-center gap-2">
              <AlertTriangle className="size-4 shrink-0 text-amber-300" />
              <span className="text-sm leading-5">有 {todoCounts.notificationCount} 条系统告警待查看，请及时处理备份或云盘同步问题。</span>
            </div>
            <Link href="/todos" className="ml-auto shrink-0 rounded-md border border-amber-300/35 px-2 py-1 text-xs font-medium text-amber-50 transition-colors hover:bg-white/10">查看</Link>
          </div>
        )}

        <div className="flex flex-1">
          <aside
            className={cn(
              "sticky top-11 hidden h-[calc(100vh-44px)] shrink-0 flex-col overflow-hidden border-r border-border/90 bg-card/70 shadow-[6px_0_22px_rgba(0,0,0,0.08)] backdrop-blur-sm transition-[width,padding,border-color,box-shadow] duration-200 ease-out md:flex",
              desktopSidebarVisible ? "w-56 p-2.5" : "w-0 border-r-transparent p-0",
            )}
          >
            <div className="h-full w-[204px] shrink-0">
              <SidebarContent {...sidebarProps} />
            </div>
          </aside>

          {mobileOpen && (
            <div className="app-mobile-sidebar-overlay fixed inset-0 z-50 md:hidden">
              <div
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={() => setMobileOpen(false)}
              />
              <aside className="app-mobile-sidebar-panel absolute left-0 top-0 h-full w-60 border-r border-border bg-card p-3 shadow-[var(--app-shadow-dialog)]">
                <SidebarContent {...sidebarProps} />
              </aside>
            </div>
          )}

          <main className="app-page-enter min-w-0 flex-1 overflow-auto p-4 lg:p-6">{children}</main>
        </div>
        <ProjectAssistant
          currentProjectId={currentProjectId}
          currentProjectName={currentProject?.name}
        />
      </div>
    </TooltipProvider>
  );
};
