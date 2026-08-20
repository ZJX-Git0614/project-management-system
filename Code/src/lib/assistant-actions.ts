import { randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, basename } from "node:path";

import type { AssistantActionRun } from "@prisma/client";

import { ProjectStatus } from "@/domain/enums";
import { userHasPermission, type AuthenticatedUser } from "@/lib/server-auth";
import {
  getAssistantToolDefinition,
  loadAssistantRuntimeConfig,
  validateAssistantToolArgs,
  type AssistantRuntimeConfig,
} from "@/lib/assistant-settings";
import { prisma } from "@/lib/prisma";
import { findProjectMatters, replaceRiskMatterLinks } from "@/lib/project-associations";
import { buildAssistantStoredName, getAssistantArtifactPath, getAssistantAttachmentPath } from "@/lib/assistant-artifact-storage";
import { nextRiskCode, renumberRiskCodes } from "@/lib/risk-register-codes";
import { nextWeeklyMatterCode, renumberWeeklyMatterCodes } from "@/lib/weekly-matter-codes";
import {
  convertScheduleFile,
  mergeScheduleFiles,
  SCHEDULE_CONVERT_EXTENSIONS,
  SCHEDULE_IMPORT_EXTENSIONS,
  SCHEDULE_MERGE_EXTENSIONS,
  parseScheduleImportSource,
} from "@/lib/schedule-file-merge";
import {
  changeProjectGanttTaskHierarchy,
  deleteGanttTaskSubtrees,
  deleteGanttTasksAtOrBeyondDepth,
  getOrderedGanttTasks,
  getProjectGanttCalendarMode,
  refreshProjectGanttDerivedState,
  renumberProjectGanttTaskCodes,
} from "@/lib/gantt-task-service";
import {
  resolveEffectiveGanttOwnerMemberId,
  synchronizeGanttOwnerHierarchy,
} from "@/lib/gantt-owner-service";
import {
  calculateTaskFinishDate,
  estimatedHoursForDuration,
  isValidGanttDurationDays,
  normalizeTaskStartDate,
} from "@/lib/gantt-calendar";
import { analyzeSchedule } from "@/lib/schedule-analysis";
import { buildImportedScheduleSnapshot, getCurrentScheduleSnapshot } from "@/lib/schedule-snapshot";
import { isDocumentRevisionRequest, reviseDocumentsWithSmallModel } from "@/lib/assistant-document-revision";
import {
  assistantExportPlanPreservesRequest,
  buildGanttProgressReport,
  describeAssistantExportFilters,
  normalizeAssistantProjectExportIntent,
  parseAssistantProjectExportIntent,
  selectGanttExportRows,
  selectWeeklyExportRows,
  type AssistantProjectExportIntent,
} from "@/lib/assistant-export";
import { itemProgressFields, itemStatusFromProgress } from "@/lib/item-progress";
import { getAssistantBudgetWorkbookSheetNames } from "@/lib/assistant-project-export-workbook";
import { callAssistantProviderModel } from "@/lib/assistant-provider-client";
import { buildProjectAssistantContext } from "@/lib/project-assistant";
import {
  buildProjectAssistantQueryIntent,
  buildProjectAssistantVisibleContext,
} from "@/lib/project-assistant-query";
import {
  synchronizeGanttTaskCategories,
  synchronizeGanttTaskCategoriesAfterNameChange,
} from "@/lib/gantt-hierarchy";
import {
  applyProjectResourceScheduleCandidate,
  RESOURCE_SCHEDULE_CANDIDATE_KINDS,
  resourceScheduleAnalysis,
} from "@/lib/gantt-resource-service";
import type { ResourceScheduleCandidateKind } from "@/lib/gantt-resource-schedule";
import {
  extractAssistantRiskDrafts,
  isContextualRiskRegistrationRequest,
  normalizeAssistantRiskDrafts,
} from "@/lib/assistant-risk-drafts";
import { PROJECT_STATUS_LABEL } from "@/lib/constants";
import {
  APPROVAL_BUSINESS_TYPES,
  approvalBusinessIdForProjectStatus,
  approvalBusinessIdForWbsBaseline,
  approvalBusinessIdForWbsTaskProgressSubmission,
} from "@/lib/approval-workflow";
import { processApprovalAction, startApprovalWorkflow } from "@/lib/approval-workflow-server";
import { postCollaborationMessage } from "@/lib/collaboration-server";
import { assertProjectStatusTransition, projectStatusActionPermission } from "@/lib/project-lifecycle";

export type AssistantActionView = {
  id: string;
  toolId: string;
  title: string;
  description: string;
  riskLevel: string;
  status: string;
  expiresAt: string;
  result?: Record<string, unknown>;
  planId?: string;
  planStepId?: string;
};

