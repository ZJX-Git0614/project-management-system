import * as XLSX from "@e965/xlsx";

export type AssistantBudgetExportItem = {
  id: string;
  title: string;
  groupName: string;
  person: string;
  personMonths: number;
  monthlyCostPerPerson: number;
  unitPrice: number;
  sampleQuantity: number;
  productionQuantity: number;
  amount: number;
  minRate: number;
  maxRate: number;
  currentRate: number;
  remark: string;
  sortOrder: number;
};

export type AssistantBudgetExportCategory = {
  id: string;
  name: string;
  kind: string;
  description: string;
  sortOrder: number;
  items: AssistantBudgetExportItem[];
};

export type AssistantBudgetWorkbookInput = {
  projectCode: string;
  projectName: string;
  contractAmount: number;
  profitTargetRate: number;
  categories: AssistantBudgetExportCategory[];
  generatedAt?: Date;
};

export type AssistantWeeklyWorkbookRow = {
  matterCode: string;
  title: string;
  description: string;
  taskName: string;
  owner: string;
  priority: string;
  status: string;
  plannedStartDate: string;
  plannedEndDate: string;
  actualStartDate: string;
  actualEndDate: string;
  progress: number;
  health: string;
  issueAndAction: string;
  dependency: string;
  risk: string;
  riskStatus: string;
  remark: string;
};

export type AssistantRiskWorkbookRow = {
  riskCode: string;
  riskName: string;
  linkedItemName: string;
  category: string;
  trigger: string;
  probability: string;
  impact: string;
  level: string;
  response: string;
  owner: string;
  status: string;
  targetDate: string;
};

export type AssistantScheduleIssue = {
  ruleId?: string;
  severity?: string;
  taskCodes?: string[];
  message?: string;
  facts?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  impactTaskIds?: string[];
  suggestion?: string;
};

export type AssistantScheduleChange = {
  taskCode?: string;
  taskName?: string;
  field?: string;
  before?: unknown;
  after?: unknown;
};

type ProjectWorkbookIdentity = {
  projectCode: string;
  projectName: string;
  generatedAt?: Date;
};

const KIND_LABEL: Record<string, string> = {
  MANPOWER: "人力型",
  PURCHASE: "采购型",
  OTHER: "差旅型",
  RATE: "费率型",
};

const BUDGET_KIND_ORDER = ["MANPOWER", "PURCHASE", "OTHER", "RATE"] as const;
const BUDGET_KIND_SHEET: Record<(typeof BUDGET_KIND_ORDER)[number], string> = {
  MANPOWER: "人力预算",
  PURCHASE: "采购预算",
  OTHER: "差旅预算",
  RATE: "费率预算",
};

const finite = (value: number) => Number.isFinite(value) ? value : 0;

const itemAmount = (kind: string, item: AssistantBudgetExportItem, contractAmount: number) => {
  if (kind === "MANPOWER") return finite(item.personMonths) * finite(item.monthlyCostPerPerson);
  if (kind === "PURCHASE") return finite(item.unitPrice) * (finite(item.sampleQuantity) + finite(item.productionQuantity));
  if (kind === "OTHER") return finite(item.amount);
  if (kind === "RATE") return finite(contractAmount) * (finite(item.currentRate) / 100);
  return finite(item.amount);
};

const bar = (ratio: number, width = 24) => "█".repeat(Math.round(Math.max(0, Math.min(1, ratio)) * width));

const generatedAtLabel = (generatedAt?: Date) => (generatedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 19);
const projectLabel = (input: ProjectWorkbookIdentity) => `${input.projectCode || input.projectName} ${input.projectName}`.trim();

