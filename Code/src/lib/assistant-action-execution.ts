import type { AssistantActionRun } from "@prisma/client";

import { executeAssistantAction } from "@/lib/assistant-actions";
import { getAssistantToolDefinition } from "@/lib/assistant-settings";
import { normalizeAssistantRiskDrafts } from "@/lib/assistant-risk-drafts";
import { prisma } from "@/lib/prisma";
import type { AuthenticatedUser } from "@/lib/server-auth";

export type AssistantActionErrorCode =
  | "INPUT_REQUIRED"
  | "PERMISSION_DENIED"
  | "CONCURRENT_CHANGE"
  | "TEMPORARY_DEPENDENCY"
  | "BUSINESS_RULE"
  | "UNSUPPORTED_TOOL"
  | "VERIFICATION_FAILED";

export type AssistantActionFailure = {
  code: AssistantActionErrorCode;
  message: string;
  retryable: boolean;
  recovery: string;
};

const messageOf = (error: unknown) => error instanceof Error ? error.message : "执行失败";

export const classifyAssistantActionError = (error: unknown): AssistantActionFailure => {
  const message = messageOf(error);
  if (/(无权|权限|禁止访问)/u.test(message)) {
    return { code: "PERMISSION_DENIED", message, retryable: false, recovery: "请联系管理员补充模块权限或改由有权限的成员执行。" };
  }
  if (/(缺少|请选择|不能为空|附件不存在|尚未解析|数量不足|格式|类型无效|参数)/u.test(message)) {
    return { code: "INPUT_REQUIRED", message, retryable: false, recovery: "请按提示补充或重新上传输入，然后重新发起该步骤。" };
  }
  if (/(已发生变化|并发|已处理|状态.*变化|不存在或已)/u.test(message)) {
    return { code: "CONCURRENT_CHANGE", message, retryable: false, recovery: "系统数据已经变化，请重新生成操作预览后再执行。" };
  }
  if (/(timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed|temporar|暂时|服务不可用)/iu.test(message)) {
    return { code: "TEMPORARY_DEPENDENCY", message, retryable: true, recovery: "可稍后从失败步骤续跑；系统不会重复执行已成功步骤。" };
  }
  if (/(不支持的 Agent 工具|不支持.*工具)/u.test(message)) {
    return { code: "UNSUPPORTED_TOOL", message, retryable: false, recovery: "请改用管理后台已启用的领域工具。" };
  }
  if (/(校验失败|验证失败|无法重新导入)/u.test(message)) {
    return { code: "VERIFICATION_FAILED", message, retryable: false, recovery: "输出未达到验收条件，请修正源数据后重新执行。" };
  }
  return { code: "BUSINESS_RULE", message, retryable: false, recovery: "请根据失败原因调整业务数据后重新执行。" };
};

const parseResult = (value: string) => {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

export const verifyAssistantActionResult = (action: AssistantActionRun) => {
  const tool = getAssistantToolDefinition(action.toolId);
  if (!tool) throw new Error("不支持的 Agent 工具");
  const result = parseResult(action.resultJson);
  const missing = tool.outputSchema.required.filter((field) => result[field] === undefined || result[field] === null || result[field] === "");
  if (missing.length > 0) throw new Error(`动作结果校验失败，缺少：${missing.join("、")}`);
  if (tool.verifier === "DOWNLOAD_AVAILABLE" && typeof result.downloadUrl !== "string") {
    throw new Error("动作结果校验失败，下载地址不可用");
  }
  if (tool.verifier === "SCHEDULE_REIMPORT") {
    const evidence = result.verification;
    if (!evidence || typeof evidence !== "object" || (evidence as { passed?: unknown }).passed !== true) {
      throw new Error("动作结果校验失败，生成文件未通过重新导入验证");
    }
  }
  if (action.toolId === "risk.create.batch") {
    const args = parseResult(action.argsJson);
    const requestedRisks = normalizeAssistantRiskDrafts(args.risks);
    const riskIds = Array.isArray(result.riskIds) ? result.riskIds.filter((value) => typeof value === "string" && value) : [];
    const riskCodes = Array.isArray(result.riskCodes) ? result.riskCodes.filter((value) => typeof value === "string" && value) : [];
    if (
      requestedRisks.length === 0
      || result.requestedCount !== requestedRisks.length
      || result.processedCount !== requestedRisks.length
      || riskIds.length !== requestedRisks.length
      || riskCodes.length !== requestedRisks.length
    ) {
      throw new Error(`动作结果校验失败，要求登记 ${requestedRisks.length} 条风险，但批量登记结果不完整`);
    }
  }
  return { kind: tool.verifier, passed: true, checkedFields: tool.outputSchema.required };
};

export const executeAssistantActionWithRecovery = async (
  initialAction: AssistantActionRun,
  user: AuthenticatedUser,
) => {
  const tool = getAssistantToolDefinition(initialAction.toolId);
  const maxAttempts = Math.max(1, tool?.retryPolicy.maxAttempts ?? 1);
  let action = initialAction;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      action = await executeAssistantAction(action, user);
      if (action.status === "SUCCEEDED") verifyAssistantActionResult(action);
      return action;
    } catch (error) {
      const failure = classifyAssistantActionError(error);
      const mayRetry = failure.retryable
        && tool?.idempotency === "REPLAY_SAFE"
        && tool.retryPolicy.retryableErrorCodes.includes(failure.code)
        && attempt < maxAttempts;
      await prisma.assistantActionRun.updateMany({
        where: { id: action.id, userId: user.userId, status: { in: ["PROPOSED", "EXECUTING", "SUCCEEDED"] } },
        data: {
          status: mayRetry ? "PROPOSED" : "FAILED",
          errorCode: failure.code,
          errorMessage: `${failure.message}\n恢复建议：${failure.recovery}`,
        },
      });
      if (!mayRetry) throw Object.assign(new Error(failure.message), { assistantFailure: failure });
      action = await prisma.assistantActionRun.findUniqueOrThrow({ where: { id: action.id } });
    }
  }
  return action;
};
