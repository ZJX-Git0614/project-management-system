import { describe, expect, it } from "vitest";

import { listApprovalBusinessCapabilities } from "@/lib/approval-business-registry";
import {
  APPROVAL_BUSINESS_TYPES,
  APPROVAL_EFFECT_AUTOMATIC_RETRY_LIMIT,
  DEFAULT_APPROVAL_WORKFLOWS,
  approvalEffectFailurePolicy,
  approvalActiveKey,
  approvalBusinessIdForProjectStatus,
  approvalBusinessIdForWbsBaseline,
  approvalPayloadsMatch,
  normalizeApprovalWorkflowNodes,
  requiredApprovalCount,
  validateApprovalWorkflowDraft,
} from "@/lib/approval-workflow";

describe("approval workflow domain", () => {
  it("keeps every published default workflow connected to a real completion handler", () => {
    const capabilities = new Map(
      listApprovalBusinessCapabilities().map((item) => [item.businessType, item.handlerKey]),
    );

    expect(DEFAULT_APPROVAL_WORKFLOWS).toHaveLength(2);
    for (const workflow of DEFAULT_APPROVAL_WORKFLOWS) {
      expect(validateApprovalWorkflowDraft(workflow)).toEqual([]);
      expect(capabilities.get(workflow.businessType)).toBe(workflow.completionHandlerKey);
    }
    expect(capabilities.has(APPROVAL_BUSINESS_TYPES.BUDGET_CHANGE)).toBe(false);
  });

  it("normalizes node order and rejects mutable or incomplete approver definitions", () => {
    const nodes = normalizeApprovalWorkflowNodes([
      {
        nodeKey: "manager",
        nodeOrder: 8,
        nodeName: "项目经理审批",
        assignmentType: "PROJECT_ROLE",
        projectRoleName: "",
        reminderAfterHours: 0,
      },
    ]);

    expect(nodes[0]).toMatchObject({
      nodeOrder: 1,
      nodeType: "APPROVAL",
      assignmentType: "PROJECT_ROLE",
      reminderAfterHours: 1,
    });
    expect(validateApprovalWorkflowDraft({
      businessType: APPROVAL_BUSINESS_TYPES.PROJECT_STATUS_CHANGE,
      moduleKey: "project-info",
      name: "状态审批",
      nodes,
    })).toContainEqual({
      path: "nodes.0.projectRoleName",
      message: "按项目角色审批时必须选择角色",
    });
  });

  it("uses deterministic business keys to prevent duplicate active workflows", () => {
    expect(approvalBusinessIdForProjectStatus("project-1")).toBe("project-1:status");
    expect(approvalBusinessIdForWbsBaseline("project-1")).toBe("project-1:wbs-baseline");
    expect(approvalActiveKey({
      projectId: "project-1",
      businessType: APPROVAL_BUSINESS_TYPES.WBS_BASELINE_PUBLISH,
      businessId: approvalBusinessIdForWbsBaseline("project-1"),
    })).toBe("project-1:WBS_BASELINE_PUBLISH:project-1:wbs-baseline");
  });

  it("treats only semantically identical approval payloads as idempotent", () => {
    expect(approvalPayloadsMatch(
      { taskId: "task-1", progress: 80, metadata: { owner: "张三", tags: ["现场", "安装"] } },
      { metadata: { tags: ["现场", "安装"], owner: "张三" }, progress: 80, taskId: "task-1" },
    )).toBe(true);
    expect(approvalPayloadsMatch(
      { taskId: "task-1", progress: 80 },
      { taskId: "task-1", progress: 100 },
    )).toBe(false);
  });

  it("keeps countersign and any-sign semantics unambiguous", () => {
    expect(requiredApprovalCount("ALL", 3)).toBe(3);
    expect(requiredApprovalCount("ANY", 3)).toBe(1);
  });

  it("rejects node types that do not yet have an execution path", () => {
    const workflow = {
      ...DEFAULT_APPROVAL_WORKFLOWS[0],
      nodes: [{ ...DEFAULT_APPROVAL_WORKFLOWS[0].nodes[0], nodeType: "CONDITION" as const }],
    };
    expect(validateApprovalWorkflowDraft(workflow)).toContainEqual({
      path: "nodes.0.nodeType",
      message: "当前版本仅支持审批节点",
    });
  });

  it("stops automatic effect retries and requires an explicit retry after the limit", () => {
    expect(approvalEffectFailurePolicy(1)).toMatchObject({ status: "FAILED", requiresManualRetry: false });
    expect(approvalEffectFailurePolicy(APPROVAL_EFFECT_AUTOMATIC_RETRY_LIMIT)).toEqual({
      status: "MANUAL_REVIEW",
      nextDelayMinutes: null,
      requiresManualRetry: true,
    });
  });
});
