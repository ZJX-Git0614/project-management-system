import type { AssistantActionView } from "@/lib/assistant-actions";
import {
  describeAssistantExportFilters,
  parseAssistantProjectExportIntent,
  type AssistantProjectExportIntent,
  type GanttProgressReport,
} from "@/lib/assistant-export";
import type { AssistantExportDataObservation } from "@/lib/assistant-export-observation";
import type { ProjectAssistantQueryDomain } from "@/lib/project-assistant-query";

export type AssistantObjectiveAction = "QUERY" | "ANALYZE" | "EXPORT" | "CREATE" | "UPDATE" | "DELETE";
export type AssistantObjectiveDomain =
  | "PROJECT"
  | "GANTT"
  | "SCHEDULE_ANALYSIS"
  | "EARNED_VALUE"
  | "RESOURCE"
  | "SCHEDULE_COMPARE"
  | "MATTER"
  | "RISK"
  | "BUDGET"
  | "DOCUMENT"
  | "MEMBER"
  | "TODO"
  | "OPERATION"
  | "GENERAL";
export type AssistantDeliverableType = "CHAT_REPORT" | "FILE" | "DATABASE_CHANGE" | "CHAT_ANSWER";

export type AssistantIntentObjective = {
  id: string;
  action: AssistantObjectiveAction;
  domain: AssistantObjectiveDomain;
  description: string;
  required: boolean;
  dependsOn: string[];
};

export type AssistantIntentDeliverable = {
  id: string;
  type: AssistantDeliverableType;
  label: string;
  required: boolean;
  objectiveIds: string[];
};

export type AssistantIntentContract = {
  version: 1;
  originalRequest: string;
  projectId: string;
  understanding?: string;
  queryDomains?: ProjectAssistantQueryDomain[];
  objectives: AssistantIntentObjective[];
  deliverables: AssistantIntentDeliverable[];
  constraints: string[];
  exportIntent?: AssistantProjectExportIntent;
  confidence: number;
};

export type AssistantObjectiveVerification = {
  objectiveId: string;
  status: "PENDING" | "PASSED" | "FAILED";
  explanation: string;
  evidence: Array<{ label: string; value: string | number | boolean }>;
};

export type AssistantGoalVerification = {
  allRequiredPassed: boolean;
  completedObjectives: number;
  requiredObjectives: number;
  objectives: AssistantObjectiveVerification[];
  missingDeliverables: string[];
};

export type AssistantPublicTraceEvent = {
  id: string;
  phase: "UNDERSTAND" | "OBSERVE" | "PLAN" | "VALIDATE" | "EXECUTE" | "VERIFY" | "SYNTHESIZE";
  title: string;
  summary: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  toolId?: string;
  details?: Array<{ label: string; value: string }>;
};

type AssistantActionResultLike = NonNullable<AssistantActionView["result"]> & {
  message?: string;
  downloadUrl?: string;
  matchedRowCount?: number;
  progressReport?: GanttProgressReport;
  workbookSheets?: string[];
  includesProgressReport?: boolean;
  includesVisualization?: boolean;
};

const exportDomainByType: Record<AssistantProjectExportIntent["exportType"], AssistantObjectiveDomain> = {
  gantt: "GANTT",
  weekly: "MATTER",
  risk: "RISK",
  budget: "BUDGET",
  scheduleAnalysis: "GANTT",
};

const exportQueryDomainByType: Record<AssistantProjectExportIntent["exportType"], ProjectAssistantQueryDomain> = {
  gantt: "TASK",
  weekly: "MATTER",
  risk: "RISK",
  budget: "BUDGET",
  scheduleAnalysis: "SCHEDULE_ANALYSIS",
};

const exportDomain = (intent: AssistantProjectExportIntent) => exportDomainByType[intent.exportType];

const exportLabel = (intent: AssistantProjectExportIntent) => ({
  gantt: "甘特任务",
  weekly: "项目事项",
  risk: "风险登记册",
  budget: "项目预算",
  scheduleAnalysis: "计划分析",
})[intent.exportType];

