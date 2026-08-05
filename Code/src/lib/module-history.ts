export const PROJECT_MODULES = ["WEEKLY_ITEMS", "RISK_REGISTER", "PROJECT_BUDGET"] as const;

export type ProjectModule = (typeof PROJECT_MODULES)[number];

export interface ModuleHistoryEntry {
  id: string;
  label: string;
  beforeSnapshotId: string;
  afterSnapshotId: string;
  targetIds: string[];
}

export interface ModuleHistoryState {
  entries: ModuleHistoryEntry[];
  cursor: number;
}

export const MODULE_HISTORY_LIMIT = 50;

export const emptyModuleHistoryState = (): ModuleHistoryState => ({ entries: [], cursor: -1 });

export const pushModuleHistoryEntry = (
  state: ModuleHistoryState,
  entry: ModuleHistoryEntry,
): ModuleHistoryState => {
  const committed = [...state.entries.slice(0, state.cursor + 1), entry].slice(-MODULE_HISTORY_LIMIT);
  return { entries: committed, cursor: committed.length - 1 };
};

export const parseModuleHistoryState = (raw: string | null): ModuleHistoryState => {
  if (!raw) return emptyModuleHistoryState();
  try {
    const value = JSON.parse(raw) as Partial<ModuleHistoryState>;
    const entries = Array.isArray(value.entries)
      ? value.entries.filter((entry): entry is ModuleHistoryEntry => Boolean(
        entry
        && typeof entry === "object"
        && typeof (entry as ModuleHistoryEntry).id === "string"
        && typeof (entry as ModuleHistoryEntry).label === "string"
        && typeof (entry as ModuleHistoryEntry).beforeSnapshotId === "string"
        && typeof (entry as ModuleHistoryEntry).afterSnapshotId === "string"
        && Array.isArray((entry as ModuleHistoryEntry).targetIds),
      )).slice(-MODULE_HISTORY_LIMIT)
      : [];
    const requestedCursor = Number.isInteger(value.cursor) ? Number(value.cursor) : entries.length - 1;
    return { entries, cursor: Math.max(-1, Math.min(requestedCursor, entries.length - 1)) };
  } catch {
    return emptyModuleHistoryState();
  }
};

export const moduleHistoryStorageKey = (projectId: string, module: ProjectModule) => (
  `ceastar:module-history:v1:${projectId}:${module}`
);

export const moduleHistorySessionId = (): string => {
  const key = "ceastar:module-history-session:v1";
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;
  const created = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.sessionStorage.setItem(key, created);
  return created;
};
