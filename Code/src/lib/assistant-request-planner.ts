import { callAssistantProviderModel } from "@/lib/assistant-provider-client";
import {
  type AssistantDeliverableType,
  type AssistantIntentContract,
  type AssistantIntentDeliverable,
  type AssistantIntentObjective,
  type AssistantObjectiveAction,
  type AssistantObjectiveDomain,
} from "@/lib/assistant-intent-contract";
import type { AssistantRuntimeConfig } from "@/lib/assistant-settings";
import type { AssistantMessageInput } from "@/lib/project-assistant";
import {
  PROJECT_ASSISTANT_QUERY_DOMAIN_CATALOG,
  type ProjectAssistantQueryDomain,
} from "@/lib/project-assistant-query";

export type AssistantRequestAnalysis = {
  understanding: string;
  queryDomains: ProjectAssistantQueryDomain[];
  objectives: AssistantIntentObjective[];
  deliverables: AssistantIntentDeliverable[];
  constraints: string[];
  confidence: number;
};

const OBJECTIVE_ACTIONS = new Set<AssistantObjectiveAction>([
  "QUERY", "ANALYZE", "EXPORT", "CREATE", "UPDATE", "DELETE",
]);
const OBJECTIVE_DOMAINS = new Set<AssistantObjectiveDomain>([
  "PROJECT", "GANTT", "SCHEDULE_ANALYSIS", "EARNED_VALUE", "RESOURCE",
  "SCHEDULE_COMPARE", "MATTER", "RISK", "BUDGET", "DOCUMENT", "MEMBER",
  "TODO", "OPERATION", "GENERAL",
]);
const DELIVERABLE_TYPES = new Set<AssistantDeliverableType>([
  "CHAT_REPORT", "FILE", "DATABASE_CHANGE", "CHAT_ANSWER",
]);
const QUERY_DOMAINS = new Set<ProjectAssistantQueryDomain>(
  PROJECT_ASSISTANT_QUERY_DOMAIN_CATALOG.map((item) => item.domain),
);

const boundedText = (value: unknown, maxLength: number) => (
  typeof value === "string" ? value.trim().slice(0, maxLength) : ""
);

const extractJsonObject = (content: string) => {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || content.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

export const parseAssistantRequestAnalysisResponse = (content: string): AssistantRequestAnalysis | null => {
  const parsed = extractJsonObject(content);
  if (!parsed) return null;
  const understanding = boundedText(parsed.understanding, 500);
  if (!understanding) return null;
  if (!Array.isArray(parsed.queryDomains) || !Array.isArray(parsed.objectives) || !Array.isArray(parsed.deliverables)) {
    return null;
  }
  const queryDomains = Array.from(new Set(parsed.queryDomains.map((value) => String(value || "").trim() as ProjectAssistantQueryDomain)));
  if (queryDomains.length === 0 || queryDomains.some((domain) => !QUERY_DOMAINS.has(domain))) return null;
  if (parsed.objectives.length === 0 || parsed.objectives.length > 8 || parsed.deliverables.length === 0 || parsed.deliverables.length > 8) {
    return null;
  }

  const objectives = parsed.objectives.map((value, index): AssistantIntentObjective | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const action = String(raw.action || "").trim() as AssistantObjectiveAction;
    const domain = String(raw.domain || "").trim() as AssistantObjectiveDomain;
    const description = boundedText(raw.description, 300);
    if (!OBJECTIVE_ACTIONS.has(action) || !OBJECTIVE_DOMAINS.has(domain) || !description) return null;
    return {
      id: `M${index + 1}`,
      action,
      domain,
      description,
      required: raw.required !== false,
      dependsOn: [],
    };
  });
  if (objectives.some((objective) => !objective)) return null;

  const deliverables = parsed.deliverables.map((value, index): AssistantIntentDeliverable | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const type = String(raw.type || "").trim() as AssistantDeliverableType;
    const label = boundedText(raw.label, 200);
    const objectiveIndexes = Array.isArray(raw.objectiveIndexes)
      ? Array.from(new Set(raw.objectiveIndexes.map(Number)))
      : [];
    if (!DELIVERABLE_TYPES.has(type) || !label || objectiveIndexes.length === 0) return null;
    if (objectiveIndexes.some((objectiveIndex) => !Number.isInteger(objectiveIndex) || objectiveIndex < 0 || objectiveIndex >= objectives.length)) {
      return null;
    }
    return {
      id: `MD${index + 1}`,
      type,
      label,
      required: raw.required !== false,
      objectiveIds: objectiveIndexes.map((objectiveIndex) => `M${objectiveIndex + 1}`),
    };
  });
  if (deliverables.some((deliverable) => !deliverable)) return null;

  const constraints = Array.isArray(parsed.constraints)
    ? Array.from(new Set(parsed.constraints.map((value) => boundedText(value, 240)).filter(Boolean))).slice(0, 12)
    : [];
  const confidenceValue = Number(parsed.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.min(1, Math.max(0, confidenceValue))
    : 0.75;
  return {
    understanding,
    queryDomains,
    objectives: objectives as AssistantIntentObjective[],
    deliverables: deliverables as AssistantIntentDeliverable[],
    constraints,
    confidence,
  };
};