export const buildAssistantIntentContract = (params: {
  message: string;
  projectId: string;
}): AssistantIntentContract => {
  const originalRequest = params.message.trim();
  const exportIntent = parseAssistantProjectExportIntent(originalRequest);
  if (exportIntent) {
    const label = exportLabel(exportIntent);
    const objectives: AssistantIntentObjective[] = [{
      id: "O1",
      action: "EXPORT",
      domain: exportDomain(exportIntent),
      description: `按用户限定范围导出${label}`,
      required: true,
      dependsOn: [],
    }];
    const deliverables: AssistantIntentDeliverable[] = [{
      id: "D1",
      type: "FILE",
      label: `${label}导出文件`,
      required: true,
      objectiveIds: ["O1"],
    }];
    if (exportIntent.includeProgressReport) {
      objectives.push({
        id: "O2",
        action: "ANALYZE",
        domain: "GANTT",
        description: "基于与导出文件完全相同的任务范围生成进度总结报告",
        required: true,
        dependsOn: ["O1"],
      });
      deliverables.push({
        id: "D2",
        type: "FILE",
        label: "任务进度总结报告",
        required: true,
        objectiveIds: ["O2"],
      });
    }
    if (exportIntent.exportType === "budget" && exportIntent.includeVisualization) {
      objectives.push({
        id: "O2",
        action: "ANALYZE",
        domain: "BUDGET",
        description: "基于实际预算明细计算分类汇总并生成数据可视化",
        required: true,
        dependsOn: ["O1"],
      });
      deliverables.push({
        id: "D2",
        type: "FILE",
        label: "预算汇总与数据可视化工作表",
        required: true,
        objectiveIds: ["O2"],
      });
    }
    return {
      version: 1,
      originalRequest,
      projectId: params.projectId,
      understanding: originalRequest,
      queryDomains: [exportQueryDomainByType[exportIntent.exportType]],
      objectives,
      deliverables,
      constraints: describeAssistantExportFilters(exportIntent),
      exportIntent,
      confidence: 1,
    };
  }

  return {
    version: 1,
    originalRequest,
    projectId: params.projectId,
    understanding: originalRequest,
    queryDomains: ["GENERAL"],
    objectives: [{
      id: "O1",
      action: "QUERY",
      domain: "GENERAL",
      description: "完整回答用户当前问题",
      required: true,
      dependsOn: [],
    }],
    deliverables: [{
      id: "D1",
      type: "CHAT_ANSWER",
      label: "完整回答",
      required: true,
      objectiveIds: ["O1"],
    }],
    constraints: [],
    confidence: 0.8,
  };
};

const actionResult = (action?: AssistantActionView | null) => (
  action?.result as AssistantActionResultLike | undefined
);

