import { describe, expect, it } from "vitest";

import { classifyAssistantActionError } from "@/lib/assistant-action-execution";

describe("assistant action failure classification", () => {
  it.each([
    ["当前账号没有执行权限", "PERMISSION_DENIED", false],
    ["请选择一个需要转换的附件", "INPUT_REQUIRED", false],
    ["一级任务已发生变化，请重新发起操作", "CONCURRENT_CHANGE", false],
    ["fetch failed: ECONNRESET", "TEMPORARY_DEPENDENCY", true],
    ["生成文件校验失败", "VERIFICATION_FAILED", false],
    ["不支持的 Agent 工具", "UNSUPPORTED_TOOL", false],
  ])("classifies %s", (message, code, retryable) => {
    expect(classifyAssistantActionError(new Error(message))).toMatchObject({ code, retryable });
  });
});