const parseJson = (value: string) => {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const serializeAssistantAction = (action: AssistantActionRun): AssistantActionView => {
  const preview = parseJson(action.previewJson);
  return {
    id: action.id,
    toolId: action.toolId,
    title: String(preview.title || action.toolId),
    description: String(preview.description || ""),
    riskLevel: action.riskLevel,
    status: action.status,
    expiresAt: action.expiresAt.toISOString(),
    result: action.resultJson && action.resultJson !== "{}" ? parseJson(action.resultJson) : undefined,
    planId: action.planId || undefined,
    planStepId: action.planStepId || undefined,
  };
};

const cleanTitle = (message: string) => message
  .replace(/^(请|帮我|麻烦)?\s*(创建|新增|新建)\s*(一个|一条)?\s*(项目)?\s*待办\s*[:：]?/u, "")
  .replace(/[“”"']/g, "")
  .trim();

const parseProgressIntent = (message: string) => {
  const code = message.match(/Task\d+(?:\.\d+)*/i)?.[0];
  const progress = message.match(/(?:进度|完成度)\s*(?:改为|更新为|设置为|到)?\s*(\d{1,3})\s*%?/u)?.[1];
  if (!code || progress === undefined) return null;
  const value = Number(progress);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? { taskCode: code, progress: value } : null;
};

const normalizeResourceScheduleCandidateKind = (value: unknown): ResourceScheduleCandidateKind | null => {
  const kind = String(value || "").trim().toUpperCase() as ResourceScheduleCandidateKind;
  return RESOURCE_SCHEDULE_CANDIDATE_KINDS.includes(kind) ? kind : null;
};

export const parseResourceOptimizationIntent = (message: string) => {
  const asksToApply = /(应用|采用|执行|确认|选用|使用|启动|运行).{0,18}(正式)?(自动)?(方案|排期)|(直接|现在).{0,8}(自动|正式|资源|调整).{0,8}(排期|排程|优化)?/u.test(message);
  const mentionsSchedule = /(自动排期|正式排期|资源冲突|人员冲突|资源排期|排期优化|排程|排期方案)/u.test(message);
  if (!asksToApply || !mentionsSchedule) return null;
  return { candidateKind: "FORMAL" as const };
};

const parseCommandField = (message: string, labels: readonly string[]) => {
  const label = labels.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = message.match(new RegExp(`(?:${label})\\s*(?:改为|更新为|设置为|设为|为|[:：])\\s*[“\"']?([^；;，,。\n”\"']+)`, "u"));
  return match?.[1]?.trim() || "";
};

export const parseGanttTaskCreateIntent = (message: string) => {
  if (!/(创建|新增|新建).{0,12}(甘特)?任务|(甘特)?任务.{0,12}(创建|新增|新建)/u.test(message)) return null;
  const taskName = parseCommandField(message, ["任务名称", "任务"])
    || message.match(/[“"']([^”"']{1,100})[”"']/u)?.[1]?.trim()
    || "";
  const startDate = message.match(/(?:计划开始|开始日期|开始时间)\s*(?:为|[:：])?\s*(\d{4}-\d{2}-\d{2})/u)?.[1] || "";
  const durationText = message.match(/(?:工期|持续时间)\s*(?:为|[:：])?\s*(\d+(?:\.5)?)/u)?.[1];
  const durationDays = durationText === undefined ? Number.NaN : Number(durationText);
  const parentTaskCode = message.match(/(?:父任务|上级任务|父级)\s*(?:为|[:：])?\s*(Task\d+(?:\.\d+)*)/iu)?.[1] || undefined;
  if (!taskName || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !isValidGanttDurationDays(durationDays)) return null;
  return { taskName, startDate, durationDays, parentTaskCode };
};

export const parseGanttTaskTextUpdateIntent = (message: string) => {
  const taskCode = message.match(/Task\d+(?:\.\d+)*/i)?.[0];
  if (!taskCode || !/(修改|更新|改为|设置为|设为)/u.test(message)) return null;
  const taskName = parseCommandField(message, ["任务名称"]);
  const taskDescription = parseCommandField(message, ["任务描述", "描述"]);
  const remark = parseCommandField(message, ["备注"]);
  if (!taskName && !taskDescription && !remark) return null;
  return { taskCode, taskName: taskName || undefined, taskDescription: taskDescription || undefined, remark: remark || undefined };
};

export const parseGanttTaskDeleteIntent = (message: string) => {
  if (!/(删除|移除).*(任务|Task)|(任务|Task).*(删除|移除)/u.test(message)) return null;
  const taskCodes = Array.from(new Set([...message.matchAll(/Task\d+(?:\.\d+)*/gi)].map((match) => match[0])));
  return taskCodes.length > 0 ? { taskCodes } : null;
};

export const parseGanttDepthPruneIntent = (message: string) => {
  if (!/(删除|清理|移除).*(任务|甘特)|(任务|甘特).*(删除|清理|移除)/u.test(message)) return null;
  const depthMatch = message.match(/第?\s*(\d+|一|二|三|四|五|六|七|八|九|十)\s*层(?:级)?(?:及|和|以及)?(?:以)?(?:下|后|更深)?/u);
  if (!depthMatch || !/(全部|所有|及|更深|以下|后)/u.test(message)) return null;
  const numberMap: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const minimumDepth = numberMap[depthMatch[1]] ?? Number(depthMatch[1]);
  return Number.isInteger(minimumDepth) && minimumDepth > 0 ? { minimumDepth } : null;
};

export const parseHierarchyIntent = (message: string) => {
  const taskCodes = Array.from(new Set([...message.matchAll(/Task\d+(?:\.\d+)*/gi)].map((match) => match[0])));
  if (taskCodes.length === 0) return null;
  if (/(上移(?:一个)?层级|提升(?:一个)?层级|取消缩进|升级为父级|减少缩进)/u.test(message)) {
    return { taskCodes, direction: "OUTDENT" as const };
  }
  if (/(下移(?:一个)?层级|降低(?:一个)?层级|设为.*子任务|变为.*子任务|增加缩进|缩进)/u.test(message)) {
    return { taskCodes, direction: "INDENT" as const };
  }
  return null;
};

export const parseGanttParentWrapIntent = (message: string) => {
  const requestsParent = /(创建|新增|新建|添加|加)(?:一个|一条)?(?:总)?父(?:级)?任务|父(?:级)?任务.{0,12}(创建|新增|新建|添加|加)/u.test(message);
  const targetsCurrentRoots = /(当前|现有|全部|所有).{0,12}(一级|顶级|根级|最上层).{0,8}(甘特)?任务/u.test(message);
  if (!requestsParent || !targetsCurrentRoots) return null;

  const quotedName = message.match(/[“"'《]([^”"'》]{1,100})[”"'》]/u)?.[1]?.trim();
  const inlineName = message.match(/父(?:级)?任务(?:名称)?\s*(?:为|叫|是|[:：])?\s*([^，。；;\n]{1,100})/u)?.[1]
    ?.replace(/^(一个|一条)\s*/u, "")
    .trim();
  const taskName = (quotedName || inlineName || "")
    .replace(/(?:并|然后|同时)?\s*(?:把|将)\s*(?:当前|现有|全部|所有)[\s\S]*$/u, "")
    .trim();
  return taskName ? { taskName } : null;
};

const weeklyStatusByLabel: Record<string, string> = {
  "待开始": "PENDING",
  "未开始": "PENDING",
  "进行中": "IN_PROGRESS",
  "已完成": "DONE",
  "完成": "DONE",
};

const weeklyStatusLabel: Record<string, string> = {
  PENDING: "未开始",
  IN_PROGRESS: "进行中",
  DONE: "已完成",
};

export const parseWeeklyItemUpdateIntent = (message: string) => {
  const matterCode = message.match(/Matter\d+/i)?.[0];
  if (!matterCode) return null;
  const statusLabel = message.match(/(?:状态\s*(?:改为|更新为|设置为|设为)?|改为|更新为|设置为|设为)\s*(待开始|未开始|进行中|已完成|完成(?!度))/u)?.[1];
  const progressText = message.match(/(?:进度|完成度)\s*(?:改为|更新为|设置为|到)?\s*(\d{1,3})\s*%?/u)?.[1];
  const progress = progressText === undefined ? undefined : Number(progressText);
  if (!statusLabel && progress === undefined) return null;
  if (progress !== undefined && (!Number.isFinite(progress) || progress < 0 || progress > 100)) return null;
  return {
    matterCode,
    status: statusLabel ? weeklyStatusByLabel[statusLabel] : undefined,
    progress,
  };
};

export const parseTodoCompletionTarget = (message: string) => {
  if (!/(完成|关闭|办结).*(待办)|待办.*(完成|关闭|办结)/u.test(message)) return null;
  const target = message
    .replace(/^(请|帮我|麻烦)?\s*(?:把|将)?\s*(完成|关闭|办结)\s*(?:项目)?待办\s*[:：]?/u, "")
    .replace(/^(请|帮我|麻烦)?\s*(?:把|将)?\s*(?:项目)?待办\s*/u, "")
    .replace(/\s*(?:标记为|设置为|改为|更新为)?\s*(?:已完成|完成|关闭|办结)\s*$/u, "")
    .replace(/[“”"'：:]/g, "")
    .trim();
  return target || null;
};

export const parseTodoDeleteTarget = (message: string) => {
  if (!/(删除|移除).*(待办)|待办.*(删除|移除)/u.test(message)) return null;
  const target = message
    .replace(/^(请|帮我|麻烦)?\s*(?:把|将)?\s*(?:删除|移除)\s*(?:项目)?待办\s*[:：]?/u, "")
    .replace(/^(请|帮我|麻烦)?\s*(?:把|将)?\s*(?:项目)?待办\s*/u, "")
    .replace(/\s*(?:删除|移除)\s*$/u, "")
    .replace(/[“”"'：:]/g, "")
    .trim();
  return target || null;
};

export const parseWeeklyItemCreateIntent = (message: string) => {
  if (!/(创建|新增|新建).{0,12}(事项|项目事项)|(事项|项目事项).{0,12}(创建|新增|新建)/u.test(message)) return null;
  const title = parseCommandField(message, ["事项名称", "事项"])
    || message.match(/[“"']([^”"']{1,200})[”"']/u)?.[1]?.trim()
    || "";
  const owner = parseCommandField(message, ["负责人"]);
  const description = parseCommandField(message, ["详细内容", "事项描述", "描述"]);
  return title && owner ? { title, owner, description: description || undefined } : null;
};

export const parseWeeklyItemDeleteIntent = (message: string) => {
  if (!/(删除|移除).*(事项|Matter)|(事项|Matter).*(删除|移除)/u.test(message)) return null;
  const matterCode = message.match(/Matter\d+/i)?.[0];
  return matterCode ? { matterCode } : null;
};

const riskStatuses = ["识别中", "跟踪中", "处理中", "已关闭"] as const;

export const parseRiskStatusUpdateIntent = (message: string) => {
  const riskCode = message.match(/Risk\d+/i)?.[0];
  const status = riskStatuses.find((candidate) => message.includes(candidate));
  return riskCode && status ? { riskCode, status } : null;
};

export const parseRiskDeleteIntent = (message: string) => {
  if (!/(删除|移除).*(风险|Risk)|(风险|Risk).*(删除|移除)/u.test(message)) return null;
  const riskCode = message.match(/Risk\d+/i)?.[0];
  return riskCode ? { riskCode } : null;
};

export const parseRiskCreationName = (message: string) => {
  if (isContextualRiskRegistrationRequest(message)) return null;
  if (!/(创建|新增|新建|登记).{0,8}风险|风险.{0,8}(创建|新增|新建|登记)/u.test(message)) return null;
  if (/(分析结论|计划分析|冲突).*(转为|创建|新增|登记).*风险/u.test(message)) return null;
  const name = message
    .replace(/^(请|帮我|麻烦)?\s*(?:创建|新增|新建|登记)\s*(?:一个|一条)?\s*(?:项目)?风险\s*[:：]?/u, "")
    .replace(/^(请|帮我|麻烦)?\s*(?:把|将)?\s*风险\s*/u, "")
    .replace(/\s*(?:创建|新增|新建|登记)\s*$/u, "")
    .replace(/[“”"']/g, "")
    .trim();
  return name && name.length <= 200 ? name : null;
};

export const isScheduleMergeRequest = (message: string) => (
  /(合并|整合|汇总|合成|合二为一|拼接).{0,20}(进度|计划|排期|附件|文件)|(进度|计划|排期|附件|文件).{0,20}(合并|整合|汇总|合成|合二为一|拼接)/u.test(message)
  && /(生成|制作|导出|下载|可导入|模板|文件|表格|计划)/u.test(message)
);

export const isScheduleConversionRequest = (message: string) => {
  if (/(合并|整合|汇总|合成|合二为一|拼接)/u.test(message)) return false;
  const asksForTransformation = /(输出|导出|下载|转换|转成|转为|整理成|做成|生成|制作)/u.test(message);
  const mentionsScheduleInput = /(mpp|project\s*xml|\.xml|\.xlsx|excel|甘特|进度|计划|排期|附件|文件)/iu.test(message);
  const mentionsSupportedOutput = /(系统.{0,12}(甘特|任务|进度|导入|excel)|甘特.{0,12}(任务|格式|文件|excel)|可导入.{0,12}(格式|文件|excel)|excel)/iu.test(message);
  return asksForTransformation && mentionsScheduleInput && mentionsSupportedOutput;
};

export const isScheduleComparisonRequest = (message: string) => (
  /(对比|比较|分析|检查|核对).{0,24}(当前|现有|实际|甘特|进度|计划)|(当前|现有|实际|甘特|进度|计划).{0,24}(差异|冲突|干涉|影响|偏差)/u.test(message)
  && /(附件|文件|mpp|xml|xlsx|excel|进度|计划)/iu.test(message)
);

export const isScheduleImportRequest = (message: string) => (
  /(导入|写入|加入|同步|录入|应用).{0,24}(wbs|甘特|任务|进度|计划|排期)|(wbs|甘特|任务|进度|计划|排期).{0,24}(导入|写入|加入|同步|录入|应用)/iu.test(message)
  && /(附件|文件|mpp|xml|xls|xlsx|excel|csv|docx|pdf|排期|计划)/iu.test(message)
);

const PROJECT_STATUS_VALUES = Object.values(ProjectStatus) as string[];

const normalizeProjectStatus = (value: unknown): ProjectStatus | null => {
  const normalized = String(value || "").trim().toUpperCase();
  return PROJECT_STATUS_VALUES.includes(normalized) ? normalized as ProjectStatus : null;
};

export const parseProjectStatusApprovalIntent = (message: string): { targetStatus: ProjectStatus } | null => {
  const text = String(message || "").trim();
  if (!/(项目|当前项目)/u.test(text)) return null;
  const requestsChange = /(申请|提交|发起|帮我|将|把|设为|改为|启动|作废|恢复|结项|完成)/u.test(text);
  if (!requestsChange) return null;
  if (/(恢复|改为|设为).{0,8}草稿|草稿状态/u.test(text)) return { targetStatus: ProjectStatus.DRAFT };
  if (/(启动|开始|恢复|重新启动).{0,10}项目|项目.{0,10}(启动|开始|恢复|进行中)/u.test(text)) return { targetStatus: ProjectStatus.IN_PROGRESS };
  if (/(完成|结项|结束).{0,10}项目|项目.{0,10}(完成|结项|已完成)/u.test(text)) return { targetStatus: ProjectStatus.COMPLETED };
  if (/(作废|取消).{0,10}项目|项目.{0,10}(作废|已作废)/u.test(text)) return { targetStatus: ProjectStatus.VOIDED };
  return null;
};

export const isWbsBaselineApprovalRequest = (message: string) => (
  /(申请|提交|发起|发布|固化).{0,16}(wbs|甘特|项目计划).{0,8}基线|(wbs|甘特|项目计划).{0,12}基线.{0,8}(申请|提交|发起|发布|固化)/iu.test(message)
);

const normalizeApprovalAction = (value: unknown): "approve" | "reject" | "return" | null => {
  const normalized = String(value || "").trim().toLowerCase();
  if (["approve", "同意", "通过", "批准"].includes(normalized)) return "approve";
  if (["reject", "拒绝", "驳回", "不通过"].includes(normalized)) return "reject";
  if (["return", "退回", "退回修改"].includes(normalized)) return "return";
  return null;
};

export const parseApprovalProcessIntent = (message: string) => {
  const text = String(message || "").trim();
  if (!/(审批|审核|流程)/u.test(text)) return null;
  const action = /(拒绝|驳回|不通过)/u.test(text)
    ? "reject" as const
    : /(退回修改|退回)/u.test(text)
      ? "return" as const
      : /(同意|通过|批准)/u.test(text)
        ? "approve" as const
        : null;
  if (!action) return null;
  const quoted = text.match(/[“"'《]([^”"'》]{1,200})[”"'》]/u)?.[1]?.trim();
  const query = quoted
    || text.match(/(?:同意|通过|批准|拒绝|驳回|不通过|退回修改|退回)\s*(?:这个|该|当前)?\s*([^，。；;]{1,200}?)(?:审批|审核|流程)/u)?.[1]?.trim()
    || "";
  const comment = text.match(/(?:原因|意见|备注|说明)\s*(?:为|[:：])\s*([\s\S]{1,2000})$/u)?.[1]?.trim() || "";
  return { action, approvalQuery: query || undefined, comment: comment || undefined };
};

const parseCollaborationMessageIntent = (message: string) => {
  const text = String(message || "").trim();
  if (!/(协同|会话|消息)/u.test(text) || !/(发送|回复|告诉|留言)/u.test(text)) return null;
  const content = text.match(/(?:发送|回复|告诉|留言)(?:消息)?\s*(?:为|[:：])?\s*[“"']([\s\S]{1,4000})[”"']\s*$/u)?.[1]?.trim()
    || text.match(/(?:发送|回复|留言)(?:消息)?\s*(?:为|[:：])\s*([\s\S]{1,4000})$/u)?.[1]?.trim()
    || "";
  const threadTitle = text.match(/(?:在|向)\s*[“"'《]?([^”"'》，。；;]{1,200})[”"'》]?\s*(?:协同)?(?:会话|群组)/u)?.[1]?.trim() || "";
  return content ? { content, threadTitle: threadTitle || undefined } : null;
};

const ensureProjectAccess = async (user: AuthenticatedUser, projectId: string) => {
  if (user.assignedRoleNames.includes("管理员")) return true;
  return Boolean(await prisma.projectMember.findFirst({
    where: {
      projectId,
      OR: [
        { accountId: user.userId },
        { accountId: null, personName: user.displayName },
      ],
    },
    select: { id: true },
  }));
};

const canUseAssistantTool = async (user: AuthenticatedUser, toolId: string) => {
  const tool = getAssistantToolDefinition(toolId);
  if (!tool) return false;
  return (await Promise.all(tool.permissions.map((permission) => userHasPermission(user, permission)))).every(Boolean);
};

const createProposal = async (params: {
  user: AuthenticatedUser;
  projectId: string;
  toolId: string;
  riskLevel: string;
  args: Record<string, unknown>;
  title: string;
  description: string;
  runtime: AssistantRuntimeConfig;
}) => {
  const contract = getAssistantToolDefinition(params.toolId);
  if (!contract) throw new Error("不支持的 Agent 工具");
  const validation = validateAssistantToolArgs(params.toolId, params.args);
  if (!validation.ok) throw new Error(validation.error);
  const expiresAt = new Date(Date.now() + params.runtime.agentActionExpiryMinutes * 60_000);
  const action = await prisma.assistantActionRun.create({
    data: {
      userId: params.user.userId,
      username: params.user.username,
      displayName: params.user.displayName,
      projectId: params.projectId,
      toolId: params.toolId,
      toolVersion: contract.version,
      riskLevel: contract.riskLevel,
      argsJson: JSON.stringify(params.args),
      previewJson: JSON.stringify({ title: params.title, description: params.description }),
      idempotencyKey: randomUUID(),
      expiresAt,
    },
  });
  return serializeAssistantAction(action);
};

const countAssistantProjectExportRows = async (
  projectId: string,
  intent: AssistantProjectExportIntent,
) => {
  if (intent.exportType === "gantt") {
    const rows = await prisma.projectGanttTask.findMany({
      where: { projectId },
      select: { id: true, parentId: true, taskCode: true, taskCategory: true, taskName: true, sortOrder: true, createdAt: true, progress: true },
    });
    return selectGanttExportRows(rows, intent).length;
  }
  if (intent.exportType === "weekly") {
    const rows = await prisma.weeklyItem.findMany({
      where: { projectId },
      select: { priority: true, progress: true },
    });
    return selectWeeklyExportRows(rows, intent).length;
  }
  if (intent.exportType === "risk") return prisma.riskRegisterItem.count({ where: { projectId } });
  if (intent.exportType === "budget") return prisma.projectBudgetItem.count({ where: { projectId } });
  return 0;
};

export const proposeAssistantAction = async (params: {
  message: string;
  projectId: string;
  user: AuthenticatedUser;
  runtime: AssistantRuntimeConfig;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  attachmentIds?: string[];
  expectedToolId?: string;
  plannedArgs?: Record<string, unknown>;
}): Promise<AssistantActionView | null> => {
  if (!params.runtime.agentEnabled || !params.projectId) return null;
  if (!(await ensureProjectAccess(params.user, params.projectId))) return null;
  const enabled = new Set(params.runtime.agentEnabledToolIds);
  const allowed = new Set((await Promise.all([...enabled].map(async (toolId) => ({
    toolId,
    allowed: await canUseAssistantTool(params.user, toolId),
  })))).filter((item) => item.allowed).map((item) => item.toolId));
  const canUse = (toolId: string) => allowed.has(toolId) && (!params.expectedToolId || params.expectedToolId === toolId);

  const plannedProjectStatus = params.expectedToolId === "approval.project-status.request"
    ? normalizeProjectStatus(params.plannedArgs?.targetStatus)
    : null;
  const requestedProjectStatus = plannedProjectStatus ?? parseProjectStatusApprovalIntent(params.message)?.targetStatus ?? null;
  if (canUse("approval.project-status.request") && requestedProjectStatus) {
    const project = await prisma.project.findUnique({
      where: { id: params.projectId },
      select: { id: true, name: true, status: true },
    });
    if (!project) return null;
    assertProjectStatusTransition(project.status, requestedProjectStatus);
    const permission = projectStatusActionPermission(project.status, requestedProjectStatus);
    if (!(await userHasPermission(params.user, permission))) return null;
    return createProposal({
      ...params,
      toolId: "approval.project-status.request",
      riskLevel: "MEDIUM",
      args: { targetStatus: requestedProjectStatus },
      title: "申请项目状态变更",
      description: `申请将项目“${project.name}”从“${PROJECT_STATUS_LABEL[project.status as ProjectStatus] ?? project.status}”变更为“${PROJECT_STATUS_LABEL[requestedProjectStatus] ?? requestedProjectStatus}”；审批通过后才会更新项目状态`,
    });
  }

  if (canUse("approval.wbs-baseline.request") && (params.expectedToolId === "approval.wbs-baseline.request" || isWbsBaselineApprovalRequest(params.message))) {
    const [project, taskCount] = await Promise.all([
      prisma.project.findUnique({
        where: { id: params.projectId },
        select: { name: true, status: true, ganttRevision: true },
      }),
      prisma.projectGanttTask.count({ where: { projectId: params.projectId } }),
    ]);
    if (!project || taskCount === 0 || [ProjectStatus.COMPLETED, ProjectStatus.VOIDED].includes(project.status as ProjectStatus)) return null;
    return createProposal({
      ...params,
      toolId: "approval.wbs-baseline.request",
      riskLevel: "MEDIUM",
      args: {},
      title: "申请发布 WBS 基线",
      description: `申请发布项目“${project.name}”当前第 ${project.ganttRevision} 版 WBS 基线，共 ${taskCount} 条任务；审批通过后固化当前计划数据`,
    });
  }

  const plannedApprovalAction = params.expectedToolId === "approval.process"
    ? normalizeApprovalAction(params.plannedArgs?.action)
    : null;
  const requestedApprovalAction: {
    action: "approve" | "reject" | "return";
    instanceId?: string;
    approvalQuery?: string;
    comment?: string;
  } | null = plannedApprovalAction
    ? {
        action: plannedApprovalAction,
        instanceId: String(params.plannedArgs?.instanceId || "").trim() || undefined,
        approvalQuery: String(params.plannedArgs?.approvalQuery || "").trim() || undefined,
        comment: String(params.plannedArgs?.comment || "").trim() || undefined,
      }
    : parseApprovalProcessIntent(params.message);
  if (canUse("approval.process") && requestedApprovalAction) {
    if (requestedApprovalAction.action !== "approve" && !requestedApprovalAction.comment) return null;
    const targetWhere = requestedApprovalAction.instanceId
      ? { id: requestedApprovalAction.instanceId }
      : requestedApprovalAction.approvalQuery
        ? {
            OR: [
              { title: { contains: requestedApprovalAction.approvalQuery, mode: "insensitive" as const } },
              { summary: { contains: requestedApprovalAction.approvalQuery, mode: "insensitive" as const } },
            ],
          }
        : {};
    const matches = await prisma.approvalWorkflowInstance.findMany({
      where: {
        projectId: params.projectId,
        status: "PENDING",
        ...targetWhere,
        nodes: {
          some: {
            status: "PENDING",
            assignments: { some: { accountId: params.user.userId, status: "PENDING" } },
          },
        },
      },
      orderBy: { requestedAt: "desc" },
      take: 2,
      select: { id: true, title: true },
    });
    if (matches.length !== 1) return null;
    const actionLabel = requestedApprovalAction.action === "approve" ? "同意" : requestedApprovalAction.action === "reject" ? "拒绝" : "退回";
    return createProposal({
      ...params,
      toolId: "approval.process",
      riskLevel: "HIGH",
      args: {
        action: requestedApprovalAction.action,
        instanceId: matches[0].id,
        ...(requestedApprovalAction.comment ? { comment: requestedApprovalAction.comment } : {}),
      },
      title: `${actionLabel}本人待审批流程`,
      description: `${actionLabel}审批“${matches[0].title}”${requestedApprovalAction.comment ? `，意见：${requestedApprovalAction.comment}` : ""}；执行时会再次校验审批节点和审批人`,
    });
  }

  const plannedCollaborationMessage = params.expectedToolId === "collaboration.message"
    ? {
        content: String(params.plannedArgs?.content || "").trim(),
        threadId: String(params.plannedArgs?.threadId || "").trim() || undefined,
        threadTitle: String(params.plannedArgs?.threadTitle || "").trim() || undefined,
        mentionAccountIds: Array.isArray(params.plannedArgs?.mentionAccountIds)
          ? params.plannedArgs.mentionAccountIds.map(String).map((item) => item.trim()).filter(Boolean)
          : [],
      }
    : null;
  const requestedCollaborationMessage: {
    content: string;
    threadId?: string;
    threadTitle?: string;
    mentionAccountIds?: string[];
  } | null = plannedCollaborationMessage?.content
    ? plannedCollaborationMessage
    : parseCollaborationMessageIntent(params.message);
  if (canUse("collaboration.message") && requestedCollaborationMessage?.content) {
    const threadWhere = requestedCollaborationMessage.threadId
      ? { id: requestedCollaborationMessage.threadId }
      : requestedCollaborationMessage.threadTitle
        ? { title: { contains: requestedCollaborationMessage.threadTitle, mode: "insensitive" as const } }
        : {};
    const matches = await prisma.collaborationThread.findMany({
      where: {
        projectId: params.projectId,
        closedAt: null,
        ...threadWhere,
        participants: { some: { accountId: params.user.userId } },
      },
      orderBy: { lastMessageAt: "desc" },
      take: 2,
      select: {
        id: true,
        title: true,
        participants: { select: { accountId: true } },
      },
    });
    if (matches.length !== 1) return null;
    const participantIds = new Set(matches[0].participants.map((participant) => participant.accountId));
    const mentionAccountIds = Array.from(new Set<string>(requestedCollaborationMessage.mentionAccountIds ?? []))
      .filter((accountId) => participantIds.has(accountId));
    return createProposal({
      ...params,
      toolId: "collaboration.message",
      riskLevel: "MEDIUM",
      args: {
        threadId: matches[0].id,
        content: requestedCollaborationMessage.content,
        ...(mentionAccountIds.length > 0 ? { mentionAccountIds } : {}),
      },
      title: "发送项目协同消息",
      description: `向协同会话“${matches[0].title}”发送：${requestedCollaborationMessage.content.slice(0, 160)}${requestedCollaborationMessage.content.length > 160 ? "…" : ""}`,
    });
  }

  if (canUse("schedule.import.preview") && isScheduleImportRequest(params.message)) {
    const requestedIds = Array.from(new Set((params.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean)));
    if (requestedIds.length === 1) {
      const attachment = await prisma.assistantAttachment.findFirst({
        where: { id: requestedIds[0], projectId: params.projectId, userId: params.user.userId, status: "READY" },
        select: { id: true, originalName: true },
      });
      const extension = extname(attachment?.originalName || "").toLocaleLowerCase("en-US");
      if (attachment && SCHEDULE_IMPORT_EXTENSIONS.includes(extension as typeof SCHEDULE_IMPORT_EXTENSIONS[number])) {
        const hierarchyMode = /扁平|不要(?:生成|创建).{0,8}(?:层级|父任务|分类节点)/u.test(params.message) ? "FLAT" : "AUTO";
        return createProposal({
          ...params,
          toolId: "schedule.import.preview",
          riskLevel: "LOW",
          args: { attachmentId: attachment.id, statusDate: new Date().toISOString().slice(0, 10), hierarchyMode },
          title: "生成 WBS 导入预览",
          description: `解析「${attachment.originalName}」，生成层级、日期、工期、依赖、任务匹配和冲突预览；本步骤不会修改当前 WBS`,
        });
      }
    }
  }

  if (canUse("schedule.compare.file") && isScheduleComparisonRequest(params.message)) {
    const requestedIds = Array.from(new Set((params.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean)));
    if (requestedIds.length === 1) {
      const attachment = await prisma.assistantAttachment.findFirst({
        where: { id: requestedIds[0], projectId: params.projectId, userId: params.user.userId, status: "READY" },
        select: { id: true, originalName: true },
      });
      const extension = extname(attachment?.originalName || "").toLocaleLowerCase("en-US");
      if (attachment && SCHEDULE_IMPORT_EXTENSIONS.includes(extension as typeof SCHEDULE_IMPORT_EXTENSIONS[number])) {
        const statusDate = new Date().toISOString().slice(0, 10);
        return createProposal({
          ...params,
          toolId: "schedule.compare.file",
          riskLevel: "LOW",
          args: { attachmentId: attachment.id, statusDate },
          title: "对比上传计划与当前进度",
          description: `解析「${attachment.originalName}」，与当前甘特任务对比并生成差异、冲突、干涉和影响链；不会修改当前计划`,
        });
      }
    }
  }

  if (canUse("schedule.convert.file") && isScheduleConversionRequest(params.message)) {
    const requestedIds = Array.from(new Set((params.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean))).slice(0, 5);
    if (requestedIds.length === 1) {
      const attachment = await prisma.assistantAttachment.findFirst({
        where: { id: requestedIds[0], projectId: params.projectId, userId: params.user.userId, status: "READY" },
        select: { id: true, originalName: true },
      });
      const extension = extname(attachment?.originalName || "").toLocaleLowerCase("en-US");
      if (attachment && SCHEDULE_CONVERT_EXTENSIONS.includes(extension as typeof SCHEDULE_CONVERT_EXTENSIONS[number])) {
        return createProposal({
          ...params,
          toolId: "schedule.convert.file",
          riskLevel: "LOW",
          args: { attachmentId: attachment.id },
          title: "转换进度计划文件",
          description: `将「${attachment.originalName}」转换为系统可导入 Excel，并校验转换后的任务数量；不会直接写入项目进度`,
        });
      }
    }
  }

  if (canUse("schedule.merge.files") && isScheduleMergeRequest(params.message)) {
    const requestedIds = Array.from(new Set((params.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean))).slice(0, 5);
    if (requestedIds.length >= 2) {
      const attachments = await prisma.assistantAttachment.findMany({
        where: { id: { in: requestedIds }, projectId: params.projectId, userId: params.user.userId, status: "READY" },
        select: { id: true, originalName: true },
      });
      const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
      const ordered = requestedIds.map((id) => attachmentById.get(id)).filter((attachment): attachment is NonNullable<typeof attachment> => Boolean(attachment));
      const supported = ordered.filter((attachment) => SCHEDULE_MERGE_EXTENSIONS.includes(extname(attachment.originalName).toLocaleLowerCase("en-US") as typeof SCHEDULE_MERGE_EXTENSIONS[number]));
      if (supported.length === requestedIds.length) {
        return createProposal({
          ...params,
          toolId: "schedule.merge.files",
          riskLevel: "LOW",
          args: { attachmentIds: requestedIds },
          title: "合并进度计划文件",
          description: `按原始顺序合并 ${supported.length} 个文件（${supported.map((attachment) => attachment.originalName).join("、")}），统一任务 ID 和依赖关系后生成可导入 Excel；不会直接写入项目进度`,
        });
      }
    }
  }

  if (canUse("document.revision.generate") && isDocumentRevisionRequest(params.message)) {
    const requestedIds = Array.from(new Set((params.attachmentIds ?? []).map((id) => id.trim()).filter(Boolean)));
    if (requestedIds.length === 1) {
      const attachment = await prisma.assistantAttachment.findFirst({
        where: { id: requestedIds[0], projectId: params.projectId, userId: params.user.userId, status: "READY" },
        select: { id: true, originalName: true },
      });
      const tool = getAssistantToolDefinition("document.revision.generate")!;
      const extension = extname(attachment?.originalName || "").toLocaleLowerCase("en-US");
      if (attachment && tool.attachments?.extensions.includes(extension)) {
        return createProposal({
          ...params,
          toolId: "document.revision.generate",
          riskLevel: "LOW",
          args: { attachmentId: attachment.id, instruction: params.message.slice(0, 2000) },
          title: "诊断并生成文档修订稿",
          description: `读取「${attachment.originalName}」，在不编造事实的前提下梳理结构、细化内容并生成独立 Markdown 修订稿`,
        });
      }
    }
  }

  if (canUse("document.revision.save") && /(保存|下载|生成).*(修订稿|修改稿|重写稿|文档)/u.test(params.message)) {
    const latestAssistantContent = [...(params.history ?? [])].reverse().find((item) => item.role === "assistant")?.content.trim() || "";
    const attachment = await prisma.assistantAttachment.findFirst({
      where: { projectId: params.projectId, userId: params.user.userId, status: "READY" },
      orderBy: { createdAt: "desc" },
      select: { id: true, originalName: true },
    });
    if (attachment && latestAssistantContent) {
      return createProposal({
        ...params,
        toolId: "document.revision.save",
        riskLevel: "LOW",
        args: { attachmentId: attachment.id, content: latestAssistantContent, instruction: params.message },
        title: "保存文档修订稿",
        description: `将上一条助手回答保存为「${attachment.originalName}」的独立 Markdown 修订稿`,
      });
    }
  }

  if (canUse("schedule.analysis.export") && /(导出|下载).*(差异|冲突|计划分析|影响链)/u.test(params.message)) {
    const run = await prisma.scheduleAnalysisRun.findFirst({
      where: { projectId: params.projectId, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
      select: { id: true, sourceFileName: true },
    });
    if (run) {
      return createProposal({
        ...params,
        toolId: "schedule.analysis.export",
        riskLevel: "LOW",
        args: { analysisRunId: run.id },
        title: "导出计划分析",
        description: `导出「${run.sourceFileName || "最新计划"}」的差异、冲突和影响链报告`,
      });
    }
  }

  if (canUse("risk.create.from-analysis") && /(冲突|分析结论|问题).*(创建|新建|转为).*风险|风险.*(创建|新建|转为).*(冲突|分析)/u.test(params.message)) {
    const run = await prisma.scheduleAnalysisRun.findFirst({ where: { projectId: params.projectId, status: "COMPLETED" }, orderBy: { createdAt: "desc" } });
    const result = run ? parseJson(run.resultJson) : {};
    const issue = Array.isArray(result.issues)
      ? result.issues.find((item) => item && typeof item === "object" && (item as { severity?: unknown }).severity === "ERROR") || result.issues[0]
      : null;
    if (run && issue && typeof issue === "object") {
      const value = issue as Record<string, unknown>;
      const taskCodes = Array.isArray(value.taskCodes) ? value.taskCodes.map(String) : [];
      return createProposal({
        ...params,
        toolId: "risk.create.from-analysis",
        riskLevel: "MEDIUM",
        args: { analysisRunId: run.id, issue: value },
        title: "从计划分析创建风险",
        description: `${taskCodes.join("、") || "计划"}：${String(value.message || "计划冲突")}`,
      });
    }
  }

  if (canUse("todo.create.batch") && /(建议|冲突|分析结论).*(创建|生成|转为).*待办|待办.*(创建|生成|转为).*(建议|冲突|分析)/u.test(params.message)) {
    const run = await prisma.scheduleAnalysisRun.findFirst({ where: { projectId: params.projectId, status: "COMPLETED" }, orderBy: { createdAt: "desc" } });
    const result = run ? parseJson(run.resultJson) : {};
    const issues = Array.isArray(result.issues) ? result.issues.filter((item) => item && typeof item === "object").slice(0, 20) as Record<string, unknown>[] : [];
    if (run && issues.length > 0) {
      const items = issues.map((issue) => ({
        title: `处理${Array.isArray(issue.taskCodes) && issue.taskCodes.length > 0 ? ` ${issue.taskCodes.map(String).join("、")}` : "计划"}：${String(issue.message || "计划冲突")}`.slice(0, 200),
        detail: String(issue.suggestion || "请核对计划分析结论并制定处理方案"),
      }));
      return createProposal({
        ...params,
        toolId: "todo.create.batch",
        riskLevel: "MEDIUM",
        args: { analysisRunId: run.id, items },
        title: "创建计划整改待办",
        description: `从最新分析生成 ${items.length} 条本人整改待办`,
      });
    }
  }

  const todoCompletionTarget = parseTodoCompletionTarget(params.message);
  if (canUse("todo.complete") && todoCompletionTarget) {
    const matches = await prisma.todoItem.findMany({
      where: {
        projectId: params.projectId,
        status: "OPEN",
        title: { contains: todoCompletionTarget, mode: "insensitive" },
      },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, title: true },
    });
    if (matches.length === 1) {
      return createProposal({
        ...params,
        toolId: "todo.complete",
        riskLevel: "MEDIUM",
        args: { todoId: matches[0].id },
        title: "完成项目待办",
        description: `将待办「${matches[0].title}」标记为已完成`,
      });
    }
  }

  if (canUse("todo.create") && /(创建|新增|新建).*(待办)|待办.*(创建|新增|新建)/u.test(params.message)) {
    const title = cleanTitle(params.message);
    if (!title || title.length > 200) return null;
    return createProposal({
      ...params,
      toolId: "todo.create",
      riskLevel: "MEDIUM",
      args: { title, targetPersonName: params.user.displayName },
      title: "创建项目待办",
      description: `为 ${params.user.displayName} 创建待办「${title}」`,
    });
  }

  const todoDeleteTarget = parseTodoDeleteTarget(params.message);
  if (canUse("todo.delete") && todoDeleteTarget) {
    const matches = await prisma.todoItem.findMany({
      where: { projectId: params.projectId, title: { contains: todoDeleteTarget, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, title: true },
    });
    if (matches.length === 1) {
      return createProposal({
        ...params,
        toolId: "todo.delete",
        riskLevel: "HIGH",
        args: { todoId: matches[0].id },
        title: "删除项目待办",
        description: `删除待办「${matches[0].title}」`,
      });
    }
  }

  const requestedResourceOptimization = parseResourceOptimizationIntent(params.message);
  const plannedResourceCandidate = params.expectedToolId === "gantt.resource.optimize"
    ? normalizeResourceScheduleCandidateKind(params.plannedArgs?.candidateKind)
    : null;
  const resourceCandidateKind = plannedResourceCandidate ?? requestedResourceOptimization?.candidateKind ?? null;
  if (canUse("gantt.resource.optimize") && resourceCandidateKind) {
    const { context, result } = await resourceScheduleAnalysis(params.projectId);
    const candidate = result.candidates.find((item) => item.kind === resourceCandidateKind);
    if (candidate) {
      const remainingText = candidate.remainingConflicts.length > 0
        ? `，应用后仍有 ${candidate.remainingConflicts.length} 组受固定日期、进行中任务或跨项目占用限制的冲突`
        : "，应用后当前检测范围内不再存在资源时间冲突";
      return createProposal({
        ...params,
        toolId: "gantt.resource.optimize",
        riskLevel: "MEDIUM",
        args: {
          candidateKind: resourceCandidateKind,
          revision: context.currentProject.ganttRevision,
          snapshotHash: result.snapshotHash,
        },
        title: "应用正式自动排期",
        description: `将按 T0、FS 紧前关系、日历、负责人容量和硬边界计算并调整 ${candidate.changes.length} 个未开始叶子任务，累计移动 ${candidate.metrics.totalShiftDays} 天，预计完成日期 ${candidate.metrics.completionDate || "未确定"}${remainingText}；确认时会再次校验 WBS 版本，过期方案不会写入`,
      });
    }
  }

  const depthPruneIntent = parseGanttDepthPruneIntent(params.message);
  if (canUse("gantt.depth.prune") && depthPruneIntent) {
    const count = await prisma.projectGanttTask.count({ where: { projectId: params.projectId } });
    if (count > 0) {
      return createProposal({
        ...params,
        toolId: "gantt.depth.prune",
        riskLevel: "HIGH",
        args: { minimumDepth: depthPruneIntent.minimumDepth },
        title: "按层级清理甘特任务",
        description: `删除当前项目第 ${depthPruneIntent.minimumDepth} 层及更深的全部甘特任务；第 ${Math.max(0, depthPruneIntent.minimumDepth - 1)} 层及更高层级会保留，并重新编号`,
      });
    }
  }

  const ganttTaskDeleteIntent = parseGanttTaskDeleteIntent(params.message);
  if (canUse("gantt.task.delete") && ganttTaskDeleteIntent) {
    const tasks = await prisma.projectGanttTask.findMany({
      where: { projectId: params.projectId, taskCode: { in: ganttTaskDeleteIntent.taskCodes, mode: "insensitive" } },
      select: { id: true, taskCode: true, taskName: true },
    });
    if (tasks.length === ganttTaskDeleteIntent.taskCodes.length) {
      return createProposal({
        ...params,
        toolId: "gantt.task.delete",
        riskLevel: "HIGH",
        args: { taskIds: tasks.map((task) => task.id) },
        title: "删除甘特任务",
        description: `删除 ${tasks.map((task) => `${task.taskCode} ${task.taskName}`).join("、")} 及其全部子任务，并重新编号`,
      });
    }
  }

  const ganttTaskCreateIntent = parseGanttTaskCreateIntent(params.message);
  if (canUse("gantt.task.create") && ganttTaskCreateIntent) {
    const parent = ganttTaskCreateIntent.parentTaskCode
      ? await prisma.projectGanttTask.findFirst({
          where: { projectId: params.projectId, taskCode: { equals: ganttTaskCreateIntent.parentTaskCode, mode: "insensitive" } },
          select: { id: true, taskCode: true, taskName: true },
        })
      : null;
    if (!ganttTaskCreateIntent.parentTaskCode || parent) {
      return createProposal({
        ...params,
        toolId: "gantt.task.create",
        riskLevel: "MEDIUM",
        args: {
          taskName: ganttTaskCreateIntent.taskName,
          startDate: ganttTaskCreateIntent.startDate,
          durationDays: ganttTaskCreateIntent.durationDays,
          ...(parent ? { parentTaskId: parent.id } : {}),
        },
        title: "新增甘特任务",
        description: `新增任务「${ganttTaskCreateIntent.taskName}」：计划开始 ${ganttTaskCreateIntent.startDate}，工期 ${ganttTaskCreateIntent.durationDays} 天${parent ? `，父任务为 ${parent.taskCode} ${parent.taskName}` : ""}；任务类别由层级自动生成`,
      });
    }
  }

  const ganttTaskTextUpdateIntent = parseGanttTaskTextUpdateIntent(params.message);
  if (canUse("gantt.task.update") && ganttTaskTextUpdateIntent) {
    const task = await prisma.projectGanttTask.findFirst({
      where: { projectId: params.projectId, taskCode: { equals: ganttTaskTextUpdateIntent.taskCode, mode: "insensitive" } },
      select: { id: true, taskCode: true, taskName: true },
    });
    if (task) {
      const args = {
        taskId: task.id,
        ...(ganttTaskTextUpdateIntent.taskName ? { taskName: ganttTaskTextUpdateIntent.taskName } : {}),
        ...(ganttTaskTextUpdateIntent.taskDescription ? { taskDescription: ganttTaskTextUpdateIntent.taskDescription } : {}),
        ...(ganttTaskTextUpdateIntent.remark ? { remark: ganttTaskTextUpdateIntent.remark } : {}),
      };
      return createProposal({
        ...params,
        toolId: "gantt.task.update",
        riskLevel: "MEDIUM",
        args,
        title: "修改甘特任务",
        description: `更新 ${task.taskCode} ${task.taskName} 的${ganttTaskTextUpdateIntent.taskName ? "名称" : ganttTaskTextUpdateIntent.taskDescription ? "任务描述" : "备注"}`,
      });
    }
  }

  const progressIntent = parseProgressIntent(params.message);
  if (canUse("gantt.progress.update") && progressIntent) {
    const task = await prisma.projectGanttTask.findFirst({
      where: { projectId: params.projectId, taskCode: { equals: progressIntent.taskCode, mode: "insensitive" } },
      select: { id: true, taskCode: true, taskName: true, progress: true },
    });
    if (!task) return null;
    return createProposal({
      ...params,
      toolId: "gantt.progress.update",
      riskLevel: "MEDIUM",
      args: { taskId: task.id, progress: progressIntent.progress },
      title: "更新任务进度",
      description: `${task.taskCode} ${task.taskName}：${task.progress}% → ${progressIntent.progress}%`,
    });
  }

  const parentWrapIntent = parseGanttParentWrapIntent(params.message);
  if (canUse("gantt.parent.wrap") && parentWrapIntent) {
    const rootTasks = await prisma.projectGanttTask.findMany({
      where: { projectId: params.projectId, parentId: null },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, taskCode: true, taskName: true },
    });
    if (rootTasks.length > 0) {
      return createProposal({
        ...params,
        toolId: "gantt.parent.wrap",
        riskLevel: "MEDIUM",
        args: { taskName: parentWrapIntent.taskName, childTaskIds: rootTasks.map((task) => task.id) },
        title: "创建任务总父级",
        description: `创建一级父任务「${parentWrapIntent.taskName}」，并将当前 ${rootTasks.length} 个一级任务及其全部子任务纳入其下`,
      });
    }
  }

  const hierarchyIntent = parseHierarchyIntent(params.message);
  const hierarchyToolId = hierarchyIntent?.direction === "OUTDENT"
    ? "gantt.hierarchy.outdent"
    : "gantt.hierarchy.indent";
  if (hierarchyIntent && canUse(hierarchyToolId)) {
    const tasks = await prisma.projectGanttTask.findMany({
      where: {
        projectId: params.projectId,
        taskCode: { in: hierarchyIntent.taskCodes, mode: "insensitive" },
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, taskCode: true, taskName: true },
    });
    if (tasks.length === hierarchyIntent.taskCodes.length) {
      return createProposal({
        ...params,
        toolId: hierarchyToolId,
        riskLevel: "MEDIUM",
        args: { taskIds: tasks.map((task) => task.id), direction: hierarchyIntent.direction },
        title: hierarchyIntent.direction === "OUTDENT" ? "上移任务层级" : "下移任务层级",
        description: `${tasks.map((task) => `${task.taskCode} ${task.taskName}`).join("、")}及其全部子任务将${hierarchyIntent.direction === "OUTDENT" ? "上移一个层级" : "下移到上一条同级任务下"}`,
      });
    }
  }

  const weeklyIntent = parseWeeklyItemUpdateIntent(params.message);
  if (canUse("weekly.status.update") && weeklyIntent) {
    const item = await prisma.weeklyItem.findFirst({
      where: { projectId: params.projectId, matterCode: { equals: weeklyIntent.matterCode, mode: "insensitive" } },
      select: { id: true, matterCode: true, title: true, status: true, progress: true },
    });
    if (item) {
      const currentStatus = itemStatusFromProgress(item.progress);
      const nextProgress = weeklyIntent.progress
        ?? (weeklyIntent.status === "DONE"
          ? 100
          : weeklyIntent.status === "PENDING"
            ? 0
            : weeklyIntent.status === "IN_PROGRESS" && item.progress > 0 && item.progress < 100
              ? item.progress
              : undefined);
      if (nextProgress === undefined) return null;
      const nextStatus = itemStatusFromProgress(nextProgress);
      return createProposal({
        ...params,
        toolId: "weekly.status.update",
        riskLevel: "MEDIUM",
        args: { weeklyItemId: item.id, progress: nextProgress },
        title: "更新项目事项",
        description: `${item.matterCode} ${item.title}：${weeklyStatusLabel[currentStatus]} / ${item.progress}% → ${weeklyStatusLabel[nextStatus]} / ${nextProgress}%`,
      });
    }
  }

  const weeklyCreateIntent = parseWeeklyItemCreateIntent(params.message);
  if (canUse("weekly.item.create") && weeklyCreateIntent) {
    return createProposal({
      ...params,
      toolId: "weekly.item.create",
      riskLevel: "MEDIUM",
      args: weeklyCreateIntent,
      title: "新增项目事项",
      description: `创建事项「${weeklyCreateIntent.title}」，负责人 ${weeklyCreateIntent.owner}`,
    });
  }

  const weeklyDeleteIntent = parseWeeklyItemDeleteIntent(params.message);
  if (canUse("weekly.item.delete") && weeklyDeleteIntent) {
    const item = await prisma.weeklyItem.findFirst({
      where: { projectId: params.projectId, matterCode: { equals: weeklyDeleteIntent.matterCode, mode: "insensitive" } },
      select: { id: true, matterCode: true, title: true },
    });
    if (item) {
      return createProposal({
        ...params,
        toolId: "weekly.item.delete",
        riskLevel: "HIGH",
        args: { weeklyItemId: item.id },
        title: "删除项目事项",
        description: `删除 ${item.matterCode} ${item.title}，其余事项将按当前排序重新编号`,
      });
    }
  }

  const riskStatusIntent = parseRiskStatusUpdateIntent(params.message);
  if (canUse("risk.status.update") && riskStatusIntent) {
    const risk = await prisma.riskRegisterItem.findFirst({
      where: { projectId: params.projectId, riskCode: { equals: riskStatusIntent.riskCode, mode: "insensitive" } },
      select: { id: true, riskCode: true, riskName: true, status: true },
    });
    if (risk) {
      return createProposal({
        ...params,
        toolId: "risk.status.update",
        riskLevel: "MEDIUM",
        args: { riskId: risk.id, status: riskStatusIntent.status },
        title: "更新风险状态",
        description: `${risk.riskCode} ${risk.riskName}：${risk.status} → ${riskStatusIntent.status}`,
      });
    }
  }

  const riskDeleteIntent = parseRiskDeleteIntent(params.message);
  if (canUse("risk.delete") && riskDeleteIntent) {
    const risk = await prisma.riskRegisterItem.findFirst({
      where: { projectId: params.projectId, riskCode: { equals: riskDeleteIntent.riskCode, mode: "insensitive" } },
      select: { id: true, riskCode: true, riskName: true },
    });
    if (risk) {
      return createProposal({
        ...params,
        toolId: "risk.delete",
        riskLevel: "HIGH",
        args: { riskId: risk.id },
        title: "删除项目风险",
        description: `删除 ${risk.riskCode} ${risk.riskName}，其余风险将按当前排序重新编号`,
      });
    }
  }

  const plannedRiskDrafts = params.expectedToolId === "risk.create.batch"
    ? normalizeAssistantRiskDrafts(params.plannedArgs?.risks)
    : [];
  const contextualRiskDrafts = isContextualRiskRegistrationRequest(params.message)
    ? extractAssistantRiskDrafts(params.history ?? [])
    : [];
  const riskDrafts = contextualRiskDrafts.length > 0 ? contextualRiskDrafts : plannedRiskDrafts;
  if (canUse("risk.create.batch") && riskDrafts.length > 0) {
    const names = riskDrafts.slice(0, 5).map((risk) => risk.riskName).join("、");
    return createProposal({
      ...params,
      toolId: "risk.create.batch",
      riskLevel: "MEDIUM",
      args: { risks: riskDrafts },
      title: `登记 ${riskDrafts.length} 条项目风险`,
      description: `${names}${riskDrafts.length > 5 ? ` 等 ${riskDrafts.length} 条风险` : ""}；同名风险不会重复创建`,
    });
  }

  const riskName = parseRiskCreationName(params.message);
  if (canUse("risk.create") && riskName) {
    return createProposal({
      ...params,
      toolId: "risk.create",
      riskLevel: "MEDIUM",
      args: { riskName },
      title: "登记项目风险",
      description: `创建风险「${riskName}」，其余字段保持系统默认并可在风险登记册继续完善`,
    });
  }

  const requestedExportIntent = parseAssistantProjectExportIntent(params.message);
  const plannedExportIntent = params.expectedToolId === "project.export" && params.plannedArgs
    ? normalizeAssistantProjectExportIntent(params.plannedArgs)
    : null;
  const exportIntent = plannedExportIntent
    && (!requestedExportIntent || assistantExportPlanPreservesRequest(requestedExportIntent, plannedExportIntent))
    ? plannedExportIntent
    : params.expectedToolId === "project.export" && params.plannedArgs
      ? null
      : requestedExportIntent;
  const projectExportType = exportIntent && exportIntent.exportType !== "scheduleAnalysis" ? exportIntent.exportType : null;
  if (canUse("project.export") && exportIntent && projectExportType) {
    const label = { gantt: "任务进度", weekly: "项目事项", risk: "风险登记册", budget: "项目预算" }[projectExportType];
    const filters = describeAssistantExportFilters(exportIntent);
    const matchedRowCount = await countAssistantProjectExportRows(params.projectId, exportIntent);
    const format = projectExportType === "gantt" || projectExportType === "budget" ? "Excel 工作簿" : "CSV 文件";
    return createProposal({
      ...params,
      toolId: "project.export",
      riskLevel: "LOW",
      args: exportIntent,
      title: `导出${label}`,
      description: `生成当前项目的${label}${format}${filters.length > 0 ? `，仅包含${filters.join("、")}` : ""}；当前命中 ${matchedRowCount} 条记录`,
    });
  }
  if (canUse("project.report.generate") && params.expectedToolId === "project.report.generate" && params.plannedArgs) {
    const title = String(params.plannedArgs.title || "").trim();
    const instructions = String(params.plannedArgs.instructions || "").trim();
    const domains = Array.isArray(params.plannedArgs.domains)
      ? Array.from(new Set(params.plannedArgs.domains.map((value) => String(value || "").trim()).filter(Boolean)))
      : [];
    const intent = buildProjectAssistantQueryIntent(domains);
    if (title && instructions && intent) {
      return createProposal({
        ...params,
        toolId: "project.report.generate",
        riskLevel: "LOW",
        args: { title, instructions, domains: intent.domains },
        title: `生成${title}`,
        description: `读取当前账号已授权的${intent.label}数据，按要求分析并生成独立 Markdown 报告`,
      });
    }
  }
  return null;
};

const completeScheduleArtifactAction = async (params: {
  action: AssistantActionRun;
  user: AuthenticatedUser;
  attachmentId?: string;
  artifactType: "SCHEDULE_CONVERSION" | "SCHEDULE_MERGE";
  fileName: string;
  workbook: Buffer;
  operationDetail: string;
  result: Record<string, unknown>;
}) => {
  const artifactId = randomUUID();
  const storedName = buildAssistantStoredName(artifactId, params.fileName);
  const filePath = getAssistantArtifactPath(params.action.projectId, storedName);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, params.workbook);
  const artifact = await prisma.$transaction(async (tx) => {
    const created = await tx.assistantArtifact.create({
      data: {
        id: artifactId,
        projectId: params.action.projectId,
        userId: params.user.userId,
        attachmentId: params.attachmentId,
        type: params.artifactType,
        fileName: params.fileName,
        storedName,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: params.workbook.length,
      },
    });
    await tx.operationHistory.create({
      data: {
        projectId: params.action.projectId,
        entityType: "ASSISTANT_ARTIFACT",
        entityId: artifactId,
        actionType: "CREATE",
        operator: params.user.displayName,
        detail: params.operationDetail,
      },
    });
    return created;
  }).catch(async (error) => {
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  });
  return prisma.assistantActionRun.update({
    where: { id: params.action.id },
    data: {
      status: "SUCCEEDED",
      confirmedAt: new Date(),
      executedAt: new Date(),
      resultJson: JSON.stringify({
        ...params.result,
        artifactId: artifact.id,
        fileName: params.fileName,
        downloadUrl: `/api/assistant/artifacts/${artifact.id}/download`,
      }),
    },
  });
};

export const executeAssistantAction = async (action: AssistantActionRun, user: AuthenticatedUser) => {
  if (action.userId !== user.userId) throw new Error("无权执行该操作");
  if (action.status !== "PROPOSED") return action;
  if (action.expiresAt.getTime() < Date.now()) {
    await prisma.assistantActionRun.updateMany({
      where: { id: action.id, userId: user.userId, status: "PROPOSED" },
      data: { status: "EXPIRED" },
    });
    return await prisma.assistantActionRun.findUniqueOrThrow({ where: { id: action.id } });
  }
  if (!(await ensureProjectAccess(user, action.projectId))) throw new Error("无权访问当前项目");
  if (!(await canUseAssistantTool(user, action.toolId))) throw new Error("当前账号没有执行该操作的模块权限");

  const args = parseJson(action.argsJson);
  const validation = validateAssistantToolArgs(action.toolId, args);
  if (!validation.ok) throw new Error(validation.error);

  const claimed = await prisma.assistantActionRun.updateMany({
    where: { id: action.id, userId: user.userId, status: "PROPOSED" },
    data: { status: "EXECUTING", confirmedAt: new Date() },
  });
  if (claimed.count === 0) {
    return await prisma.assistantActionRun.findUniqueOrThrow({ where: { id: action.id } });
  }

  if (action.toolId === "approval.project-status.request") {
    const targetStatus = normalizeProjectStatus(args.targetStatus);
    if (!targetStatus) throw new Error("项目目标状态无效");
    const project = await prisma.project.findUnique({
      where: { id: action.projectId },
      select: { name: true, status: true },
    });
    if (!project) throw new Error("项目不存在");
    assertProjectStatusTransition(project.status, targetStatus);
    const permission = projectStatusActionPermission(project.status, targetStatus);
    if (!(await userHasPermission(user, permission))) throw new Error("当前账号没有申请该项目状态变更的权限");
    const instance = await startApprovalWorkflow({
      projectId: action.projectId,
      businessType: APPROVAL_BUSINESS_TYPES.PROJECT_STATUS_CHANGE,
      businessId: approvalBusinessIdForProjectStatus(action.projectId),
      requester: user,
      payload: { fromStatus: project.status, targetStatus },
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: `项目状态变更审批已发起：${PROJECT_STATUS_LABEL[project.status as ProjectStatus] ?? project.status} → ${PROJECT_STATUS_LABEL[targetStatus] ?? targetStatus}`,
          approvalInstanceId: instance.id,
          approvalStatus: instance.status,
          navigateUrl: "/approvals",
          navigateLabel: "查看审批中心",
        }),
      },
    });
  }

  if (action.toolId === "approval.wbs-baseline.request") {
    const project = await prisma.project.findUnique({
      where: { id: action.projectId },
      select: { name: true, status: true, ganttRevision: true },
    });
    if (!project) throw new Error("项目不存在");
    if ([ProjectStatus.COMPLETED, ProjectStatus.VOIDED].includes(project.status as ProjectStatus)) {
      throw new Error("已完成或已作废项目不能发布新的 WBS 基线");
    }
    const instance = await startApprovalWorkflow({
      projectId: action.projectId,
      businessType: APPROVAL_BUSINESS_TYPES.WBS_BASELINE_PUBLISH,
      businessId: approvalBusinessIdForWbsBaseline(action.projectId),
      requester: user,
      payload: { ganttRevision: project.ganttRevision },
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: `WBS 第 ${project.ganttRevision} 版基线审批已发起`,
          approvalInstanceId: instance.id,
          approvalStatus: instance.status,
          navigateUrl: "/approvals",
          navigateLabel: "查看审批中心",
        }),
      },
    });
  }

  if (action.toolId === "approval.process") {
    const approvalAction = normalizeApprovalAction(args.action);
    const instanceId = String(args.instanceId || "").trim();
    const comment = String(args.comment || "").trim();
    if (!approvalAction || !instanceId) throw new Error("审批处理参数无效");
    if (approvalAction !== "approve" && !comment) throw new Error("拒绝或退回审批时必须填写原因");
    const instance = await processApprovalAction({
      instanceId,
      action: approvalAction,
      comment,
      operator: user,
    });
    const actionLabel = approvalAction === "approve" ? "同意" : approvalAction === "reject" ? "拒绝" : "退回";
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: `已${actionLabel}审批“${instance.title}”`,
          approvalInstanceId: instance.id,
          approvalStatus: instance.status,
          navigateUrl: "/approvals",
          navigateLabel: "查看审批中心",
        }),
      },
    });
  }

  if (action.toolId === "collaboration.message") {
    const threadId = String(args.threadId || "").trim();
    const content = String(args.content || "").trim();
    const mentionAccountIds = Array.isArray(args.mentionAccountIds)
      ? args.mentionAccountIds.map(String).map((item) => item.trim()).filter(Boolean)
      : [];
    if (!threadId || !content) throw new Error("协同会话和消息内容不能为空");
    const message = await postCollaborationMessage({
      threadId,
      content,
      mentionAccountIds,
      sender: user,
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: "协同消息已发送",
          collaborationMessageId: message.id,
          threadId: message.threadId,
          navigateUrl: `/collaboration?threadId=${encodeURIComponent(message.threadId)}`,
          navigateLabel: "查看协同会话",
        }),
      },
    });
  }

  if (action.toolId === "todo.create") {
    const title = String(args.title || "").trim();
    if (!title) throw new Error("待办标题不能为空");
    const todo = await prisma.$transaction(async (tx) => {
      const created = await tx.todoItem.create({
        data: {
          projectId: action.projectId,
          title,
          detail: "由佳佳创建",
          targetRole: "MEMBER",
          targetPersonName: String(args.targetPersonName || user.displayName),
          type: "ASSISTANT",
        },
      });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "ASSISTANT_ACTION",
          entityId: created.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手创建待办「${title}」`,
        },
      });
      return created;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "待办已创建", todoId: todo.id, title: todo.title, navigateUrl: "/todos", navigateLabel: "查看待办中心" }) },
    });
  }

  if (action.toolId === "todo.complete") {
    const todoId = String(args.todoId || "");
    const current = await prisma.todoItem.findFirst({ where: { id: todoId, projectId: action.projectId, status: "OPEN" } });
    if (!current) throw new Error("待办不存在或已处理");
    const updated = await prisma.$transaction(async (tx) => {
      const todo = await tx.todoItem.update({ where: { id: todoId }, data: { status: "DONE" } });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "TODO_ITEM",
          entityId: todo.id,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: `通过智能助手完成待办「${todo.title}」`,
        },
      });
      return todo;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "待办已完成", todoId: updated.id, navigateUrl: "/todos", navigateLabel: "查看待办中心" }) },
    });
  }

  if (action.toolId === "todo.delete") {
    const todoId = String(args.todoId || "");
    const current = await prisma.todoItem.findFirst({ where: { id: todoId, projectId: action.projectId } });
    if (!current) throw new Error("待办不存在或已删除");
    await prisma.$transaction(async (tx) => {
      await tx.todoItem.delete({ where: { id: todoId } });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "TODO_ITEM",
          entityId: todoId,
          actionType: "DELETE",
          operator: user.displayName,
          detail: `通过智能助手删除待办「${current.title}」`,
        },
      });
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "待办已删除", todoId, navigateUrl: "/todos", navigateLabel: "查看待办中心" }) },
    });
  }

  if (action.toolId === "gantt.resource.optimize") {
    const candidateKind = normalizeResourceScheduleCandidateKind(args.candidateKind);
    const revision = Number(args.revision);
    const snapshotHash = String(args.snapshotHash || "");
    if (!candidateKind || !Number.isInteger(revision) || revision < 0 || !snapshotHash) {
      throw new Error("正式自动排期方案参数无效，请重新生成预览");
    }
    const result = await applyProjectResourceScheduleCandidate({
      projectId: action.projectId,
      candidateKind,
      expectedRevision: revision,
      expectedSnapshotHash: snapshotHash,
      operator: user.displayName,
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          ...result,
          navigateUrl: `/projects/${action.projectId}?nav=gantt`,
          navigateLabel: "查看优化后的 WBS",
        }),
      },
    });
  }

  if (action.toolId === "gantt.task.create") {
    const taskName = String(args.taskName || "").trim();
    const requestedStartDate = String(args.startDate || "").trim();
    const durationDays = Number(args.durationDays);
    const parentTaskId = args.parentTaskId ? String(args.parentTaskId) : null;
    if (!taskName || !/^\d{4}-\d{2}-\d{2}$/.test(requestedStartDate) || !isValidGanttDurationDays(durationDays)) {
      throw new Error("新增任务需要有效的任务名称、计划开始日期和以 0.5 天为单位的工期");
    }
    const calendarMode = await getProjectGanttCalendarMode(action.projectId);
    const startDate = normalizeTaskStartDate(requestedStartDate, calendarMode);
    const finishDate = calculateTaskFinishDate(startDate, durationDays, calendarMode);
    const parent = parentTaskId
      ? await prisma.projectGanttTask.findFirst({
          where: { id: parentTaskId, projectId: action.projectId },
          select: { id: true, taskCategory: true, taskName: true },
        })
      : null;
    if (parentTaskId && !parent) throw new Error("父任务不存在或不属于当前项目");
    const taskCategory = parent ? parent.taskCategory.trim() || parent.taskName.trim() : taskName;
    const siblings = await prisma.projectGanttTask.findMany({
      where: { projectId: action.projectId, parentId: parentTaskId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { sortOrder: true, taskCategory: true },
    });
    const categorySiblings = siblings.filter((task) => task.taskCategory === taskCategory);
    const sortOrder = (categorySiblings.at(-1)?.sortOrder ?? siblings.at(-1)?.sortOrder ?? 0) + 1;
    const created = await prisma.$transaction(async (tx) => {
      const ownerMemberId = parentTaskId
        ? await resolveEffectiveGanttOwnerMemberId({ tx, projectId: action.projectId, taskId: parentTaskId })
        : null;
      await tx.projectGanttTask.updateMany({
        where: { projectId: action.projectId, parentId: parentTaskId, sortOrder: { gte: sortOrder } },
        data: { sortOrder: { increment: 1 } },
      });
      const task = await tx.projectGanttTask.create({
        data: {
          projectId: action.projectId,
          parentId: parentTaskId,
          ownerMemberId,
          taskCode: "",
          taskCategory,
          taskName,
          taskDescription: "无",
          startDate,
          finishDate,
          durationDays,
          durationMinutes: Math.round(durationDays * 450),
          estimatedWorkHours: estimatedHoursForDuration(durationDays),
          sortOrder,
        },
      });
      await synchronizeGanttOwnerHierarchy({ tx, projectId: action.projectId });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "PROJECT_GANTT_TASK",
          entityId: task.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手新增甘特任务「${taskName}」`,
        },
      });
      return task;
    });
    await renumberProjectGanttTaskCodes(action.projectId);
    await refreshProjectGanttDerivedState(action.projectId, calendarMode);
    const normalizedTask = (await getOrderedGanttTasks(action.projectId)).find((task) => task.id === created.id);
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: `已新增 ${normalizedTask?.taskCode || "任务"} ${taskName}`, taskId: created.id, navigateUrl: `/projects/${action.projectId}?nav=gantt`, navigateLabel: "查看项目进度" }) },
    });
  }

  if (action.toolId === "gantt.task.update") {
    const taskId = String(args.taskId || "");
    const data = {
      ...(typeof args.taskName === "string" ? { taskName: args.taskName.trim() } : {}),
      ...(typeof args.taskDescription === "string" ? { taskDescription: args.taskDescription.trim() || "无" } : {}),
      ...(typeof args.remark === "string" ? { remark: args.remark.trim() } : {}),
    };
    if (Object.keys(data).length === 0 || ("taskName" in data && !data.taskName)) {
      throw new Error("请提供需要更新的任务名称、任务描述或备注");
    }
    const current = await prisma.projectGanttTask.findFirst({ where: { id: taskId, projectId: action.projectId } });
    if (!current) throw new Error("任务不存在");
    const updated = await prisma.$transaction(async (tx) => {
      const task = await tx.projectGanttTask.update({ where: { id: taskId }, data });
      const nextTaskName = typeof data.taskName === "string" ? data.taskName : null;
      if (nextTaskName !== null && nextTaskName !== current.taskName) {
        const projectTasks = await tx.projectGanttTask.findMany({
          where: { projectId: action.projectId },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          select: { id: true, parentId: true, sortOrder: true, createdAt: true, taskCategory: true, taskName: true },
        });
        const synchronized = synchronizeGanttTaskCategoriesAfterNameChange(
          projectTasks,
          taskId,
          current.taskName,
          nextTaskName,
        );
        const previousCategoryById = new Map(projectTasks.map((item) => [item.id, item.taskCategory]));
        await Promise.all(synchronized
          .filter((item) => previousCategoryById.get(item.id) !== item.taskCategory)
          .map((item) => tx.projectGanttTask.update({
            where: { id: item.id },
            data: { taskCategory: item.taskCategory },
          })));
      }
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "PROJECT_GANTT_TASK",
          entityId: task.id,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: `通过智能助手更新 ${current.taskCode} ${current.taskName} 的${Object.keys(data).join("、")}`,
        },
      });
      return task;
    }, { timeout: 30_000, maxWait: 10_000 });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "甘特任务已更新", taskId: updated.id, navigateUrl: `/projects/${action.projectId}?nav=gantt`, navigateLabel: "查看项目进度" }) },
    });
  }

  if (action.toolId === "gantt.task.delete") {
    const taskIds = Array.isArray(args.taskIds) ? args.taskIds.map(String).filter(Boolean) : [];
    if (taskIds.length === 0) throw new Error("没有可删除的甘特任务");
    const result = await deleteGanttTaskSubtrees({ projectId: action.projectId, rootTaskIds: taskIds, operator: user.displayName });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: `已删除 ${result.deletedTaskCount} 条甘特任务并重新编号`, taskIds, navigateUrl: `/projects/${action.projectId}?nav=gantt`, navigateLabel: "查看项目进度" }) },
    });
  }

  if (action.toolId === "gantt.depth.prune") {
    const minimumDepth = Number(args.minimumDepth);
    if (!Number.isInteger(minimumDepth) || minimumDepth < 1) throw new Error("清理层级无效");
    const result = await deleteGanttTasksAtOrBeyondDepth({ projectId: action.projectId, minimumDepth, operator: user.displayName });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: result.deletedTaskCount > 0 ? `已删除第 ${minimumDepth} 层及更深的 ${result.deletedTaskCount} 条任务并重新编号` : `当前项目没有第 ${minimumDepth} 层及更深的任务`, deletedTaskCount: result.deletedTaskCount, navigateUrl: `/projects/${action.projectId}?nav=gantt`, navigateLabel: "查看项目进度" }) },
    });
  }

  if (action.toolId === "gantt.progress.update") {
    const taskId = String(args.taskId || "");
    const progress = Number(args.progress);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      throw new Error("任务进度应为 0-100 的数字");
    }
    const current = await prisma.projectGanttTask.findFirst({ where: { id: taskId, projectId: action.projectId } });
    if (!current) throw new Error("任务不存在");
    const approval = await startApprovalWorkflow({
      projectId: action.projectId,
      businessType: APPROVAL_BUSINESS_TYPES.WBS_TASK_PROGRESS_SUBMISSION,
      businessId: approvalBusinessIdForWbsTaskProgressSubmission(action.projectId, taskId),
      requester: user,
      payload: {
        taskId,
        taskCode: current.taskCode,
        taskName: current.taskName,
        progress,
        actualStartDate: current.actualStartDate,
        actualEndDate: progress >= 100 ? "" : current.actualEndDate,
        actualWorkHours: current.actualWorkHours,
      },
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: "任务进度已提交审批，审批通过后自动更新 WBS",
          taskId: current.id,
          progress,
          approvalInstanceId: approval.id,
          navigateUrl: "/approvals",
          navigateLabel: "查看进度审批",
        }),
      },
    });
  }

  if (action.toolId === "gantt.parent.wrap") {
    const taskName = String(args.taskName || "").trim();
    const requestedChildIds = Array.isArray(args.childTaskIds)
      ? Array.from(new Set(args.childTaskIds.map(String).filter(Boolean)))
      : [];
    if (!taskName || taskName.length > 100) throw new Error("父任务名称不能为空且不能超过 100 个字符");

    const rootTasks = await prisma.projectGanttTask.findMany({
      where: { projectId: action.projectId, parentId: null },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    const requestedSet = new Set(requestedChildIds);
    const childTasks = rootTasks.filter((task) => requestedSet.has(task.id));
    if (childTasks.length === 0 || childTasks.length !== requestedSet.size || rootTasks.length !== requestedSet.size) {
      throw new Error("一级任务已发生变化，请重新发起操作");
    }

    const startDate = childTasks.map((task) => task.startDate).sort()[0];
    const finishDate = childTasks.map((task) => task.finishDate).filter(Boolean).sort().at(-1) || "";
    const durationDays = finishDate
      ? Math.max(0.5, Math.round((new Date(`${finishDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) / 86_400_000) + 1)
      : 0;
    const actualStartDate = childTasks.map((task) => task.actualStartDate).filter(Boolean).sort()[0] || "";
    const actualEndDate = childTasks.map((task) => task.actualEndDate).filter(Boolean).sort().at(-1) || "";
    const estimatedWorkHours = childTasks.reduce((sum, task) => sum + Math.max(0, task.estimatedWorkHours), 0);
    const actualWorkHours = childTasks.reduce((sum, task) => sum + Math.max(0, task.actualWorkHours), 0);
    const weightedDuration = childTasks.reduce((sum, task) => sum + Math.max(0, task.durationDays), 0);
    const progress = weightedDuration > 0
      ? Math.round(childTasks.reduce((sum, task) => sum + Math.max(0, task.durationDays) * task.progress, 0) / weightedDuration)
      : Math.round(childTasks.reduce((sum, task) => sum + task.progress, 0) / childTasks.length);
    const parent = await prisma.$transaction(async (tx) => {
      await tx.projectGanttTask.updateMany({
        where: { projectId: action.projectId, parentId: null },
        data: { sortOrder: { increment: 1 } },
      });
      const created = await tx.projectGanttTask.create({
        data: {
          projectId: action.projectId,
          parentId: null,
          taskCode: "",
          taskCategory: taskName,
          taskName,
          taskDescription: "无",
          startDate,
          finishDate,
          durationDays,
          durationMinutes: Math.round(durationDays * 450),
          actualStartDate,
          actualEndDate,
          estimatedWorkHours,
          actualWorkHours,
          progress,
          predecessorTask: "",
          sortOrder: 1,
        },
      });
      await Promise.all(childTasks.map((task, index) => tx.projectGanttTask.update({
        where: { id: task.id },
        data: { parentId: created.id, sortOrder: index + 1 },
      })));
      const projectTasks = await tx.projectGanttTask.findMany({
        where: { projectId: action.projectId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, parentId: true, sortOrder: true, createdAt: true, taskCategory: true, taskName: true },
      });
      const synchronized = synchronizeGanttTaskCategories(projectTasks, childTasks.map((task) => task.id));
      const previousCategoryById = new Map(projectTasks.map((item) => [item.id, item.taskCategory]));
      await Promise.all(synchronized
        .filter((item) => previousCategoryById.get(item.id) !== item.taskCategory)
        .map((item) => tx.projectGanttTask.update({
          where: { id: item.id },
          data: { taskCategory: item.taskCategory },
        })));
      await synchronizeGanttOwnerHierarchy({ tx, projectId: action.projectId });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "PROJECT_GANTT_TASK",
          entityId: created.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手创建父任务「${taskName}」，并纳入 ${childTasks.length} 个原一级任务`,
        },
      });
      return created;
    }, { maxWait: 10_000, timeout: 60_000 });
    await renumberProjectGanttTaskCodes(action.projectId);
    const normalizedParent = (await getOrderedGanttTasks(action.projectId)).find((task) => task.id === parent.id);
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: `已创建 ${normalizedParent?.taskCode || "Task1"} ${taskName}，并调整现有一级任务层级`,
          taskId: parent.id,
          navigateUrl: `/projects/${action.projectId}?nav=gantt`,
          navigateLabel: "查看项目进度",
        }),
      },
    });
  }

  if (action.toolId === "gantt.hierarchy.outdent" || action.toolId === "gantt.hierarchy.indent") {
    const taskIds = Array.isArray(args.taskIds) ? args.taskIds.map(String).filter(Boolean) : [];
    const direction = action.toolId === "gantt.hierarchy.outdent" ? "OUTDENT" : "INDENT";
    if (taskIds.length === 0) throw new Error("没有可调整层级的任务");
    const result = await changeProjectGanttTaskHierarchy({
      projectId: action.projectId,
      taskIds,
      direction,
      operator: user.displayName,
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: result.movedTaskIds.length > 0
            ? `已${direction === "OUTDENT" ? "上移" : "下移"} ${result.movedTaskIds.length} 个任务层级`
            : "所选任务已位于当前方向的边界，未发生变化",
          taskIds: result.movedTaskIds,
          navigateUrl: `/projects/${action.projectId}?nav=gantt`,
          navigateLabel: "查看项目进度",
        }),
      },
    });
  }

  if (action.toolId === "weekly.item.create") {
    const title = String(args.title || "").trim();
    const owner = String(args.owner || "").trim();
    const description = typeof args.description === "string" ? args.description.trim() : "";
    if (!title || !owner) throw new Error("新增事项需要事项名称和负责人");
    const ownerMember = await prisma.projectMember.findFirst({
      where: { projectId: action.projectId, personName: owner },
      select: { id: true },
    });
    if (!ownerMember) throw new Error("负责人必须是当前项目组成员");
    const existing = await prisma.weeklyItem.findMany({
      where: { projectId: action.projectId },
      select: { id: true, matterCode: true, sortOrder: true, createdAt: true },
    });
    const lastSortOrder = existing.reduce((maximum, item) => Math.max(maximum, item.sortOrder), 0);
    const created = await prisma.$transaction(async (tx) => {
      const item = await tx.weeklyItem.create({
        data: {
          projectId: action.projectId,
          matterCode: nextWeeklyMatterCode(existing),
          sortOrder: lastSortOrder + 1,
          title,
          owner,
          description,
        },
      });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "WEEKLY_ITEM",
          entityId: item.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手创建项目事项「${item.title}」`,
        },
      });
      return item;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: `已创建 ${created.matterCode} ${created.title}`, weeklyItemId: created.id, navigateUrl: "/weekly-items", navigateLabel: "查看项目事项" }) },
    });
  }

  if (action.toolId === "weekly.item.delete") {
    const weeklyItemId = String(args.weeklyItemId || "");
    const current = await prisma.weeklyItem.findFirst({ where: { id: weeklyItemId, projectId: action.projectId } });
    if (!current) throw new Error("事项不存在或已删除");
    await prisma.$transaction(async (tx) => {
      await tx.riskRegisterItem.updateMany({
        where: { projectId: action.projectId, weeklyItemId },
        data: { weeklyItemId: null, linkedItemName: "" },
      });
      await tx.weeklyItem.delete({ where: { id: weeklyItemId } });
      const remaining = await tx.weeklyItem.findMany({
        where: { projectId: action.projectId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, matterCode: true, sortOrder: true, createdAt: true },
      });
      const renumbered = renumberWeeklyMatterCodes(remaining.map((item, index) => ({ ...item, sortOrder: index + 1 })));
      await Promise.all(renumbered.map((item) => tx.weeklyItem.update({
        where: { id: item.id },
        data: { sortOrder: item.sortOrder, matterCode: item.matterCode },
      })));
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "WEEKLY_ITEM",
          entityId: weeklyItemId,
          actionType: "DELETE",
          operator: user.displayName,
          detail: `通过智能助手删除项目事项「${current.title}」`,
        },
      });
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "项目事项已删除并重新编号", weeklyItemId, navigateUrl: "/weekly-items", navigateLabel: "查看项目事项" }) },
    });
  }

  if (action.toolId === "weekly.status.update") {
    const weeklyItemId = String(args.weeklyItemId || "");
    const progress = Number(args.progress);
    if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw new Error("事项进度应为 0-100 的整数");
    const current = await prisma.weeklyItem.findFirst({ where: { id: weeklyItemId, projectId: action.projectId } });
    if (!current) throw new Error("事项不存在");
    const progressData = itemProgressFields(progress, current.actualEndDate, undefined, current.progress);
    const currentStatus = itemStatusFromProgress(current.progress);
    const updated = await prisma.$transaction(async (tx) => {
      const item = await tx.weeklyItem.update({ where: { id: weeklyItemId }, data: progressData });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "WEEKLY_ITEM",
          entityId: item.id,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: `通过智能助手将 ${item.matterCode} ${item.title} 从 ${weeklyStatusLabel[currentStatus]} / ${current.progress}% 更新为 ${weeklyStatusLabel[progressData.status]} / ${progress}%`,
        },
      });
      return item;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "事项进度已更新", weeklyItemId: updated.id, navigateUrl: "/weekly-items", navigateLabel: "查看项目事项" }) },
    });
  }

  if (action.toolId === "project.export") {
    const exportIntent = normalizeAssistantProjectExportIntent(args);
    if (!exportIntent) throw new Error("导出条件不合法或与导出对象不匹配");
    let matchedRowCount = await countAssistantProjectExportRows(action.projectId, exportIntent);
    let progressReport;
    if (exportIntent.exportType === "gantt" && exportIntent.includeProgressReport) {
      const rows = await prisma.projectGanttTask.findMany({ where: { projectId: action.projectId } });
      const matchedRows = selectGanttExportRows(rows, exportIntent);
      matchedRowCount = matchedRows.length;
      progressReport = buildGanttProgressReport(matchedRows);
    }
    const workbookSheets = exportIntent.exportType === "gantt"
      ? ["项目进度", ...(exportIntent.includeProgressReport ? ["进度总结"] : [])]
      : exportIntent.exportType === "budget"
        ? getAssistantBudgetWorkbookSheetNames(await prisma.projectBudgetCategory.findMany({
            where: { projectId: action.projectId },
            select: { kind: true },
          }))
        : exportIntent.exportType === "weekly"
          ? ["项目事项"]
          : ["风险登记册"];
    const fileName = exportIntent.exportType === "gantt"
      ? "任务进度.xlsx"
      : exportIntent.exportType === "weekly"
        ? "项目事项.xlsx"
        : exportIntent.exportType === "risk"
          ? "风险登记册.xlsx"
          : "项目预算分析.xlsx";
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: progressReport
            ? `任务进度 Excel 和进度总结工作表已生成，共 ${matchedRowCount} 条记录。${progressReport.summary}`
            : exportIntent.exportType === "budget"
              ? `项目预算 Excel 已生成，共 ${matchedRowCount} 条记录；不同预算维度已分别写入 ${workbookSheets.slice(0, -2).join("、") || "对应明细"} 工作表`
              : `${fileName} 已生成，共 ${matchedRowCount} 条记录`,
          matchedRowCount,
          downloadUrl: `/api/assistant/exports/${action.id}`,
          fileName,
          workbookSheets,
          includesProgressReport: Boolean(progressReport),
          includesVisualization: exportIntent.exportType === "budget",
          ...(progressReport ? { progressReport } : {}),
        }),
      },
    });
  }

  if (action.toolId === "project.report.generate") {
    const title = String(args.title || "").trim();
    const instructions = String(args.instructions || "").trim();
    const domains = Array.isArray(args.domains) ? args.domains.map(String) : [];
    const intent = buildProjectAssistantQueryIntent(domains);
    if (!title || !instructions || !intent) throw new Error("报告主题、要求或数据范围不完整");
    const runtime = await loadAssistantRuntimeConfig();
    if (!runtime.llmProvider) throw new Error("当前未配置可用的报告生成模型");
    const context = await buildProjectAssistantContext({
      user,
      projectId: action.projectId,
      includeResourceOptimization: intent.domains.includes("RESOURCE"),
    });
    if (!context.project) throw new Error("当前项目不存在或无权访问");
    const visibleContext = buildProjectAssistantVisibleContext(context, intent);
    const report = await callAssistantProviderModel({
      provider: runtime.llmProvider,
      temperature: Math.min(runtime.temperature, 0.3),
      maxTokens: Math.max(runtime.maxTokens, 2200),
      timeoutMs: 90_000,
      messages: [
        {
          role: "system",
          content: [
            "你是 Ceastar PMS 项目报告生成器。",
            "只能使用服务端提供的已授权实时数据，不得编造任何项目事实、数字、日期、人员或结论。",
            "严格覆盖用户要求的每一项分析目标。信息不足时明确写“数据不足”，不能猜测。",
            "输出完整 Markdown 文档，包含标题、执行摘要、数据依据、分析正文、结论；只在数据支持时给出建议。",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `报告标题：${title}`,
            `用户要求：${instructions}`,
            `授权数据域：${intent.domains.join("、")}`,
            `实时项目数据：${JSON.stringify(visibleContext).slice(0, 120_000)}`,
          ].join("\n\n"),
        },
      ],
    });
    if (!report.trim()) throw new Error("模型未生成有效报告内容");
    const artifactId = randomUUID();
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "项目分析报告";
    const fileName = `${safeTitle}.md`;
    const storedName = buildAssistantStoredName(artifactId, fileName);
    const filePath = getAssistantArtifactPath(action.projectId, storedName);
    const buffer = Buffer.from(report.trim(), "utf8");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    const artifact = await prisma.$transaction(async (tx) => {
      const created = await tx.assistantArtifact.create({
        data: {
          id: artifactId,
          projectId: action.projectId,
          userId: user.userId,
          type: "PROJECT_REPORT",
          fileName,
          storedName,
          mimeType: "text/markdown; charset=utf-8",
          sizeBytes: buffer.length,
        },
      });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "ASSISTANT_ARTIFACT",
          entityId: artifactId,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手生成项目报告「${title}」，数据域：${intent.domains.join("、")}`,
        },
      });
      return created;
    }).catch(async (error) => {
      await rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: `项目报告「${title}」已生成`,
          artifactId: artifact.id,
          fileName,
          downloadUrl: `/api/assistant/artifacts/${artifact.id}/download`,
          domains: intent.domains,
          verification: { kind: "DOWNLOAD_AVAILABLE", passed: true, bytes: buffer.length },
        }),
      },
    });
  }

  if (action.toolId === "schedule.analysis.export") {
    const analysisRunId = String(args.analysisRunId || "");
    const run = await prisma.scheduleAnalysisRun.findFirst({ where: { id: analysisRunId, projectId: action.projectId } });
    if (!run) throw new Error("计划分析记录不存在");
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: "计划差异与冲突分析 Excel 已生成",
          fileName: "计划差异与冲突分析.xlsx",
          workbookSheets: ["分析汇总", "冲突与风险", "字段变化"],
          downloadUrl: `/api/assistant/exports/${action.id}`,
        }),
      },
    });
  }

  if (action.toolId === "schedule.import.preview") {
    const attachmentId = String(args.attachmentId || "").trim();
    const requestedStatusDate = String(args.statusDate || "");
    const statusDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedStatusDate)
      ? requestedStatusDate
      : new Date().toISOString().slice(0, 10);
    const hierarchyMode = String(args.hierarchyMode || "AUTO") === "FLAT" ? "FLAT" : "AUTO";
    const [project, attachment] = await Promise.all([
      prisma.project.findUnique({ where: { id: action.projectId }, select: { startDate: true } }),
      prisma.assistantAttachment.findFirst({
        where: { id: attachmentId, projectId: action.projectId, userId: user.userId, status: "READY" },
        select: { id: true, originalName: true, storedName: true, extraction: { select: { content: true, diagnosticsJson: true } } },
      }),
    ]);
    if (!project) throw new Error("当前项目不存在");
    if (!attachment) throw new Error("源附件不存在、尚未解析完成或不属于当前项目");
    const extension = extname(attachment.originalName).toLocaleLowerCase("en-US");
    if (!SCHEDULE_IMPORT_EXTENSIONS.includes(extension as typeof SCHEDULE_IMPORT_EXTENSIONS[number])) {
      throw new Error("WBS 导入预览不支持该附件格式");
    }
    const diagnostics = (() => {
      try {
        const parsed = JSON.parse(attachment.extraction?.diagnosticsJson || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    const blockingDiagnostic = diagnostics.find((diagnostic) => diagnostic?.severity === "ERROR" && typeof diagnostic?.message === "string");
    if (blockingDiagnostic) throw new Error(blockingDiagnostic.message);
    const bundle = await parseScheduleImportSource({
      fileName: attachment.originalName,
      buffer: await readFile(getAssistantAttachmentPath(action.projectId, attachment.storedName)),
      extractedText: attachment.extraction?.content ?? "",
    }, project.startDate, { hierarchyMode });
    const [currentSnapshot, incomingSnapshot] = await Promise.all([
      getCurrentScheduleSnapshot(action.projectId, statusDate),
      Promise.resolve(buildImportedScheduleSnapshot(attachment.originalName, bundle, statusDate)),
    ]);
    const analysis = analyzeSchedule(currentSnapshot, incomingSnapshot);
    const persisted = await prisma.$transaction(async (tx) => {
      const snapshot = await tx.projectScheduleSnapshot.create({
        data: {
          projectId: action.projectId,
          sourceFileName: attachment.originalName,
          schemaVersion: incomingSnapshot.schemaVersion,
          normalizedJson: JSON.stringify(incomingSnapshot),
          createdBy: user.displayName,
        },
      });
      const run = await tx.scheduleAnalysisRun.create({
        data: {
          projectId: action.projectId,
          snapshotId: snapshot.id,
          sourceFileName: attachment.originalName,
          statusDate,
          resultJson: JSON.stringify(analysis),
          createdBy: user.displayName,
        },
      });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "SCHEDULE_IMPORT_PREVIEW",
          entityId: run.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手预览「${attachment.originalName}」导入 WBS，识别 ${analysis.summary.errors} 个阻断错误和 ${analysis.summary.warnings} 个警告，未修改当前计划`,
        },
      });
      return { snapshotId: snapshot.id, analysisRunId: run.id };
    }, { maxWait: 10_000, timeout: 60_000 });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: `WBS 导入预览已生成：${analysis.summary.incomingTasks} 条任务，${analysis.summary.errors} 个阻断错误，${analysis.summary.warnings} 个警告`,
          ...persisted,
          summary: analysis.summary,
          navigateUrl: `/projects/${action.projectId}?nav=gantt&scheduleImportAttachmentId=${encodeURIComponent(attachment.id)}&scheduleImportHierarchyMode=${hierarchyMode}`,
          navigateLabel: "打开导入预览",
          verification: { kind: "DATABASE_STATE", passed: true, analysisRunId: persisted.analysisRunId },
        }),
      },
    });
  }

  if (action.toolId === "schedule.compare.file") {
    const attachmentId = String(args.attachmentId || "").trim();
    const requestedStatusDate = String(args.statusDate || "");
    const statusDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedStatusDate)
      ? requestedStatusDate
      : new Date().toISOString().slice(0, 10);
    const [project, attachment] = await Promise.all([
      prisma.project.findUnique({ where: { id: action.projectId }, select: { startDate: true } }),
      prisma.assistantAttachment.findFirst({
        where: { id: attachmentId, projectId: action.projectId, userId: user.userId, status: "READY" },
        select: { id: true, originalName: true, storedName: true, extraction: { select: { content: true, diagnosticsJson: true } } },
      }),
    ]);
    if (!project) throw new Error("当前项目不存在");
    if (!attachment) throw new Error("源附件不存在、尚未解析完成或不属于当前项目");
    const extension = extname(attachment.originalName).toLocaleLowerCase("en-US");
    if (!SCHEDULE_IMPORT_EXTENSIONS.includes(extension as typeof SCHEDULE_IMPORT_EXTENSIONS[number])) {
      throw new Error("计划对比不支持该附件格式");
    }
    const diagnostics = (() => {
      try {
        const parsed = JSON.parse(attachment.extraction?.diagnosticsJson || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    const blockingDiagnostic = diagnostics.find((diagnostic) => diagnostic?.severity === "ERROR" && typeof diagnostic?.message === "string");
    if (blockingDiagnostic) throw new Error(blockingDiagnostic.message);
    const bundle = await parseScheduleImportSource({
      fileName: attachment.originalName,
      buffer: await readFile(getAssistantAttachmentPath(action.projectId, attachment.storedName)),
      extractedText: attachment.extraction?.content ?? "",
    }, project.startDate);
    const [currentSnapshot, incomingSnapshot] = await Promise.all([
      getCurrentScheduleSnapshot(action.projectId, statusDate),
      Promise.resolve(buildImportedScheduleSnapshot(attachment.originalName, bundle, statusDate)),
    ]);
    const analysis = analyzeSchedule(currentSnapshot, incomingSnapshot);
    const issueCount = analysis.issues.length;
    const persisted = await prisma.$transaction(async (tx) => {
      const snapshot = await tx.projectScheduleSnapshot.create({
        data: {
          projectId: action.projectId,
          sourceFileName: attachment.originalName,
          schemaVersion: incomingSnapshot.schemaVersion,
          normalizedJson: JSON.stringify(incomingSnapshot),
          createdBy: user.displayName,
        },
      });
      const run = await tx.scheduleAnalysisRun.create({
        data: {
          projectId: action.projectId,
          snapshotId: snapshot.id,
          sourceFileName: attachment.originalName,
          statusDate,
          resultJson: JSON.stringify(analysis),
          createdBy: user.displayName,
        },
      });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "SCHEDULE_ANALYSIS",
          entityId: run.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手对比「${attachment.originalName}」与当前计划，发现 ${issueCount} 个问题，未修改当前计划`,
        },
      });
      return { snapshotId: snapshot.id, analysisRunId: run.id };
    }, { maxWait: 10_000, timeout: 60_000 });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: `计划对比完成：识别 ${analysis.summary.changedFields} 个字段变更、${issueCount} 个冲突或干涉问题`,
          ...persisted,
          issueCount,
          summary: analysis.summary,
          verification: { kind: "DATABASE_STATE", passed: true, analysisRunId: persisted.analysisRunId },
        }),
      },
    });
  }

  if (action.toolId === "schedule.convert.file") {
    const attachmentId = String(args.attachmentId || "").trim();
    if (!attachmentId) throw new Error("请选择一个需要转换的进度计划附件");
    const [project, attachment] = await Promise.all([
      prisma.project.findUnique({ where: { id: action.projectId }, select: { startDate: true } }),
      prisma.assistantAttachment.findFirst({
        where: { id: attachmentId, projectId: action.projectId, userId: user.userId, status: "READY" },
        select: { id: true, originalName: true, storedName: true },
      }),
    ]);
    if (!project) throw new Error("当前项目不存在");
    if (!attachment) throw new Error("源附件不存在、尚未解析完成或不属于当前项目");
    const extension = extname(attachment.originalName).toLocaleLowerCase("en-US");
    if (!SCHEDULE_CONVERT_EXTENSIONS.includes(extension as typeof SCHEDULE_CONVERT_EXTENSIONS[number])) {
      throw new Error("单文件转换仅支持 MPP、Project XML 和系统 Excel");
    }
    const converted = await convertScheduleFile({
      fileName: attachment.originalName,
      buffer: await readFile(getAssistantAttachmentPath(action.projectId, attachment.storedName)),
    }, project.startDate);
    const sourceLabel = basename(attachment.originalName, extname(attachment.originalName))
      .replace(/[\\/:*?"<>|]/g, "-")
      .slice(0, 80) || "进度计划";
    const fileName = `${sourceLabel}-系统甘特任务.xlsx`;
    return completeScheduleArtifactAction({
      action,
      user,
      attachmentId: attachment.id,
      artifactType: "SCHEDULE_CONVERSION",
      fileName,
      workbook: converted.workbook,
      operationDetail: `通过智能助手将「${attachment.originalName}」转换为系统甘特任务文件，生成 ${converted.tasks.length} 条任务、${converted.warnings.length} 条校验提示`,
      result: {
        message: `已将「${attachment.originalName}」转换为系统可导入 Excel，共 ${converted.tasks.length} 条任务${converted.warnings.length > 0 ? `，转换说明中有 ${converted.warnings.length} 条待核对提示` : ""}`,
        sourceCount: 1,
        taskCount: converted.tasks.length,
        warningCount: converted.warnings.length,
        verification: { kind: "SCHEDULE_REIMPORT", passed: true, expectedTaskCount: converted.tasks.length, actualTaskCount: converted.tasks.length },
      },
    });
  }

  if (action.toolId === "schedule.merge.files") {
    const attachmentIds = Array.isArray(args.attachmentIds)
      ? Array.from(new Set(args.attachmentIds.map((value) => String(value || "").trim()).filter(Boolean))).slice(0, 5)
      : [];
    if (attachmentIds.length < 2) throw new Error("合并进度计划至少需要两个附件");
    const [project, attachments] = await Promise.all([
      prisma.project.findUnique({ where: { id: action.projectId }, select: { name: true, code: true, startDate: true } }),
      prisma.assistantAttachment.findMany({
        where: { id: { in: attachmentIds }, projectId: action.projectId, userId: user.userId, status: "READY" },
        select: { id: true, originalName: true, storedName: true },
      }),
    ]);
    if (!project) throw new Error("当前项目不存在");
    const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    const ordered = attachmentIds.map((id) => attachmentById.get(id)).filter((attachment): attachment is NonNullable<typeof attachment> => Boolean(attachment));
    if (ordered.length !== attachmentIds.length) throw new Error("部分源附件不存在、尚未解析完成或不属于当前项目");
    const sources = await Promise.all(ordered.map(async (attachment) => ({
      fileName: attachment.originalName,
      buffer: await readFile(getAssistantAttachmentPath(action.projectId, attachment.storedName)),
    })));
    const merged = await mergeScheduleFiles(sources, project.startDate);
    const projectLabel = (project.code || project.name || "项目").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
    const fileName = `${projectLabel}-合并进度计划.xlsx`;
    return completeScheduleArtifactAction({
      action,
      user,
      artifactType: "SCHEDULE_MERGE",
      fileName,
      workbook: merged.workbook,
      operationDetail: `通过智能助手合并 ${sources.length} 个进度计划文件，生成 ${merged.tasks.length} 条任务、${merged.warnings.length} 条校验提示`,
      result: {
        message: `已合并 ${sources.length} 个文件并生成 ${merged.tasks.length} 条任务${merged.warnings.length > 0 ? `，合并说明中有 ${merged.warnings.length} 条待核对提示` : ""}`,
        sourceCount: sources.length,
        taskCount: merged.tasks.length,
        warningCount: merged.warnings.length,
        verification: { kind: "SCHEDULE_REIMPORT", passed: true, expectedTaskCount: merged.tasks.length, actualTaskCount: merged.tasks.length },
      },
    });
  }

  if (action.toolId === "document.revision.save") {
    const attachmentId = String(args.attachmentId || "");
    const content = String(args.content || "").trim();
    const instruction = String(args.instruction || "").trim();
    if (!content) throw new Error("修订稿内容为空");
    const attachment = await prisma.assistantAttachment.findFirst({
      where: { id: attachmentId, projectId: action.projectId, userId: user.userId },
    });
    if (!attachment) throw new Error("来源附件不存在");
    const revisionId = randomUUID();
    const artifactId = randomUUID();
    const originalBase = basename(attachment.originalName, extname(attachment.originalName)).slice(0, 120) || "文档";
    const fileName = `${originalBase}-修订稿.md`;
    const storedName = buildAssistantStoredName(artifactId, fileName);
    const filePath = getAssistantArtifactPath(action.projectId, storedName);
    const buffer = Buffer.from(content, "utf8");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    const artifact = await prisma.$transaction(async (tx) => {
      await tx.documentRevision.create({
        data: { id: revisionId, projectId: action.projectId, attachmentId, userId: user.userId, instruction, content, format: "md" },
      });
      const created = await tx.assistantArtifact.create({
        data: { id: artifactId, projectId: action.projectId, userId: user.userId, attachmentId, revisionId, fileName, storedName, mimeType: "text/markdown; charset=utf-8", sizeBytes: buffer.length },
      });
      await tx.operationHistory.create({
        data: { projectId: action.projectId, entityType: "DOCUMENT_REVISION", entityId: revisionId, actionType: "CREATE", operator: user.displayName, detail: `通过智能助手保存「${attachment.originalName}」的独立修订稿` },
      });
      return created;
    }).catch(async (error) => {
      await rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "修订稿已保存", revisionId, artifactId: artifact.id, downloadUrl: `/api/assistant/artifacts/${artifact.id}/download`, verification: { kind: "DOWNLOAD_AVAILABLE", passed: true } }) },
    });
  }

  if (action.toolId === "document.revision.generate") {
    const attachmentId = String(args.attachmentId || "");
    const instruction = String(args.instruction || "").trim();
    const attachment = await prisma.assistantAttachment.findFirst({
      where: { id: attachmentId, projectId: action.projectId, userId: user.userId, status: "READY" },
      include: { extraction: true },
    });
    if (!attachment?.extraction) throw new Error("来源附件不存在或尚未完成内容提取");
    const diagnostics = (() => {
      try {
        const parsed = JSON.parse(attachment.extraction.diagnosticsJson || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    const blocking = diagnostics.filter((item) => item && typeof item === "object" && (item as { severity?: unknown }).severity === "ERROR");
    if (blocking.some((item) => (item as { code?: unknown }).code === "PDF_OCR_REQUIRED")) {
      throw new Error("PDF 未提取到可用文本，请先完成 OCR 后重新上传");
    }
    const structured = parseJson(attachment.extraction.structuredJson);
    const runtime = await loadAssistantRuntimeConfig();
    const content = await reviseDocumentsWithSmallModel({
      message: instruction,
      documents: [{
        attachmentId: attachment.id,
        fileName: attachment.originalName,
        format: String(structured.format || extname(attachment.originalName).slice(1)),
        diagnostics,
        content: attachment.extraction.content,
      }],
      runtime,
    });
    if (!content) throw new Error("当前未配置可用的文档修订模型");
    const revisionId = randomUUID();
    const artifactId = randomUUID();
    const originalBase = basename(attachment.originalName, extname(attachment.originalName)).slice(0, 120) || "文档";
    const fileName = `${originalBase}-修订稿.md`;
    const storedName = buildAssistantStoredName(artifactId, fileName);
    const filePath = getAssistantArtifactPath(action.projectId, storedName);
    const buffer = Buffer.from(content, "utf8");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    const artifact = await prisma.$transaction(async (tx) => {
      await tx.documentRevision.create({ data: { id: revisionId, projectId: action.projectId, attachmentId, userId: user.userId, instruction, content, format: "md" } });
      const created = await tx.assistantArtifact.create({ data: { id: artifactId, projectId: action.projectId, userId: user.userId, attachmentId, revisionId, fileName, storedName, mimeType: "text/markdown; charset=utf-8", sizeBytes: buffer.length } });
      await tx.operationHistory.create({ data: { projectId: action.projectId, entityType: "DOCUMENT_REVISION", entityId: revisionId, actionType: "CREATE", operator: user.displayName, detail: `通过智能助手诊断、重写并生成「${attachment.originalName}」的独立修订稿` } });
      return created;
    }).catch(async (error) => {
      await rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: {
        status: "SUCCEEDED",
        confirmedAt: new Date(),
        executedAt: new Date(),
        resultJson: JSON.stringify({
          message: `文档修订稿已生成${/## 待确认问题/u.test(content) ? "，末尾保留了待确认问题" : ""}`,
          revisionId,
          artifactId: artifact.id,
          downloadUrl: `/api/assistant/artifacts/${artifact.id}/download`,
          diagnosticCount: diagnostics.length,
          verification: { kind: "DOWNLOAD_AVAILABLE", passed: true, bytes: buffer.length },
        }),
      },
    });
  }

  if (action.toolId === "risk.create.from-analysis") {
    const issue = args.issue && typeof args.issue === "object" ? args.issue as Record<string, unknown> : {};
    const taskIds = Array.isArray(issue.taskIds) ? issue.taskIds.map(String) : [];
    const linkedMatterRows = taskIds.length > 0
      ? await prisma.weeklyItem.findMany({
          where: {
            projectId: action.projectId,
            OR: [
              { ganttTaskId: { in: taskIds } },
              { ganttTaskLinks: { some: { ganttTaskId: { in: taskIds } } } },
            ],
          },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: { id: true },
        })
      : [];
    const existing = await prisma.riskRegisterItem.findMany({ where: { projectId: action.projectId }, select: { id: true, riskCode: true, sortOrder: true, createdAt: true } });
    const lastSortOrder = existing.reduce((max, item) => Math.max(max, item.sortOrder), 0);
    const created = await prisma.$transaction(async (tx) => {
      const linkedMatters = await findProjectMatters(
        tx,
        action.projectId,
        linkedMatterRows.map((item) => item.id),
      );
      const risk = await tx.riskRegisterItem.create({
        data: {
          projectId: action.projectId,
          sortOrder: lastSortOrder + 1,
          riskCode: nextRiskCode(existing),
          ganttTaskId: null,
          weeklyItemId: null,
          riskName: String(issue.message || "计划分析冲突").slice(0, 200),
          linkedItemName: "",
          category: "进度",
          trigger: JSON.stringify(issue.facts ?? {}).slice(0, 500),
          probability: "中",
          impact: issue.severity === "ERROR" ? "高" : "中",
          level: issue.severity === "ERROR" ? "高" : "中",
          response: String(issue.suggestion || "核对计划并制定纠偏措施"),
          owner: user.displayName,
        },
      });
      await replaceRiskMatterLinks(tx, risk.id, linkedMatters);
      await tx.operationHistory.create({ data: { projectId: action.projectId, entityType: "RISK_REGISTER_ITEM", entityId: risk.id, actionType: "CREATE", operator: user.displayName, detail: `通过智能助手从计划分析创建风险「${risk.riskName}」` } });
      return risk;
    });
    return prisma.assistantActionRun.update({ where: { id: action.id }, data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "风险已创建", riskId: created.id, riskCode: created.riskCode }) } });
  }

  if (action.toolId === "risk.create.batch") {
    const drafts = normalizeAssistantRiskDrafts(args.risks);
    if (drafts.length === 0) throw new Error("没有可登记的风险，请先提供风险清单或风险分析结果");
    const existing = await prisma.riskRegisterItem.findMany({
      where: { projectId: action.projectId },
      select: { id: true, riskCode: true, riskName: true, sortOrder: true, createdAt: true },
    });
    const nameKey = (value: string) => value.replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
    const existingByName = new Map(existing.map((risk) => [nameKey(risk.riskName), risk]));
    const codeSources = [...existing];
    let nextSortOrder = existing.reduce((max, item) => Math.max(max, item.sortOrder), 0);
    const createdRows = drafts.flatMap((draft) => {
      if (existingByName.has(nameKey(draft.riskName))) return [];
      nextSortOrder += 1;
      const id = randomUUID();
      const riskCode = nextRiskCode(codeSources);
      const row = {
        id,
        projectId: action.projectId,
        sortOrder: nextSortOrder,
        riskCode,
        riskName: draft.riskName,
        category: draft.category,
        trigger: draft.trigger,
        probability: draft.probability,
        impact: draft.impact,
        level: draft.level,
        response: draft.response,
        owner: draft.owner || user.displayName,
        status: draft.status,
        targetDate: draft.targetDate,
      };
      codeSources.push({ id, riskCode, riskName: draft.riskName, sortOrder: nextSortOrder, createdAt: new Date() });
      existingByName.set(nameKey(draft.riskName), { ...row, createdAt: new Date() });
      return [row];
    });
    await prisma.$transaction(async (tx) => {
      if (createdRows.length > 0) {
        await tx.riskRegisterItem.createMany({ data: createdRows });
        await tx.operationHistory.createMany({
          data: createdRows.map((risk) => ({
            projectId: action.projectId,
            entityType: "RISK_REGISTER_ITEM",
            entityId: risk.id,
            actionType: "CREATE",
            operator: user.displayName,
            detail: `通过智能助手从分析结果登记风险「${risk.riskName}」`,
          })),
        });
      }
    });
    const resolved = drafts.map((draft) => existingByName.get(nameKey(draft.riskName))!);
    const result = {
      message: `已处理 ${drafts.length} 条风险：新增 ${createdRows.length} 条，已存在 ${drafts.length - createdRows.length} 条`,
      requestedCount: drafts.length,
      processedCount: resolved.length,
      createdCount: createdRows.length,
      existingCount: drafts.length - createdRows.length,
      riskIds: resolved.map((risk) => risk.id),
      riskCodes: resolved.map((risk) => risk.riskCode),
      navigateUrl: "/risk-register",
      navigateLabel: "查看风险登记册",
    };
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify(result) },
    });
  }

  if (action.toolId === "risk.create") {
    const riskName = String(args.riskName || "").trim();
    if (!riskName || riskName.length > 200) throw new Error("风险名称不能为空且不能超过 200 个字");
    const existing = await prisma.riskRegisterItem.findMany({
      where: { projectId: action.projectId },
      select: { id: true, riskCode: true, sortOrder: true, createdAt: true },
    });
    const lastSortOrder = existing.reduce((max, item) => Math.max(max, item.sortOrder), 0);
    const created = await prisma.$transaction(async (tx) => {
      const risk = await tx.riskRegisterItem.create({
        data: {
          projectId: action.projectId,
          sortOrder: lastSortOrder + 1,
          riskCode: nextRiskCode(existing),
          riskName,
          owner: user.displayName,
        },
      });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "RISK_REGISTER_ITEM",
          entityId: risk.id,
          actionType: "CREATE",
          operator: user.displayName,
          detail: `通过智能助手登记风险「${risk.riskName}」`,
        },
      });
      return risk;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "风险已登记", riskId: created.id, riskCode: created.riskCode, navigateUrl: "/risk-register", navigateLabel: "查看风险登记册" }) },
    });
  }

  if (action.toolId === "risk.status.update") {
    const riskId = String(args.riskId || "");
    const status = String(args.status || "");
    if (!riskStatuses.includes(status as (typeof riskStatuses)[number])) throw new Error("风险状态无效");
    const current = await prisma.riskRegisterItem.findFirst({ where: { id: riskId, projectId: action.projectId } });
    if (!current) throw new Error("风险不存在");
    const updated = await prisma.$transaction(async (tx) => {
      const risk = await tx.riskRegisterItem.update({ where: { id: riskId }, data: { status } });
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "RISK_REGISTER_ITEM",
          entityId: risk.id,
          actionType: "UPDATE",
          operator: user.displayName,
          detail: `通过智能助手将 ${risk.riskCode} ${risk.riskName} 状态从 ${current.status} 更新为 ${status}`,
        },
      });
      return risk;
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "风险状态已更新", riskId: updated.id, navigateUrl: "/risk-register", navigateLabel: "查看风险登记册" }) },
    });
  }

  if (action.toolId === "risk.delete") {
    const riskId = String(args.riskId || "");
    const current = await prisma.riskRegisterItem.findFirst({ where: { id: riskId, projectId: action.projectId } });
    if (!current) throw new Error("风险不存在或已删除");
    await prisma.$transaction(async (tx) => {
      await tx.riskRegisterItem.delete({ where: { id: riskId } });
      const remaining = await tx.riskRegisterItem.findMany({
        where: { projectId: action.projectId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        select: { id: true, riskCode: true, sortOrder: true, createdAt: true },
      });
      const renumbered = renumberRiskCodes(remaining.map((item, index) => ({ ...item, sortOrder: index + 1 })));
      await Promise.all(renumbered.map((item) => tx.riskRegisterItem.update({
        where: { id: item.id },
        data: { sortOrder: item.sortOrder, riskCode: item.riskCode },
      })));
      await tx.operationHistory.create({
        data: {
          projectId: action.projectId,
          entityType: "RISK_REGISTER_ITEM",
          entityId: riskId,
          actionType: "DELETE",
          operator: user.displayName,
          detail: `通过智能助手删除风险「${current.riskName}」`,
        },
      });
    });
    return prisma.assistantActionRun.update({
      where: { id: action.id },
      data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: "风险已删除并重新编号", riskId, navigateUrl: "/risk-register", navigateLabel: "查看风险登记册" }) },
    });
  }

  if (action.toolId === "todo.create.batch") {
    const items = Array.isArray(args.items) ? args.items.filter((item) => item && typeof item === "object").slice(0, 50) as Record<string, unknown>[] : [];
    if (items.length === 0) throw new Error("没有可创建的整改待办");
    const created = await prisma.$transaction(async (tx) => {
      const rows = [];
      for (const item of items) {
        const title = String(item.title || "处理计划分析问题").slice(0, 200);
        rows.push(await tx.todoItem.create({ data: { projectId: action.projectId, title, detail: String(item.detail || "由佳佳从计划分析生成"), targetRole: "MEMBER", targetPersonName: user.displayName, type: "ASSISTANT" } }));
      }
      await tx.operationHistory.create({ data: { projectId: action.projectId, entityType: "ASSISTANT_ACTION", entityId: action.id, actionType: "CREATE", operator: user.displayName, detail: `通过智能助手从计划分析创建 ${rows.length} 条整改待办` } });
      return rows;
    });
    return prisma.assistantActionRun.update({ where: { id: action.id }, data: { status: "SUCCEEDED", confirmedAt: new Date(), executedAt: new Date(), resultJson: JSON.stringify({ message: `已创建 ${created.length} 条整改待办`, todoIds: created.map((item) => item.id) }) } });
  }

  throw new Error("不支持的 Agent 工具");
};