export const verifyAssistantIntentCompletion = (
  contract: AssistantIntentContract,
  action?: AssistantActionView | null,
  options?: { answer?: string },
): AssistantGoalVerification => {
  const result = actionResult(action);
  if (!contract.exportIntent) {
    const actionSucceeded = action?.status === "SUCCEEDED";
    const actionPending = action?.status === "PROPOSED";
    const hasFile = actionSucceeded && Boolean(result?.downloadUrl);
    const hasAnswer = Boolean(options?.answer?.trim());
    const deliverablePassed = (deliverable: AssistantIntentDeliverable) => {
      if (deliverable.type === "FILE") return hasFile;
      if (deliverable.type === "DATABASE_CHANGE") return actionSucceeded;
      return hasAnswer;
    };
    const objectives = contract.objectives.map<AssistantObjectiveVerification>((objective) => {
      const linkedDeliverables = contract.deliverables.filter((deliverable) => deliverable.objectiveIds.includes(objective.id));
      const linkedPassed = linkedDeliverables.length > 0 && linkedDeliverables.every(deliverablePassed);
      const operationPassed = ["CREATE", "UPDATE", "DELETE"].includes(objective.action)
        ? actionSucceeded
        : objective.action === "EXPORT"
          ? hasFile
          : linkedPassed || hasAnswer;
      return {
        objectiveId: objective.id,
        status: operationPassed ? "PASSED" : actionPending ? "PENDING" : "FAILED",
        explanation: operationPassed
          ? linkedDeliverables.length > 0
            ? `已生成：${linkedDeliverables.map((deliverable) => deliverable.label).join("、")}`
            : "目标已在最终回答中完成"
          : actionPending
            ? "已生成操作预览，等待用户确认执行"
            : "尚未得到满足该目标的可验收结果",
        evidence: [
          ...(action ? [{ label: "工具状态", value: action.status }] : []),
          ...(hasFile ? [{ label: "下载文件", value: true }] : []),
          ...(hasAnswer ? [{ label: "最终回答", value: true }] : []),
        ],
      };
    });
    const requiredObjectives = contract.objectives.filter((objective) => objective.required);
    const completedObjectives = requiredObjectives.filter((objective) => (
      objectives.find((verification) => verification.objectiveId === objective.id)?.status === "PASSED"
    )).length;
    const missingDeliverables = contract.deliverables
      .filter((deliverable) => deliverable.required && !deliverablePassed(deliverable))
      .map((deliverable) => deliverable.label);
    return {
      allRequiredPassed: completedObjectives === requiredObjectives.length && missingDeliverables.length === 0,
      completedObjectives,
      requiredObjectives: requiredObjectives.length,
      objectives,
      missingDeliverables,
    };
  }

  const actionSucceeded = action?.status === "SUCCEEDED";
  const hasFile = actionSucceeded && Boolean(result?.downloadUrl);
  const hasReport = actionSucceeded
    && Boolean(result?.progressReport)
    && result?.includesProgressReport === true
    && result?.workbookSheets?.includes("进度总结") === true;
  const hasVisualization = actionSucceeded
    && result?.includesVisualization === true
    && result?.workbookSheets?.includes("数据可视化") === true;
  const objectives = contract.objectives.map<AssistantObjectiveVerification>((objective) => {
    if (objective.action === "EXPORT") {
      return {
        objectiveId: objective.id,
        status: hasFile ? "PASSED" : action?.status === "PROPOSED" ? "PENDING" : "FAILED",
        explanation: hasFile ? "导出文件已生成并提供下载地址" : "尚未生成可下载文件",
        evidence: [
          { label: "工具状态", value: action?.status || "未执行" },
          ...(typeof result?.matchedRowCount === "number" ? [{ label: "导出记录", value: result.matchedRowCount }] : []),
        ],
      };
    }
    if (objective.action === "ANALYZE") {
      if (objective.domain === "BUDGET") {
        return {
          objectiveId: objective.id,
          status: hasVisualization ? "PASSED" : action?.status === "PROPOSED" ? "PENDING" : "FAILED",
          explanation: hasVisualization ? "预算汇总和数据可视化已写入导出工作簿" : "尚未生成预算可视化工作表",
          evidence: result?.workbookSheets ? [{ label: "工作表", value: result.workbookSheets.join("、") }] : [],
        };
      }
      return {
        objectiveId: objective.id,
        status: hasReport ? "PASSED" : action?.status === "PROPOSED" ? "PENDING" : "FAILED",
        explanation: hasReport ? "进度报告已基于导出任务范围生成" : "尚未生成进度总结报告",
        evidence: result?.progressReport ? [
          { label: "分析记录", value: result.progressReport.total },
          { label: "平均进度", value: `${result.progressReport.averageProgress}%` },
        ] : [],
      };
    }
    return {
      objectiveId: objective.id,
      status: actionSucceeded ? "PASSED" : "PENDING",
      explanation: actionSucceeded ? "目标关联操作已完成" : "目标尚未执行",
      evidence: [],
    };
  });
  const requiredObjectives = contract.objectives.filter((objective) => objective.required);
  const completedObjectives = requiredObjectives.filter((objective) => (
    objectives.find((verification) => verification.objectiveId === objective.id)?.status === "PASSED"
  )).length;
  const missingDeliverables = contract.deliverables.filter((deliverable) => {
    if (!deliverable.required) return false;
    return deliverable.objectiveIds.some((objectiveId) => (
      objectives.find((objective) => objective.objectiveId === objectiveId)?.status !== "PASSED"
    ));
  }).map((deliverable) => deliverable.label);

  return {
    allRequiredPassed: completedObjectives === requiredObjectives.length && missingDeliverables.length === 0,
    completedObjectives,
    requiredObjectives: requiredObjectives.length,
    objectives,
    missingDeliverables,
  };
};

const reportAnswer = (report: GanttProgressReport) => {
  const categories = report.categoryBreakdown.slice(0, 5)
    .map((item) => `${item.category} ${item.total} 项（平均 ${item.averageProgress}%）`)
    .join("、");
  return [
    "**任务进度总结**",
    "",
    report.summary,
    categories ? `主要任务类别：${categories}。` : "",
  ].filter(Boolean).join("\n");
};

export const composeVerifiedAssistantActionAnswer = (params: {
  contract: AssistantIntentContract;
  action: AssistantActionView;
  verification: AssistantGoalVerification;
}) => {
  const result = actionResult(params.action);
  if (params.action.status === "PROPOSED") {
    return `已理解你的要求，共识别 ${params.contract.objectives.length} 个目标。已生成操作建议：**${params.action.title}**，确认后将继续执行并逐项验收。`;
  }
  if (!params.verification.allRequiredPassed) {
    const missing = params.verification.missingDeliverables.join("、") || "必要目标";
    return `本次操作只完成了部分要求，尚缺少：${missing}。不会把部分完成标记为全部完成。${result?.message ? `\n\n工具结果：${result.message}` : ""}`;
  }
  const sections = [
    `已完成你的全部 ${params.contract.objectives.length} 项要求。`,
    result?.progressReport ? reportAnswer(result.progressReport) : "",
    result?.downloadUrl
      ? `**导出结果**\n\nExcel 工作簿已生成，共 ${result.matchedRowCount ?? result.progressReport?.total ?? 0} 条记录${result.workbookSheets?.length ? `，包含“${result.workbookSheets.join("”、“")}”工作表` : ""}，可通过下方按钮下载。`
      : result?.message || "",
  ].filter(Boolean);
  return sections.join("\n\n");
};

