export type RiskCodeSource = {
  id: string;
  riskCode: string;
  sortOrder?: number;
  createdAt: Date | string;
};

const RISK_CODE_PATTERN = /^Risk(\d+)$/;

const formatRiskCode = (value: number) => `Risk${String(value).padStart(3, "0")}`;

const parseRiskCode = (riskCode?: string | null) => {
  const match = riskCode?.match(RISK_CODE_PATTERN);
  return match ? Number(match[1]) : null;
};

const compareRiskPosition = (a: RiskCodeSource, b: RiskCodeSource) => {
  const sortCompare = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  const createdCompare = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  return sortCompare || createdCompare || a.id.localeCompare(b.id);
};

export const nextRiskCode = (items: RiskCodeSource[]) => {
  const maxCode = items.reduce((max, item) => {
    const value = parseRiskCode(item.riskCode);
    return value === null ? max : Math.max(max, value);
  }, 0);
  return formatRiskCode(maxCode + 1);
};

export const renumberRiskCodes = <T extends RiskCodeSource>(items: T[]) => {
  const codeById = new Map<string, string>();
  [...items].sort(compareRiskPosition).forEach((item, index) => {
    codeById.set(item.id, formatRiskCode(index + 1));
  });
  return items.map((item) => ({ ...item, riskCode: codeById.get(item.id)! }));
};