const buildWorkbookStylesXml = () => [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  '<fonts count="5">',
  '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>',
  '<font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/><family val="2"/></font>',
  '<font><b/><sz val="10"/><color rgb="FF17365D"/><name val="Microsoft YaHei"/><family val="2"/></font>',
  '<font><sz val="10"/><color rgb="FF26384A"/><name val="Microsoft YaHei"/><family val="2"/></font>',
  '<font><b/><sz val="10"/><color rgb="FF1F6E43"/><name val="Microsoft YaHei"/><family val="2"/></font>',
  '</fonts>',
  '<fills count="7">',
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F7FA"/><bgColor indexed="64"/></patternFill></fill>',
  '<fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill>',
  '</fills>',
  '<borders count="2">',
  '<border><left/><right/><top/><bottom/><diagonal/></border>',
  '<border><left style="thin"><color rgb="FFD5DFE8"/></left><right style="thin"><color rgb="FFD5DFE8"/></right><top style="thin"><color rgb="FFD5DFE8"/></top><bottom style="thin"><color rgb="FFD5DFE8"/></bottom><diagonal/></border>',
  '</borders>',
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
  '<cellXfs count="12">',
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>',
  '<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>',
  '<xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>',
  '<xf numFmtId="0" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>',
  '<xf numFmtId="4" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>',
  '<xf numFmtId="4" fontId="3" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>',
  '<xf numFmtId="10" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>',
  '<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>',
  '<xf numFmtId="4" fontId="4" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>',
  '</cellXfs>',
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
  '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>',
  '</styleSheet>',
].join("");

type SheetStyle = {
  headerRow: number;
  totalRow?: number;
  currencyColumns: Set<string>;
  percentColumns: Set<string>;
  labelRows?: Set<number>;
};

type WorkbookSheet = {
  name: string;
  sheet: XLSX.WorkSheet;
  style: SheetStyle;
};

const styleSheetXml = (xml: string, spec: SheetStyle) => {
  let styled = xml.replace(/<c r="([A-Z]+)(\d+)"([^>]*)>/g, (match, column: string, rowText: string, attributes: string) => {
    const row = Number(rowText);
    const isAlternate = row > spec.headerRow && (row - spec.headerRow) % 2 === 0;
    let styleId = isAlternate ? 6 : 5;
    if (row === 1) styleId = 1;
    else if (row === spec.headerRow) styleId = 4;
    else if (row === spec.totalRow) styleId = 11;
    else if (spec.labelRows?.has(row)) styleId = column === "A" ? 2 : 3;
    else if (spec.currencyColumns.has(column)) styleId = isAlternate ? 8 : 7;
    else if (spec.percentColumns.has(column)) styleId = 9;
    const cleanAttributes = attributes.replace(/\s+s="[^"]*"/g, "");
    return `<c r="${column}${row}"${cleanAttributes} s="${styleId}">`;
  });
  styled = styled.replace(
    /<sheetViews><sheetView workbookViewId="0"\/><\/sheetViews>/,
    `<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="${spec.headerRow}" topLeftCell="A${spec.headerRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${spec.headerRow + 1}" sqref="A${spec.headerRow + 1}"/></sheetView></sheetViews>`,
  );
  return styled;
};

const applyWorkbookStyle = (buffer: Buffer, specs: SheetStyle[]) => {
  const archive = XLSX.CFB.read(buffer, { type: "buffer" });
  const stylesFile = XLSX.CFB.find(archive, "Root Entry/xl/styles.xml");
  if (!stylesFile?.content) throw new Error("无法写入 Excel 样式");
  stylesFile.content = Buffer.from(buildWorkbookStylesXml(), "utf8");
  specs.forEach((spec, index) => {
    const worksheetFile = XLSX.CFB.find(archive, `Root Entry/xl/worksheets/sheet${index + 1}.xml`);
    if (!worksheetFile?.content) throw new Error(`无法写入 Excel 工作表 ${index + 1} 样式`);
    worksheetFile.content = Buffer.from(
      styleSheetXml(Buffer.from(worksheetFile.content).toString("utf8"), spec),
      "utf8",
    );
  });
  return Buffer.from(XLSX.CFB.write(archive, { type: "buffer", fileType: "zip", compression: true }));
};

