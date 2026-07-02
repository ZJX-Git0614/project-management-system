/**
 * 当前项目 hook 纯逻辑 — V0.6.1 入口改造。
 *
 * 职责：
 * 1. 维护 localStorage.rpms.currentProjectId
 * 2. 拉取 /api/projects（默认全部状态）
 * 3. 按权限分级：拥有「项目启动/作废/完成/恢复」任一权限 → 全部状态；否则仅 IN_PROGRESS
  * 4. 当前项目只来自项目列表点击写入的 localStorage，不自动默认选择
 * 5. 暴露 setCurrentProject / clearCurrentProject / inProgressProjects / allVisibleProjects
 *
 * 注意：
 * - /api/projects 默认返回所有状态，前端必须按可见范围自行 filter
 * - /api/projects 没有 updatedAt 字段（仅 createdAt），默认值排序用 createdAt desc
 *
 * 使用方式：不要直接 import 本文件。通过 `useCurrentProject()` from contexts/current-project-context
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import { usePermission } from "@/lib/use-permission";
import { api } from "@/lib/api-client";
import type { Project } from "@/domain/models";

const STORAGE_KEY = "pmms.currentProjectId";
const PROJECT_ADMIN_PERMISSIONS = [
  "project-list:start",
  "project-list:complete",
  "project-list:void",
  "project-list:restore",
] as const;

type RawProject = {
  id: string;
  name: string;
  status?: string;
  createdAt?: string;
  [key: string]: unknown;
};

export type CurrentProjectApi = {
  allVisibleProjects: Project[];
  inProgressProjects: Project[];
  currentProjectId: string | null;
  currentProject: Project | null;
  loading: boolean;
  hasProjectAdmin: boolean;
  setCurrentProject: (id: string) => void;
  clearCurrentProject: () => void;
  refresh: () => Promise<void>;
};

const toProject = (raw: RawProject): Project => raw as unknown as Project;

export const useCurrentProjectLogic = (): CurrentProjectApi => {
  const { user } = useAuth();
  const { canAny } = usePermission();
  const hasProjectAdmin = canAny([...PROJECT_ADMIN_PERMISSIONS]);

  const [rawProjects, setRawProjects] = useState<RawProject[]>([]);
  const [storedId, setStoredId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      return v && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(true);

  // 1. 拉取项目列表
  const refresh = useCallback(async () => {
    if (!user) {
      setRawProjects([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await api.get<RawProject[]>("/api/projects");
      setRawProjects(Array.isArray(data) ? data : []);
    } catch {
      setRawProjects([]);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  // 2. 派生：可见范围
  const allVisibleProjects = useMemo<Project[]>(() => {
    const list = rawProjects.map(toProject);
    if (hasProjectAdmin) return list;
    return list.filter((p) => (p.status ?? "") === "IN_PROGRESS");
  }, [rawProjects, hasProjectAdmin]);

  const inProgressProjects = useMemo<Project[]>(
    () => allVisibleProjects.filter((p) => (p.status ?? "") === "IN_PROGRESS"),
    [allVisibleProjects],
  );

  // 3. 派生：当前项目 id。项目列表是唯一入口，不自动替用户选择项目。
  const currentProjectId = useMemo<string | null>(() => {
    if (allVisibleProjects.length === 0) return null;
    if (storedId && allVisibleProjects.some((p) => p.id === storedId)) {
      return storedId;
    }
    return null;
  }, [allVisibleProjects, storedId]);

  // 注：自动清理"已删除项目的 localStorage"逻辑已移除
  // 原 effect（line 115-127）会与 setCurrentProject 产生 race condition（effect 读到的 currentProjectId 是
  // 上一次 state 快照，误判为 null 而清空）。改为：在 setCurrentProject 时主动校验项目是否在可见范围。

  const setCurrentProject = useCallback((id: string) => {
    if (typeof window === "undefined") return;
    // 仅在项目确实在可见范围内时写入（避免脏数据 + race condition）
    if (allVisibleProjects.length === 0) return;
    if (!allVisibleProjects.some((p) => p.id === id)) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
      setStoredId(id);
    } catch {
      // ignore
    }
  }, [allVisibleProjects]);

  const currentProject = useMemo<Project | null>(() => {
    if (!currentProjectId) return null;
    return allVisibleProjects.find((p) => p.id === currentProjectId) ?? null;
  }, [allVisibleProjects, currentProjectId]);

  const clearCurrentProject = useCallback(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      setStoredId(null);
    } catch {
      // ignore
    }
  }, []);

  return {
    allVisibleProjects,
    inProgressProjects,
    currentProjectId,
    currentProject,
    loading,
    hasProjectAdmin,
    setCurrentProject,
    clearCurrentProject,
    refresh,
  };
};
