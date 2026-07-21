export type WeeklyMatterCodeSource = {
  id: string;
  matterCode: string;
  sortOrder?: number;
  createdAt: Date | string;
};

const MATTER_CODE_PREFIX = "Matter";
const MATTER_CODE_PATTERN = /^Matter(\d+)$/;

const formatMatterCode = (value: number) => (
  `${MATTER_CODE_PREFIX}${String(value).padStart(3, "0")}`
);

const parseMatterCode = (matterCode?: string | null) => {
  const match = matterCode?.match(MATTER_CODE_PATTERN);
  return match ? Number(match[1]) : null;
};

const byCreatedAtThenId = (a: WeeklyMatterCodeSource, b: WeeklyMatterCodeSource) => {
  const createdAtCompare = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  return createdAtCompare || a.id.localeCompare(b.id);
};

const bySortOrderThenCreatedAt = (a: WeeklyMatterCodeSource, b: WeeklyMatterCodeSource) => {
  const sortCompare = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  return sortCompare || byCreatedAtThenId(a, b);
};

export const nextWeeklyMatterCode = (items: WeeklyMatterCodeSource[]) => {
  const maxCode = items.reduce((max, item) => {
    const value = parseMatterCode(item.matterCode);
    return value === null ? max : Math.max(max, value);
  }, 0);
  return formatMatterCode(maxCode + 1);
};

export const assignMissingWeeklyMatterCodes = <T extends WeeklyMatterCodeSource>(items: T[]) => {
  const usedCodes = new Set(
    items
      .map((item) => item.matterCode)
      .filter((matterCode) => parseMatterCode(matterCode) !== null)
  );
  let nextValue = 1;
  const nextUnusedCode = () => {
    while (usedCodes.has(formatMatterCode(nextValue))) nextValue += 1;
    const code = formatMatterCode(nextValue);
    usedCodes.add(code);
    nextValue += 1;
    return code;
  };

  const codeById = new Map<string, string>();
  [...items].sort(byCreatedAtThenId).forEach((item) => {
    if (parseMatterCode(item.matterCode) === null) {
      codeById.set(item.id, nextUnusedCode());
    }
  });

  return items.map((item) => (
    codeById.has(item.id) ? { ...item, matterCode: codeById.get(item.id)! } : item
  ));
};

export const renumberWeeklyMatterCodes = <T extends WeeklyMatterCodeSource>(items: T[]) => {
  const codeById = new Map<string, string>();
  [...items].sort(bySortOrderThenCreatedAt).forEach((item, index) => {
    codeById.set(item.id, formatMatterCode(index + 1));
  });

  return items.map((item) => ({ ...item, matterCode: codeById.get(item.id)! }));
};
