export type FlatRowPosition = "BEFORE" | "AFTER";

export const normalizeStructureCount = (value: unknown, maximum = 100) => {
  const count = Math.trunc(Number(value));
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(maximum, count));
};

export const placeRowsAroundAnchor = <T extends { id: string }>(
  currentRows: T[],
  rowsToPlace: T[],
  anchorId: string,
  position: FlatRowPosition,
) => {
  const movingIds = new Set(rowsToPlace.map((row) => row.id));
  if (movingIds.size !== rowsToPlace.length) throw new Error("结构操作包含重复行");
  if (movingIds.has(anchorId)) throw new Error("不能粘贴到被剪切的行自身");

  const remainingRows = currentRows.filter((row) => !movingIds.has(row.id));
  const anchorIndex = remainingRows.findIndex((row) => row.id === anchorId);
  if (anchorIndex < 0) throw new Error("目标行不存在");

  const insertIndex = position === "AFTER" ? anchorIndex + 1 : anchorIndex;
  return [
    ...remainingRows.slice(0, insertIndex),
    ...rowsToPlace,
    ...remainingRows.slice(insertIndex),
  ];
};
