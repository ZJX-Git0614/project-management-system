"use client";

/**
 * 当前项目 Context — V0.6.1
 *
 * 解决多组件各自调用 useCurrentProject() 导致状态不同步的问题。
 * AppShell 顶层实例化一次，整棵组件树通过 useCurrentProject() 共享。
 */
import { createContext, useContext, type FC, type ReactNode } from "react";
import { useCurrentProjectLogic, type CurrentProjectApi } from "@/lib/use-current-project-logic";

const CurrentProjectContext = createContext<CurrentProjectApi | null>(null);

export const CurrentProjectProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const value = useCurrentProjectLogic();
  return (
    <CurrentProjectContext.Provider value={value}>
      {children}
    </CurrentProjectContext.Provider>
  );
};

export const useCurrentProject = (): CurrentProjectApi => {
  const ctx = useContext(CurrentProjectContext);
  if (!ctx) {
    // 兜底：如果在 Provider 外使用（如开发调试），返回一个空实现
    // 生产代码不应走到这里
    return {
      allVisibleProjects: [],
      inProgressProjects: [],
      currentProjectId: null,
      currentProject: null,
      loading: true,
      hasProjectAdmin: false,
      setCurrentProject: () => {},
      clearCurrentProject: () => {},
      refresh: async () => {},
    };
  }
  return ctx;
};
