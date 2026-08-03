import type { AssistantMessageInput } from "@/lib/project-assistant";

export type AssistantRiskLevel = "高" | "中" | "低";
export type AssistantRiskStatus = "识别中" | "跟踪中" | "处理中" | "已关闭";

export type AssistantRiskDraft = {
  riskName: string;
  category: string;
  trigger: string;
  probability: AssistantRiskLevel;
  impact: AssistantRiskLevel;
  level: AssistantRiskLevel;
  response: string;
  owner: string;
  status: AssistantRiskStatus;
  targetDate: string;
};

type ParsedRiskDraft = AssistantRiskDraft & {
  impactDescription: string;
};

type MarkdownTable = {
  heading: string;
  headers: string[];
  rows: string[][];
};

const CONTEXT_REFERENCE_PATTERN = /(以上|上述|这些|前述|前面|刚才|上面|本次|该(?:分析|结论|清单)|分析(?:结果|结论|出的)?|整理(?:的|出的)?|推荐(?:的)?|建议(?:的)?)/u;
const RISK_WRITE_PATTERN = /(写入|录入|登记|保存|添加|新增|创建|导入|同步)/u;
const RISK_TARGET_PATTERN = /(风险(?:登记册|清单)?|风险登记|登记册)/u;

const textValue = (value: unknown, maxLength = 2000) => String(value ?? "")
  .replace(/<br\s*\/?>/giu, "\n")
  .replace(/&nbsp;/giu, " ")
  .replace(/\*\*|__|`/g, "")
  .replace(/\r/g, "")
  .trim()
  .slice(0, maxLength);

const normalizeHeader = (value: string) => textValue(value, 100)
  .replace(/[\s:：/（）()【】\[\]]/g, "")
  .toLocaleLowerCase("zh-CN");

const normalizeLevel = (value: unknown, fallback: AssistantRiskLevel = "中"): AssistantRiskLevel => {
  const normalized = textValue(value, 20);
  if (/(高|重大|严重)/u.test(normalized)) return "高";
  if (/(低|轻微)/u.test(normalized)) return "低";
  if (/(中|一般|普通)/u.test(normalized)) return "中";
  return fallback;
};

const normalizeStatus = (value: unknown): AssistantRiskStatus => {
  const normalized = textValue(value, 30);
  if (/(关闭|完成|解除|已解决)/u.test(normalized)) return "已关闭";
  if (/(处理|应对|整改)/u.test(normalized)) return "处理中";
  if (/(跟踪|监控|观察)/u.test(normalized)) return "跟踪中";
  return "识别中";
};

const deriveRiskCategory = (riskName: string) => {
  if (/(成本|预算|费用|利润)/u.test(riskName)) return "成本";
  if (/(采购|供应|物料|交付商)/u.test(riskName)) return "采购";
  if (/(质量|缺陷|可靠性)/u.test(riskName)) return "质量";
  if (/(合同|合规|法律|审批)/u.test(riskName)) return "合规";
  if (/(进度|延期|计划|排期|浮时|工期|交付|验收|测试窗口)/u.test(riskName)) return "进度";
  if (/(技术|软件|系统|接口|开发|集成)/u.test(riskName)) return "技术";
  if (/(人员|资源|组织|责任)/u.test(riskName)) return "资源";
  return "综合";
};

const normalizeDate = (value: unknown) => {
  const normalized = textValue(value, 20);
  const match = normalized.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/u);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
};

const splitMarkdownRow = (line: string) => {
  const normalized = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return normalized.split("|").map((cell) => textValue(cell));
};

const isMarkdownSeparator = (line: string) => {
  if (!line.includes("|")) return false;
  const cells = splitMarkdownRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell.replace(/\s/g, "")));
};

const nearestHeading = (lines: string[], index: number) => {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const heading = lines[cursor].match(/^\s*#{1,6}\s+(.+)$/u)?.[1];
    if (heading) return textValue(heading, 200);
  }
  return "";
};

const extractMarkdownTables = (content: string): MarkdownTable[] => {
  const lines = content.split(/\r?\n/u);
  const tables: MarkdownTable[] = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].includes("|") || !isMarkdownSeparator(lines[index + 1])) continue;
    const headers = splitMarkdownRow(lines[index]);
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].includes("|")) {
      const row = splitMarkdownRow(lines[cursor]);
      if (row.some(Boolean)) rows.push(row);
      cursor += 1;
    }
    tables.push({ heading: nearestHeading(lines, index), headers, rows });
    index = cursor - 1;
  }
  return tables;
};

const headerIndex = (headers: string[], aliases: readonly string[]) => {
  const normalizedHeaders = headers.map(normalizeHeader);
  const normalizedAliases = aliases.map(normalizeHeader);
  for (const alias of normalizedAliases) {
    const exact = normalizedHeaders.findIndex((header) => header === alias);
    if (exact >= 0) return exact;
  }
  for (const alias of normalizedAliases.filter((value) => value.length > 2)) {
    const partial = normalizedHeaders.findIndex((header) => header.includes(alias) || alias.includes(header));
    if (partial >= 0) return partial;
  }
  return -1;
};

const tableColumnIndexes = (headers: string[]) => ({
  name: headerIndex(headers, ["建议风险名称", "潜在风险", "风险名称", "风险"]),
  category: headerIndex(headers, ["风险类别", "类别"]),
  trigger: headerIndex(headers, ["触发条件", "主要依据", "识别依据", "依据"]),
  probability: headerIndex(headers, ["发生概率", "概率"]),
  impactLevel: headerIndex(headers, ["影响等级", "影响程度"]),
  impactDescription: headerIndex(headers, ["可能影响", "影响说明", "后果"]),
  level: headerIndex(headers, ["风险等级建议", "建议等级", "风险等级", "等级"]),
  response: headerIndex(headers, ["建议应对措施", "应对措施", "处理措施", "措施"]),
  owner: headerIndex(headers, ["责任人", "负责人"]),
  status: headerIndex(headers, ["建议状态", "风险状态", "状态"]),
  targetDate: headerIndex(headers, ["计划关闭日期", "目标日期", "关闭日期"]),
});

const cellAt = (row: string[], index: number) => index >= 0 ? textValue(row[index]) : "";

const normalizeRiskDraft = (value: Record<string, unknown>): AssistantRiskDraft | null => {
  const riskName = textValue(value.riskName ?? value.name ?? value.title, 200);
  if (!riskName) return null;
  const level = normalizeLevel(value.level ?? value.riskLevel, "中");
  const trigger = textValue(value.trigger ?? value.basis ?? value.evidence);
  const impactDescription = textValue(value.impactDescription ?? value.consequence);
  const triggerLines = [
    trigger ? (/^识别依据\s*[:：]/u.test(trigger) ? trigger : `识别依据：${trigger}`) : "",
    impactDescription ? (/^可能影响\s*[:：]/u.test(impactDescription) ? impactDescription : `可能影响：${impactDescription}`) : "",
  ].filter(Boolean);
  return {
    riskName,
    category: textValue(value.category, 100) || deriveRiskCategory(riskName),
    trigger: triggerLines.join("\n"),
    probability: normalizeLevel(value.probability, "中"),
    impact: normalizeLevel(value.impact, level),
    level,
    response: textValue(value.response ?? value.measure ?? value.suggestion),
    owner: textValue(value.owner, 100),
    status: normalizeStatus(value.status),
    targetDate: normalizeDate(value.targetDate),
  };
};

const parseRiskTable = (table: MarkdownTable): ParsedRiskDraft[] => {
  const indexes = tableColumnIndexes(table.headers);
  if (indexes.name < 0) return [];
  return table.rows.flatMap((row) => {
    const riskName = cellAt(row, indexes.name).replace(/^\d+[.、]\s*/u, "").slice(0, 200);
    if (!riskName || /^(无|暂无|合计|总计)$/u.test(riskName)) return [];
    const level = normalizeLevel(cellAt(row, indexes.level), "中");
    const parsed: ParsedRiskDraft = {
      riskName,
      category: cellAt(row, indexes.category) || deriveRiskCategory(riskName),
      trigger: cellAt(row, indexes.trigger),
      probability: normalizeLevel(cellAt(row, indexes.probability), "中"),
      impact: normalizeLevel(cellAt(row, indexes.impactLevel), level),
      level,
      response: cellAt(row, indexes.response),
      owner: cellAt(row, indexes.owner),
      status: normalizeStatus(cellAt(row, indexes.status)),
      targetDate: normalizeDate(cellAt(row, indexes.targetDate)),
      impactDescription: cellAt(row, indexes.impactDescription),
    };
    return [parsed];
  });
};

const riskTerms = ["进度", "延期", "计划", "基线", "周期", "软件", "开发", "关键路径", "模块", "并行", "集成", "测试", "窗口", "成本", "预算", "超支", "采购", "质量", "交付", "验收", "资源"];

const riskNameSimilarity = (left: string, right: string) => {
  const normalize = (value: string) => value.replace(/[\s，,。；;、/（）()【】\[\]项目风险导致引发当前整体严重不可控]/g, "");
  const leftText = normalize(left);
  const rightText = normalize(right);
  if (!leftText || !rightText) return 0;
  if (leftText === rightText || leftText.includes(rightText) || rightText.includes(leftText)) return 1;
  const leftChars = new Set([...leftText]);
  const rightChars = new Set([...rightText]);
  const sharedChars = [...leftChars].filter((char) => rightChars.has(char)).length;
  const charScore = sharedChars / Math.max(leftChars.size, rightChars.size, 1);
  const leftBigrams = new Set([...leftText].slice(0, -1).map((char, index) => `${char}${leftText[index + 1]}`));
  const rightBigrams = new Set([...rightText].slice(0, -1).map((char, index) => `${char}${rightText[index + 1]}`));
  const sharedBigrams = [...leftBigrams].filter((value) => rightBigrams.has(value)).length;
  const bigramScore = sharedBigrams / Math.max(leftBigrams.size, rightBigrams.size, 1);
  const sharedTerms = riskTerms.filter((term) => left.includes(term) && right.includes(term)).length;
  return Math.min(1, charScore * 0.35 + bigramScore * 0.45 + Math.min(0.4, sharedTerms * 0.12));
};

const selectRiskTable = (tables: MarkdownTable[]) => {
  const candidates = tables
    .map((table) => ({ table, rows: parseRiskTable(table) }))
    .filter((candidate) => candidate.rows.length > 0);
  return [...candidates].sort((left, right) => {
    const score = (candidate: typeof left) => (
      (/(建议|推荐).{0,8}(优先)?登记|优先登记/u.test(candidate.table.heading) ? 100 : 0)
      + (candidate.table.headers.some((header) => normalizeHeader(header) === normalizeHeader("建议风险名称")) ? 20 : 0)
      - candidate.rows.length
    );
    return score(right) - score(left);
  })[0] ?? null;
};

const parseAssistantRiskDrafts = (content: string) => {
  const tables = extractMarkdownTables(content);
  const selected = selectRiskTable(tables);
  if (!selected) return [];
  const detailedRows = tables
    .filter((table) => table !== selected.table)
    .flatMap(parseRiskTable)
    .filter((row) => row.trigger || row.impactDescription || row.response);
  return selected.rows.map((row) => {
    const match = detailedRows
      .map((candidate) => ({ candidate, score: riskNameSimilarity(row.riskName, candidate.riskName) }))
      .sort((left, right) => right.score - left.score)[0];
    const enriched = match && match.score >= 0.28 ? match.candidate : null;
    return normalizeRiskDraft({
      ...row,
      category: row.category || enriched?.category,
      trigger: row.trigger || enriched?.trigger,
      impactDescription: row.impactDescription || enriched?.impactDescription,
      response: row.response || enriched?.response,
      probability: row.probability || enriched?.probability,
      impact: row.impact || enriched?.impact,
    });
  }).filter((draft): draft is AssistantRiskDraft => Boolean(draft));
};

export const isContextualRiskRegistrationRequest = (message: string) => (
  CONTEXT_REFERENCE_PATTERN.test(message)
  && RISK_WRITE_PATTERN.test(message)
  && RISK_TARGET_PATTERN.test(message)
);

export const normalizeAssistantRiskDrafts = (value: unknown): AssistantRiskDraft[] => {
  if (!Array.isArray(value)) return [];
  const drafts = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const draft = normalizeRiskDraft(item as Record<string, unknown>);
    return draft ? [draft] : [];
  });
  const seen = new Set<string>();
  return drafts.filter((draft) => {
    const key = draft.riskName.replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 50);
};

export const extractAssistantRiskDrafts = (history: AssistantMessageInput[]) => {
  for (const message of [...history].reverse()) {
    if (message.role !== "assistant") continue;
    const drafts = normalizeAssistantRiskDrafts(parseAssistantRiskDrafts(message.content));
    if (drafts.length > 0) return drafts;
  }
  return [];
};
