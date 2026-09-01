import { ItemStatus } from "@/domain/enums";

export const ITEM_STATUS_VALUES = [
  ItemStatus.PENDING,
  ItemStatus.IN_PROGRESS,
  ItemStatus.DONE,
] as const;

export const isValidItemProgress = (progress: unknown): progress is number => (
  typeof progress === "number"
  && Number.isInteger(progress)
  && progress >= 0
  && progress <= 100
);

export const itemStatusFromProgress = (progress: number): ItemStatus => {
  if (progress >= 100) return ItemStatus.DONE;
  if (progress > 0) return ItemStatus.IN_PROGRESS;
  return ItemStatus.PENDING;
};

export const itemProgressInputValue = (progress: number): number | "" => (
  progress === 0 ? "" : progress
);

export const localDateValue = (date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const itemProgressFields = (
  progress: number,
  actualEndDate = "",
  completedOn = localDateValue(),
  previousProgress: number | null = null,
) => ({
  progress,
  status: itemStatusFromProgress(progress),
  actualEndDate: progress >= 100
    && (previousProgress === null || previousProgress < 100)
    && !actualEndDate
    ? completedOn
    : actualEndDate,
});