const writeStyledWorkbook = (sheets: WorkbookSheet[]) => {
  const workbook = XLSX.utils.book_new();
  sheets.forEach(({ name, sheet }) => XLSX.utils.book_append_sheet(workbook, sheet, name));
  const raw = Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  return applyWorkbookStyle(raw, sheets.map(({ style }) => style));
};

const buildTableSheet = (input: {
  name: string;
  title: string;
  project: string;
  generatedAt: string;
  headers: string[];
  rows: unknown[][];
  widths: number[];
  currencyColumns?: string[];
  percentColumns?: string[];
  totalRow?: unknown[];
}): WorkbookSheet => {
  const headerRow = 4;
  const rows: unknown[][] = [
    [input.title],
    ["项目", input.project, "生成时间", input.generatedAt],
    [],
    input.headers,
    ...input.rows,
    ...(input.totalRow ? [input.totalRow] : []),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const lastColumn = XLSX.utils.encode_col(Math.max(0, input.headers.length - 1));
  sheet["!merges"] = [XLSX.utils.decode_range(`A1:${lastColumn}1`)];
  sheet["!cols"] = input.widths.map((wch) => ({ wch }));
  sheet["!rows"] = rows.map((_row, index) => ({ hpt: index === 0 ? 32 : index === headerRow - 1 ? 30 : 23 }));
  sheet["!autofilter"] = { ref: `A${headerRow}:${lastColumn}${Math.max(headerRow, rows.length - (input.totalRow ? 1 : 0))}` };
  return {
    name: input.name,
    sheet,
    style: {
      headerRow,
      totalRow: input.totalRow ? rows.length : undefined,
      currencyColumns: new Set(input.currencyColumns ?? []),
      percentColumns: new Set(input.percentColumns ?? []),
      labelRows: new Set([2]),
    },
  };
};

const knownBudgetKind = (kind: string): kind is (typeof BUDGET_KIND_ORDER)[number] => (
  BUDGET_KIND_ORDER.includes(kind as (typeof BUDGET_KIND_ORDER)[number])
);

export const getAssistantBudgetWorkbookSheetNames = (categories: ReadonlyArray<{ kind: string }>) => {
  const kinds = new Set(categories.map((category) => category.kind));
  const names = BUDGET_KIND_ORDER.filter((kind) => kinds.has(kind)).map((kind) => BUDGET_KIND_SHEET[kind]);
  if (Array.from(kinds).some((kind) => !knownBudgetKind(kind))) names.push("其他预算");
  return [...names, "预算汇总", "数据可视化"];
};

type BudgetDetailEntry = {
  category: AssistantBudgetExportCategory;
  item: AssistantBudgetExportItem;
  amount: number;
};

const buildBudgetDimensionSheet = (
  kind: string,
  entries: BudgetDetailEntry[],
  project: string,
  generatedAt: string,
): WorkbookSheet => {
  const total = entries.reduce((sum, entry) => sum + entry.amount, 0);
  if (kind === "MANPOWER") {
    return buildTableSheet({
      name: "人力预算",
      title: "人力预算明细",
      project,
      generatedAt,
      headers: ["序号", "预算分类", "预算项", "组别", "人员", "人月", "月成本/人", "条目金额", "分类说明", "备注"],
      rows: entries.map(({ category, item, amount }, index) => [index + 1, category.name, item.title, item.groupName, item.person, item.personMonths, item.monthlyCostPerPerson, amount, category.description, item.remark]),
      totalRow: ["合计", "", "", "", "", "", "", total],
      widths: [8, 22, 28, 16, 14, 10, 15, 16, 28, 28],
      currencyColumns: ["G", "H"],
    });
  }
  if (kind === "PURCHASE") {
    return buildTableSheet({
      name: "采购预算",
      title: "采购预算明细",
      project,
      generatedAt,
      headers: ["序号", "预算分类", "预算项", "单价", "样机数量", "量产数量", "采购数量合计", "条目金额", "分类说明", "备注"],
      rows: entries.map(({ category, item, amount }, index) => [index + 1, category.name, item.title, item.unitPrice, item.sampleQuantity, item.productionQuantity, finite(item.sampleQuantity) + finite(item.productionQuantity), amount, category.description, item.remark]),
      totalRow: ["合计", "", "", "", "", "", "", total],
      widths: [8, 22, 28, 14, 12, 12, 16, 16, 28, 28],
      currencyColumns: ["D", "H"],
    });
  }
  if (kind === "OTHER") {
    return buildTableSheet({
      name: "差旅预算",
      title: "差旅预算明细",
      project,
      generatedAt,
      headers: ["序号", "预算分类", "预算项", "条目金额", "分类说明", "备注"],
      rows: entries.map(({ category, item, amount }, index) => [index + 1, category.name, item.title, amount, category.description, item.remark]),
      totalRow: ["合计", "", "", total],
      widths: [8, 22, 30, 16, 30, 30],
      currencyColumns: ["D"],
    });
  }
  if (kind === "RATE") {
    return buildTableSheet({
      name: "费率预算",
      title: "费率预算明细",
      project,
      generatedAt,
      headers: ["序号", "预算分类", "预算项", "建议下限(%)", "当前费率(%)", "建议上限(%)", "条目金额", "分类说明", "备注"],
      rows: entries.map(({ category, item, amount }, index) => [index + 1, category.name, item.title, finite(item.minRate) / 100, finite(item.currentRate) / 100, finite(item.maxRate) / 100, amount, category.description, item.remark]),
      totalRow: ["合计", "", "", "", "", "", total],
      widths: [8, 22, 28, 16, 16, 16, 16, 28, 28],
      currencyColumns: ["G"],
      percentColumns: ["D", "E", "F"],
    });
  }
  return buildTableSheet({
    name: "其他预算",
    title: "其他预算明细",
    project,
    generatedAt,
    headers: ["序号", "预算分类", "分类类型", "预算项", "条目金额", "分类说明", "备注"],
    rows: entries.map(({ category, item, amount }, index) => [index + 1, category.name, KIND_LABEL[category.kind] || category.kind, item.title, amount, category.description, item.remark]),
    totalRow: ["合计", "", "", "", total],
    widths: [8, 22, 16, 30, 16, 30, 30],
    currencyColumns: ["E"],
  });
};

export const buildAssistantBudgetWorkbook = (input: AssistantBudgetWorkbookInput) => {
  const categories = [...input.categories]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "zh-CN"))
    .map((category) => ({
      ...category,
      items: [...category.items].sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, "zh-CN")),
    }));
  const details = categories.flatMap((category) => category.items.map((item) => ({
    category,
    item,
    amount: itemAmount(category.kind, item, input.contractAmount),
  })));
  const categorySummary = categories.map((category) => ({
    category,
    total: category.items.reduce((sum, item) => sum + itemAmount(category.kind, item, input.contractAmount), 0),
  }));
  const totalBudget = categorySummary.reduce((sum, item) => sum + item.total, 0);
  const remaining = finite(input.contractAmount) - totalBudget;
  const generatedAt = generatedAtLabel(input.generatedAt);
  const project = projectLabel(input);
  const dimensionKinds = [
    ...BUDGET_KIND_ORDER.filter((kind) => categories.some((category) => category.kind === kind)),
    ...(categories.some((category) => !knownBudgetKind(category.kind)) ? ["UNKNOWN"] : []),
  ];
  const dimensionSheets = dimensionKinds.map((kind) => buildBudgetDimensionSheet(
    kind,
    details.filter(({ category }) => kind === "UNKNOWN" ? !knownBudgetKind(category.kind) : category.kind === kind),
    project,
    generatedAt,
  ));

  const summaryHeaderRow = 10;
  const summaryRows: unknown[][] = [
    ["项目预算汇总", "", "", "", "", ""],
    ["项目", project],
    ["生成时间", generatedAt],
    ["合同金额", finite(input.contractAmount)],
    ["预算合计", totalBudget],
    ["预算后余额", remaining],
    ["预算占合同比例", input.contractAmount > 0 ? totalBudget / input.contractAmount : 0],
    ["目标利润率", finite(input.profitTargetRate) / 100],
    [],
    ["预算分类", "分类类型", "条目数", "分类小计", "占预算比例", "占合同比例"],
    ...categorySummary.map(({ category, total }) => [
      category.name,
      KIND_LABEL[category.kind] || category.kind,
      category.items.length,
      total,
      totalBudget > 0 ? total / totalBudget : 0,
      input.contractAmount > 0 ? total / input.contractAmount : 0,
    ]),
    ["合计", "", details.length, totalBudget, totalBudget > 0 ? 1 : 0, input.contractAmount > 0 ? totalBudget / input.contractAmount : 0],
  ];
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet["!merges"] = [XLSX.utils.decode_range("A1:F1")];
  summarySheet["!cols"] = [{ wch: 28 }, { wch: 18 }, { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 16 }];
  summarySheet["!rows"] = summaryRows.map((_row, index) => ({ hpt: index === 0 ? 32 : index === summaryHeaderRow - 1 ? 30 : 23 }));
  summarySheet["!autofilter"] = { ref: `A${summaryHeaderRow}:F${Math.max(summaryHeaderRow, summaryRows.length - 1)}` };

  const maxCategoryTotal = Math.max(1, ...categorySummary.map((item) => item.total));
  const typeSummary = Array.from(categorySummary.reduce((map, item) => {
    const label = KIND_LABEL[item.category.kind] || item.category.kind;
    map.set(label, (map.get(label) ?? 0) + item.total);
    return map;
  }, new Map<string, number>()));
  const visualizationRows: unknown[][] = [
    ["项目预算数据可视化", "", "", "", ""],
    ["项目", project, "预算合计", totalBudget, "合同金额", finite(input.contractAmount)],
    ["预算分类", "分类金额", "占预算比例", "金额对比", "预算占比"],
    ...categorySummary.map(({ category, total }) => [
      category.name,
      total,
      totalBudget > 0 ? total / totalBudget : 0,
      bar(total / maxCategoryTotal),
      bar(totalBudget > 0 ? total / totalBudget : 0),
    ]),
    [],
    ["预算类型", "类型金额", "占预算比例", "金额对比", "预算占比"],
    ...typeSummary.map(([label, total]) => [
      label,
      total,
      totalBudget > 0 ? total / totalBudget : 0,
      bar(total / Math.max(1, ...typeSummary.map((item) => item[1]))),
      bar(totalBudget > 0 ? total / totalBudget : 0),
    ]),
  ];
  const visualizationSheet = XLSX.utils.aoa_to_sheet(visualizationRows);
  visualizationSheet["!merges"] = [XLSX.utils.decode_range("A1:F1")];
  visualizationSheet["!cols"] = [{ wch: 30 }, { wch: 18 }, { wch: 16 }, { wch: 30 }, { wch: 30 }, { wch: 18 }];
  visualizationSheet["!rows"] = visualizationRows.map((_row, index) => ({ hpt: index === 0 ? 32 : index === 2 ? 30 : 23 }));

  return writeStyledWorkbook([
    ...dimensionSheets,
    {
      name: "预算汇总",
      sheet: summarySheet,
      style: { headerRow: summaryHeaderRow, totalRow: summaryRows.length, currencyColumns: new Set(["B", "D"]), percentColumns: new Set(["B", "E", "F"]), labelRows: new Set([2, 3, 4, 5, 6, 7, 8]) },
    },
    {
      name: "数据可视化",
      sheet: visualizationSheet,
      style: { headerRow: 3, currencyColumns: new Set(["B", "D", "F"]), percentColumns: new Set(["C"]), labelRows: new Set([2]) },
    },
  ]);
};

