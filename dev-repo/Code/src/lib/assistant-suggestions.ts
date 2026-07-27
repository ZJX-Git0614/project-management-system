import type { AssistantMessageInput, ProjectAssistantContext } from "@/lib/project-assistant";

type SuggestionDomain = "TASK" | "ITEM" | "RISK" | "BUDGET" | "DOCUMENT" | "TODO" | "PORTFOLIO";

const DOMAIN_KEYWORDS: Record<SuggestionDomain, RegExp> = {
  TASK: /任务|甘特|进度|延期|关键路径|计划/u,
  ITEM: /事项|跟进|问题|措施/u,
  RISK: /风险|隐患|处置/u,
  BUDGET: /预算|成本|利润|费用/u,
  DOCUMENT: /文档|文件|清单/u,
  TODO: /待办|提醒|未完成/u,
  PORTFOLIO: /项目组合|全部项目|进行中的项目/u,
};

const DOMAIN_PROMPTS: Record<SuggestionDomain, string[]> = {
  TASK: ["检查延期和计划偏差", "分析关键路径与依赖风险", "对比计划与实际完成情况"],
  ITEM: ["汇总需要优先跟进的事项", "检查事项中的问题与依赖", "哪些事项长期没有进展"],
  RISK: ["哪些风险需要优先处理", "给出当前风险的处置建议", "检查高风险关联事项"],
  BUDGET: ["分析预算执行与利润空间", "检查成本偏差较大的分类", "汇总预算剩余和风险"],
  DOCUMENT: ["检查项目文档缺口", "汇总最近上传的项目文档", "哪些计划文件需要复核"],
  TODO: ["查看我的未完成待办", "根据当前情况建议下一步行动", "哪些工作需要尽快处理"],
  PORTFOLIO: ["汇总进行中的项目", "哪些项目需要优先关注", "查看我的跨项目待办"],
};

const availableDomains = (context: ProjectAssistantContext | null): SuggestionDomain[] => {
  if (!context?.project) return ["PORTFOLIO", "TODO"];
  return [
    ...(context.progress.total > 0 ? ["TASK" as const] : []),
    ...(context.weeklyItems.length > 0 ? ["ITEM" as const] : []),
    ...(context.risks.length > 0 ? ["RISK" as const] : []),
    ...(context.budget.categories.length > 0 || context.budget.contractAmount > 0 ? ["BUDGET" as const] : []),
    ...(context.documents.length > 0 ? ["DOCUMENT" as const] : []),
    "TODO",
  ];
};

export const buildAssistantSuggestions = ({
  context,
  history,
  limit = 4,
}: {
  context: ProjectAssistantContext | null;
  history: AssistantMessageInput[];
  limit?: number;
}) => {
  const userMessages = history.filter((message) => message.role === "user").map((message) => message.content);
  const recent = userMessages.slice(-8).join("\n");
  const lastMessage = userMessages.at(-1)?.trim() || "";
  const domains = availableDomains(context);
  const ranked = domains.map((domain, index) => {
    const matches = userMessages.filter((message) => DOMAIN_KEYWORDS[domain].test(message)).length;
    const recentMatch = DOMAIN_KEYWORDS[domain].test(recent) ? 2 : 0;
    return { domain, score: matches * 3 + recentMatch - index * 0.05 };
  }).sort((a, b) => b.score - a.score);

  const suggestions = ranked.flatMap(({ domain }, domainIndex) => {
    const prompts = DOMAIN_PROMPTS[domain];
    const offset = (userMessages.length + domainIndex) % prompts.length;
    return [...prompts.slice(offset), ...prompts.slice(0, offset)];
  });
  return Array.from(new Set(suggestions)).filter((prompt) => prompt !== lastMessage).slice(0, limit);
};
