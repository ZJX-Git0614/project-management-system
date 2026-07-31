export interface GanttHistoryFocusTarget {
  taskIds: string[];
  columnKey?: string;
  anchorTaskId?: string;
}

interface BaseGanttHistoryEntry {
  id: string;
  label: string;
  target: GanttHistoryFocusTarget;
}

export interface GanttSnapshotHistoryEntry extends BaseGanttHistoryEntry {
  kind: "SNAPSHOT";
  beforeSnapshotId: string;
  afterSnapshotId: string;
}

export interface GanttDeletionHistoryEntry extends BaseGanttHistoryEntry {
  kind: "DELETION";
  deletionBatchId: string;
}

export type GanttHistoryEntry = GanttSnapshotHistoryEntry | GanttDeletionHistoryEntry;

export interface GanttHistoryState {
  entries: GanttHistoryEntry[];
  cursor: number;
}

export const GANTT_HISTORY_LIMIT = 50;

export const emptyGanttHistoryState = (): GanttHistoryState => ({ entries: [], cursor: -1 });

export const pushGanttHistoryEntry = (
  state: GanttHistoryState,
  entry: GanttHistoryEntry,
): GanttHistoryState => {
  const committed = [...state.entries.slice(0, state.cursor + 1), entry].slice(-GANTT_HISTORY_LIMIT);
  return { entries: committed, cursor: committed.length - 1 };
};

export const parseGanttHistoryState = (raw: string | null): GanttHistoryState => {
  if (!raw) return emptyGanttHistoryState();
  try {
    const value = JSON.parse(raw) as Partial<GanttHistoryState>;
    const entries = Array.isArray(value.entries)
      ? value.entries.filter((entry): entry is GanttHistoryEntry => Boolean(
        entry
        && typeof entry === "object"
        && typeof (entry as GanttHistoryEntry).id === "string"
        && ((entry as GanttHistoryEntry).kind === "SNAPSHOT" || (entry as GanttHistoryEntry).kind === "DELETION"),
      )).slice(-GANTT_HISTORY_LIMIT)
      : [];
    const requestedCursor = Number.isInteger(value.cursor) ? Number(value.cursor) : entries.length - 1;
    return { entries, cursor: Math.max(-1, Math.min(requestedCursor, entries.length - 1)) };
  } catch {
    return emptyGanttHistoryState();
  }
};