export const buildAssistantWeeklyWorkbook = (
  input: ProjectWorkbookIdentity & { rows: AssistantWeeklyWorkbookRow[] },
) => writeStyledWorkbook([buildTableSheet({
  name: "项目事项",
  title: "项目事项清单",
  project: projectLabel(input),
  generatedAt: generatedAtLabel(input.generatedAt),
  headers: ["事项ID", "事项名称", "详细事件内容", "关联任务", "责任人", "优先级", "状态", "计划开始", "计划结束", "实际开始", "实际结束", "进度", "健康", "当前问题/措施", "依赖条件", "风险", "风险状态", "备注"],
  rows: input.rows.map((item) => [item.matterCode, item.title, item.description, item.taskName, item.owner, item.priority, item.status, item.plannedStartDate, item.plannedEndDate, item.actualStartDate, item.actualEndDate, item.progress / 100, item.health, item.issueAndAction, item.dependency, item.risk, item.riskStatus, item.remark]),
  widths: [14, 30, 42, 26, 18, 12, 12, 14, 14, 14, 14, 12, 12, 36, 36, 30, 14, 30],
  percentColumns: ["L"],
})]);

export const buildAssistantRiskWorkbook = (
  input: ProjectWorkbookIdentity & { rows: AssistantRiskWorkbookRow[] },
) => writeStyledWorkbook([buildTableSheet({
  name: "风险登记册",
  title: "项目风险登记册",
  project: projectLabel(input),
  generatedAt: generatedAtLabel(input.generatedAt),
  headers: ["风险ID", "风险名称", "关联事项", "类别", "触发条件", "概率", "影响", "等级", "应对措施", "责任人", "状态", "目标日期"],
  rows: input.rows.map((item) => [item.riskCode, item.riskName, item.linkedItemName, item.category, item.trigger, item.probability, item.impact, item.level, item.response, item.owner, item.status, item.targetDate]),
  widths: [14, 30, 28, 18, 36, 12, 12, 12, 42, 18, 14, 14],
})]);

