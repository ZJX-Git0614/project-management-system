"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@/lib/api-client";
import {
  emptyModuleHistoryState,
  moduleHistorySessionId,
  moduleHistoryStorageKey,
  parseModuleHistoryState,
  pushModuleHistoryEntry,
  type ModuleHistoryEntry,
  type ModuleHistoryState,
  type ProjectModule,
} from "@/lib/module-history";

interface ModuleSnapshotResult {
  snapshotId: string;
  createdAt: string;
}

interface ModuleRestoreResult {
  message: string;
  restoredCount: number;
  warnings?: string[];
}

interface UseModuleHistoryOptions {
  projectId: string;
  module: ProjectModule;
  enabled: boolean;
  onRestored: (targetIds: string[]) => void | Promise<void>;
  onError: (title: string, message: string) => void;
  onWarning?: (message: string) => void;
}

export const useModuleHistory = ({
  projectId,
  module,
  enabled,
  onRestored,
  onError,
  onWarning,
}: UseModuleHistoryOptions) => {
  const [historyScope, setHistoryScope] = useState("");
  const [history, setHistory] = useState<ModuleHistoryState>(() => emptyModuleHistoryState());
  const [historyBusy, setHistoryBusy] = useState(false);
  const scope = `${projectId}:${module}`;

  useEffect(() => {
    if (typeof window === "undefined" || !projectId) return;
    setHistory(parseModuleHistoryState(window.sessionStorage.getItem(moduleHistoryStorageKey(projectId, module))));
    setHistoryScope(scope);
  }, [module, projectId, scope]);

  useEffect(() => {
    if (typeof window === "undefined" || !projectId || historyScope !== scope) return;
    window.sessionStorage.setItem(moduleHistoryStorageKey(projectId, module), JSON.stringify(history));
  }, [history, historyScope, module, projectId, scope]);

  const currentHistory = historyScope === scope ? history : emptyModuleHistoryState();
  const undoEntry = currentHistory.entries[currentHistory.cursor];
  const redoEntry = currentHistory.entries[currentHistory.cursor + 1];

  const captureSnapshot = useCallback((label: string) => api.post<ModuleSnapshotResult>(
    `/api/projects/${projectId}/module-history/snapshots`,
    { module, sessionId: moduleHistorySessionId(), label },
  ), [module, projectId]);

  const runWithHistory = useCallback(async <T,>(
    label: string,
    targetIds: string[],
    action: () => Promise<T>,
  ): Promise<T> => {
    if (!enabled) return action();
    const before = await captureSnapshot(`${label}:before`);
    const result = await action();
    try {
      const after = await captureSnapshot(`${label}:after`);
      const entry: ModuleHistoryEntry = {
        id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        label,
        beforeSnapshotId: before.snapshotId,
        afterSnapshotId: after.snapshotId,
        targetIds,
      };
      setHistory((state) => pushModuleHistoryEntry(
        historyScope === scope ? state : emptyModuleHistoryState(),
        entry,
      ));
      setHistoryScope(scope);
    } catch (error) {
      onError("操作已完成，但无法撤销", error instanceof Error ? error.message : "保存操作历史失败");
    }
    return result;
  }, [captureSnapshot, enabled, historyScope, onError, scope]);

  const restoreEntry = useCallback(async (entry: ModuleHistoryEntry, direction: "UNDO" | "REDO") => {
    const result = await api.post<ModuleRestoreResult>(`/api/projects/${projectId}/module-history/restore`, {
      module,
      snapshotId: direction === "UNDO" ? entry.beforeSnapshotId : entry.afterSnapshotId,
      actionLabel: `${direction === "UNDO" ? "撤销" : "重做"}：${entry.label}`,
    });
    await onRestored(entry.targetIds);
    if (result.warnings?.length) onWarning?.(result.warnings.join("\n"));
  }, [module, onRestored, onWarning, projectId]);

  const undo = useCallback(async () => {
    if (!undoEntry || historyBusy || !enabled) return;
    setHistoryBusy(true);
    try {
      await restoreEntry(undoEntry, "UNDO");
      setHistory((state) => ({ ...state, cursor: Math.max(-1, state.cursor - 1) }));
    } catch (error) {
      onError("撤销失败", error instanceof Error ? error.message : "撤销操作失败");
    } finally {
      setHistoryBusy(false);
    }
  }, [enabled, historyBusy, onError, restoreEntry, undoEntry]);

  const redo = useCallback(async () => {
    if (!redoEntry || historyBusy || !enabled) return;
    setHistoryBusy(true);
    try {
      await restoreEntry(redoEntry, "REDO");
      setHistory((state) => ({ ...state, cursor: Math.min(state.entries.length - 1, state.cursor + 1) }));
    } catch (error) {
      onError("重做失败", error instanceof Error ? error.message : "重做操作失败");
    } finally {
      setHistoryBusy(false);
    }
  }, [enabled, historyBusy, onError, redoEntry, restoreEntry]);

  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        void undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        void redo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, redo, undo]);

  return useMemo(() => ({
    undo,
    redo,
    runWithHistory,
    undoEntry,
    redoEntry,
    historyBusy,
  }), [historyBusy, redo, redoEntry, runWithHistory, undo, undoEntry]);
};
