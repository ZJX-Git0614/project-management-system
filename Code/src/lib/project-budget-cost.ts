export interface BudgetCostItemLike {
  kind: string;
  personMonths: number;
  monthlyCostPerPerson: number;
  unitPrice: number;
  sampleQuantity: number;
  productionQuantity: number;
  amount: number;
  currentRate: number;
}

export const projectBudgetItemPlannedCost = (
  item: BudgetCostItemLike,
  contractAmount: number,
) => {
  if (item.kind === "MANPOWER") return Math.max(0, item.personMonths) * Math.max(0, item.monthlyCostPerPerson);
  if (item.kind === "PURCHASE") return Math.max(0, item.unitPrice) * (Math.max(0, item.sampleQuantity) + Math.max(0, item.productionQuantity));
  if (item.kind === "RATE") return Math.max(0, contractAmount) * Math.max(0, item.currentRate) / 100;
  return Math.max(0, item.amount);
};

export const manpowerHourlyCost = (item: BudgetCostItemLike) => {
  if (item.kind !== "MANPOWER" || item.monthlyCostPerPerson <= 0) return 0;
  return item.monthlyCostPerPerson / (21.75 * 8);
};