export const buildAssistantPreflightTraceEvents = (params: {
  contract: AssistantIntentContract;
  observation?: AssistantExportDataObservation;
}): AssistantPublicTraceEvent[] => {
  const { contract, observation } = params;
  const events: AssistantPublicTraceEvent[] = [{
    id: "understand",
    phase: "UNDERSTAND",
    title: "理解用户要求",
    summary: `识别到 ${contract.objectives.length} 个目标：${contract.objectives.map((objective) => objective.description).join("；")}`,
    status: "SUCCEEDED",
    details: contract.constraints.map((constraint) => ({ label: "约束", value: constraint })),
  }];
  if (observation) {
    events.push({
      id: "observe",
      phase: "OBSERVE",
      title: "检查授权项目数据",
      summary: `共读取 ${observation.totalRows} 条记录，按当前条件命中 ${observation.matchedRows} 条`,
      status: "SUCCEEDED",
      details: [
        { label: "数据对象", value: observation.exportType },
        { label: "筛选条件", value: observation.appliedFilters.join("；") || "无额外筛选" },
      ],
    });
  }
  events.push({
    id: "plan",
    phase: "PLAN",
    title: "制定执行计划",
    summary: contract.deliverables.length > 1
      ? `必须生成 ${contract.deliverables.map((deliverable) => deliverable.label).join("和")}，全部验收通过后才能结束`
      : `生成并验收${contract.deliverables[0]?.label || "回答结果"}`,
    status: "SUCCEEDED",
    toolId: contract.exportIntent ? "project.export" : undefined,
  });
  return events;
};

export const buildAssistantCompletedTraceEvents = (params: {
  contract: AssistantIntentContract;
  observation?: AssistantExportDataObservation;
  action?: AssistantActionView | null;
  verification?: AssistantGoalVerification;
  toolArgs?: Record<string, unknown>;
}): AssistantPublicTraceEvent[] => {
  const events = buildAssistantPreflightTraceEvents({
    contract: params.contract,
    observation: params.observation,
  });
  if (params.action) {
    const result = actionResult(params.action);
    events.push({
      id: "validate",
      phase: "VALIDATE",
      title: "校验权限与工具参数",
      summary: `已通过当前账号权限、工具白名单和参数 Schema 校验`,
      status: "SUCCEEDED",
      toolId: params.action.toolId,
      details: params.toolArgs ? [{ label: "结构化参数", value: JSON.stringify(params.toolArgs) }] : undefined,
    });
    events.push({
      id: "execute",
      phase: "EXECUTE",
      title: `调用 ${params.action.toolId}`,
      summary: typeof result?.message === "string"
        ? result.message
        : params.action.status === "PROPOSED"
          ? "等待用户确认执行"
          : `工具状态：${params.action.status}`,
      status: params.action.status === "SUCCEEDED" ? "SUCCEEDED" : params.action.status === "PROPOSED" ? "RUNNING" : "FAILED",
      toolId: params.action.toolId,
    });
  }
  if (params.verification) {
    events.push({
      id: "verify",
      phase: "VERIFY",
      title: "验证用户目标",
      summary: params.verification.allRequiredPassed
        ? `${params.verification.completedObjectives}/${params.verification.requiredObjectives} 个必要目标全部通过`
        : `${params.verification.completedObjectives}/${params.verification.requiredObjectives} 个必要目标通过，仍缺少 ${params.verification.missingDeliverables.join("、") || "待执行目标"}`,
      status: params.verification.allRequiredPassed ? "SUCCEEDED" : params.action?.status === "PROPOSED" ? "RUNNING" : "FAILED",
      details: params.verification.objectives.map((objective) => ({
        label: objective.objectiveId,
        value: `${objective.status}：${objective.explanation}`,
      })),
    });
    if (params.verification.allRequiredPassed) {
      events.push({
        id: "synthesize",
        phase: "SYNTHESIZE",
        title: "生成最终回答",
        summary: "使用已验证的工具结果生成分析结论和交付说明",
        status: "SUCCEEDED",
      });
    }
  }
  return events;
};