const objectiveKey = (objective: AssistantIntentObjective) => `${objective.action}:${objective.domain}:${objective.description}`;
const deliverableKey = (deliverable: AssistantIntentDeliverable) => `${deliverable.type}:${deliverable.label}`;

export const mergeAssistantRequestAnalysis = (
  base: AssistantIntentContract,
  analysis: AssistantRequestAnalysis,
): AssistantIntentContract => {
  const objectiveSeeds = base.exportIntent
    ? [...base.objectives, ...analysis.objectives]
    : analysis.objectives;
  const uniqueObjectives = Array.from(new Map(objectiveSeeds.map((objective) => [objectiveKey(objective), objective])).values());
  const oldToNewObjectiveId = new Map<string, string>();
  const objectives = uniqueObjectives.map((objective, index) => {
    const id = `O${index + 1}`;
    oldToNewObjectiveId.set(objective.id, id);
    return { ...objective, id };
  }).map((objective) => ({
    ...objective,
    dependsOn: objective.dependsOn.map((id) => oldToNewObjectiveId.get(id)).filter((id): id is string => Boolean(id)),
  }));
  const deliverableSeeds = base.exportIntent
    ? [...base.deliverables, ...analysis.deliverables]
    : analysis.deliverables;
  const deliverables = Array.from(new Map(deliverableSeeds.map((deliverable) => [deliverableKey(deliverable), deliverable])).values())
    .map((deliverable, index) => ({
      ...deliverable,
      id: `D${index + 1}`,
      objectiveIds: deliverable.objectiveIds
        .map((id) => oldToNewObjectiveId.get(id))
        .filter((id): id is string => Boolean(id)),
    }))
    .filter((deliverable) => deliverable.objectiveIds.length > 0);

  return {
    ...base,
    understanding: analysis.understanding,
    queryDomains: analysis.queryDomains,
    objectives,
    deliverables,
    constraints: Array.from(new Set([...base.constraints, ...analysis.constraints])),
    confidence: Math.min(base.exportIntent ? base.confidence : 1, analysis.confidence),
  };
};

export const analyzeAssistantRequestWithModel = async (params: {
  message: string;
  projectId: string;
  history: AssistantMessageInput[];
  runtime: AssistantRuntimeConfig;
  baseContract: AssistantIntentContract;
  signal?: AbortSignal;
}) => {
  if (!params.runtime.llmProvider) return params.baseContract;
  const queryCatalog = PROJECT_ASSISTANT_QUERY_DOMAIN_CATALOG
    .map((item) => `${item.domain}: ${item.description}`)
    .join("\n");
  try {
    const response = await callAssistantProviderModel({
      provider: params.runtime.llmProvider,
      temperature: 0,
      maxTokens: 900,
      signal: params.signal,
      timeoutMs: 25_000,
      messages: [
        {
          role: "system",
          content: [
            "你是 Ceastar PMS 的请求分析器。只拆解需求，不回答问题，也不调用工具。",
            "必须保留用户明确提出的每一个目标、筛选条件、输出格式和交付物；复合请求不能只保留第一项。",
            "不得生成 SQL、数据库 ID、虚构字段或系统能力。数据查询域只能使用以下白名单：",
            queryCatalog,
            `目标动作白名单：${Array.from(OBJECTIVE_ACTIONS).join("、")}`,
            `目标业务域白名单：${Array.from(OBJECTIVE_DOMAINS).join("、")}`,
            `交付物白名单：${Array.from(DELIVERABLE_TYPES).join("、")}`,
            "只返回 JSON：{\"understanding\":\"对用户真实目标的完整复述\",\"queryDomains\":[\"TASK\"],\"objectives\":[{\"action\":\"EXPORT\",\"domain\":\"GANTT\",\"description\":\"目标\",\"required\":true}],\"deliverables\":[{\"type\":\"FILE\",\"label\":\"交付物\",\"required\":true,\"objectiveIndexes\":[0]}],\"constraints\":[\"约束\"],\"confidence\":0.9}",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `最近对话：${JSON.stringify(params.history.slice(-6))}`,
            `当前请求：${params.message}`,
            `确定性规则识别结果（只能补充，不能删除其硬性要求）：${JSON.stringify(params.baseContract)}`,
          ].join("\n\n"),
        },
      ],
    });
    const analysis = parseAssistantRequestAnalysisResponse(response);
    return analysis ? mergeAssistantRequestAnalysis(params.baseContract, analysis) : params.baseContract;
  } catch {
    return params.baseContract;
  }
};