const exportCellValue = (value: unknown) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
};

export const buildAssistantScheduleAnalysisWorkbook = (
  input: ProjectWorkbookIdentity & { issues: AssistantScheduleIssue[]; changes: AssistantScheduleChange[] },
) => {
  const project = projectLabel(input);
  const generatedAt = generatedAtLabel(input.generatedAt);
  return writeStyledWorkbook([
    buildTableSheet({
      name: "分析汇总",
      title: "计划差异与冲突分析汇总",
      project,
      generatedAt,
      headers: ["分析维度", "记录数"],
      rows: [["冲突与风险", input.issues.length], ["字段变化", input.changes.length], ["合计", input.issues.length + input.changes.length]],
      widths: [28, 16],
    }),
    buildTableSheet({
      name: "冲突与风险",
      title: "计划冲突与风险",
      project,
      generatedAt,
      headers: ["序号", "规则ID", "级别", "任务ID", "说明", "事实", "期望", "影响任务", "建议"],
      rows: input.issues.map((item, index) => [index + 1, item.ruleId, item.severity, item.taskCodes?.join(" / "), item.message, exportCellValue(item.facts), exportCellValue(item.expected), item.impactTaskIds?.join(" / "), item.suggestion]),
      widths: [8, 18, 12, 24, 42, 38, 38, 28, 42],
    }),
    buildTableSheet({
      name: "字段变化",
      title: "计划字段变化",
      project,
      generatedAt,
      headers: ["序号", "任务ID", "任务名称", "字段", "原值", "新值"],
      rows: input.changes.map((item, index) => [index + 1, item.taskCode, item.taskName, item.field, exportCellValue(item.before), exportCellValue(item.after)]),
      widths: [8, 16, 30, 20, 38, 38],
    }),
  ]);
};
