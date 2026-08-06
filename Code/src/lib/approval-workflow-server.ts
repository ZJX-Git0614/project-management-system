import { Prisma } from "@prisma/client";

import { TodoType } from "@/domain/enums";
import { getApprovalBusinessHandler, getApprovalCompletionHandler } from "@/lib/approval-business-registry";
import {
  APPROVAL_BUSINESS_TYPE_LABEL,
  DEFAULT_APPROVAL_WORKFLOWS,
  approvalEffectFailurePolicy,
  approvalActiveKey,
  normalizeApprovalWorkflowNodes,
  requiredApprovalCount,
  validateApprovalWorkflowDraft,
  type ApprovalWorkflowDraftInput,
  type ApprovalWorkflowNodeInput,
} from "@/lib/approval-workflow";
import { prisma } from "@/lib/prisma";
import { assertProjectAccess } from "@/lib/project-access";
import type { AuthenticatedUser } from "@/lib/server-auth";

type DbClient = Prisma.TransactionClient | typeof prisma;

const INSTANCE_INCLUDE = {
  project: { select: { id: true, name: true, code: true } },
  definition: true,
  version: true,
  nodes: {
    orderBy: { nodeOrder: "asc" as const },
    include: {
      assignments: { orderBy: { createdAt: "asc" as const } },
      submissions: { orderBy: { createdAt: "asc" as const } },
    },
  },
  effects: { orderBy: { createdAt: "asc" as const } },
  collaborationThread: true,
} satisfies Prisma.ApprovalWorkflowInstanceInclude;

const asObject = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const jsonInput = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;

const snapshotVersion = (version: Prisma.ApprovalWorkflowVersionGetPayload<{
  include: { definition: true; nodes: true };
}>) => ({
  definitionId: version.definitionId,
  versionId: version.id,
  businessType: version.definition.businessType,
  moduleKey: version.definition.moduleKey,
  name: version.definition.name,
  version: version.version,
  triggerPermissionKey: version.triggerPermissionKey,
  completionHandlerKey: version.completionHandlerKey,
  config: version.config,
  nodes: version.nodes.map((node) => ({
    id: node.id,
    nodeKey: node.nodeKey,
    nodeOrder: node.nodeOrder,
    nodeType: node.nodeType,
    nodeName: node.nodeName,
    assignmentType: node.assignmentType,
    projectRoleName: node.projectRoleName,
    accountId: node.accountId,
    approvalMode: node.approvalMode,
    requiredApprovals: node.requiredApprovals,
    returnTargetNodeKey: node.returnTargetNodeKey,
    reminderAfterHours: node.reminderAfterHours,
    reminderIntervalHours: node.reminderIntervalHours,
    conditionConfig: node.conditionConfig,
    actionsConfig: node.actionsConfig,
  })),
});

const createWorkflowVersion = async (
  db: DbClient,
  definitionId: string,
  versionNumber: number,
  input: ApprovalWorkflowDraftInput,
  operator: Pick<AuthenticatedUser, "userId" | "displayName">,
  status: "DRAFT" | "PUBLISHED",
) => {
  const nodes = normalizeApprovalWorkflowNodes(input.nodes);
  const issues = validateApprovalWorkflowDraft({ ...input, nodes });
  if (issues.length > 0) throw new Error(issues.map((item) => item.message).join("；"));
  return db.approvalWorkflowVersion.create({
    data: {
      definitionId,
      version: versionNumber,
      status,
      triggerPermissionKey: input.triggerPermissionKey || "",
      completionHandlerKey: input.completionHandlerKey || "",
      config: jsonInput(input.config ?? {}),
      publishedAt: status === "PUBLISHED" ? new Date() : null,
      publishedByAccountId: status === "PUBLISHED" ? operator.userId : "",
      publishedByName: status === "PUBLISHED" ? operator.displayName : "",
      nodes: {
        create: nodes.map((node) => ({
          nodeKey: node.nodeKey,
          nodeOrder: node.nodeOrder,
          nodeType: node.nodeType,
          nodeName: node.nodeName,
          assignmentType: node.assignmentType,
          projectRoleName: node.projectRoleName || "",
          accountId: node.accountId || "",
          approvalMode: node.approvalMode || "ALL",
          requiredApprovals: node.requiredApprovals || 1,
          returnTargetNodeKey: node.returnTargetNodeKey || "",
          reminderAfterHours: node.reminderAfterHours || 24,
          reminderIntervalHours: node.reminderIntervalHours || 24,
          conditionConfig: jsonInput(node.conditionConfig ?? {}),
          actionsConfig: jsonInput(node.actionsConfig ?? []),
        })),
      },
    },
    include: { nodes: { orderBy: { nodeOrder: "asc" } } },
  });
};

const assertPublishableCompletionHandler = (businessType: string, completionHandlerKey: string) => {
  const normalizedKey = completionHandlerKey.trim();
  if (!normalizedKey) throw new Error("发布审批流程前必须配置完成处理器");
  const handler = getApprovalCompletionHandler(normalizedKey);
  if (handler.businessType !== businessType) {
    throw new Error("审批完成处理器与业务类型不匹配");
  }
};

const ensureDefaultApprovalWorkflowsInTransaction = async (
  db: Prisma.TransactionClient,
  operator: Pick<AuthenticatedUser, "userId" | "displayName"> = { userId: "system", displayName: "系统" },
) => {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('ceastar-default-approval-workflows'))`;
  for (const seed of DEFAULT_APPROVAL_WORKFLOWS) {
    const definition = await db.approvalWorkflowDefinition.upsert({
      where: { businessType: seed.businessType },
      update: {},
      create: {
        businessType: seed.businessType,
        moduleKey: seed.moduleKey,
        name: seed.name,
        description: seed.description || "",
        enabled: seed.enabled ?? true,
        activeVersionNumber: 0,
        createdByAccountId: operator.userId,
        createdByName: operator.displayName,
        updatedByAccountId: operator.userId,
        updatedByName: operator.displayName,
      },
    });
    const existingVersion = await db.approvalWorkflowVersion.findUnique({
      where: { definitionId_version: { definitionId: definition.id, version: 1 } },
      select: { id: true },
    });
    if (existingVersion) continue;
    await createWorkflowVersion(db, definition.id, 1, seed, operator, "PUBLISHED");
    await db.approvalWorkflowDefinition.update({
      where: { id: definition.id },
      data: { activeVersionNumber: 1 },
    });
  }
};

export const ensureDefaultApprovalWorkflows = async (
  operator: Pick<AuthenticatedUser, "userId" | "displayName"> = { userId: "system", displayName: "系统" },
) => prisma.$transaction(
  (tx) => ensureDefaultApprovalWorkflowsInTransaction(tx, operator),
  { timeout: 15000 },
);

export const saveApprovalWorkflowDraft = async (
  input: ApprovalWorkflowDraftInput,
  operator: Pick<AuthenticatedUser, "userId" | "displayName">,
) => prisma.$transaction(async (tx) => {
  const nodes = normalizeApprovalWorkflowNodes(input.nodes);
  const normalized = { ...input, nodes };
  const issues = validateApprovalWorkflowDraft(normalized);
  if (issues.length > 0) throw new Error(issues.map((item) => item.message).join("；"));
  const definition = await tx.approvalWorkflowDefinition.upsert({
    where: { businessType: normalized.businessType },
    update: {
      moduleKey: normalized.moduleKey,
      name: normalized.name,
      description: normalized.description || "",
      enabled: normalized.enabled ?? true,
      updatedByAccountId: operator.userId,
      updatedByName: operator.displayName,
    },
    create: {
      businessType: normalized.businessType,
      moduleKey: normalized.moduleKey,
      name: normalized.name,
      description: normalized.description || "",
      enabled: normalized.enabled ?? true,
      createdByAccountId: operator.userId,
      createdByName: operator.displayName,
      updatedByAccountId: operator.userId,
      updatedByName: operator.displayName,
    },
  });
  const lastVersion = await tx.approvalWorkflowVersion.findFirst({
    where: { definitionId: definition.id },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = await createWorkflowVersion(tx, definition.id, (lastVersion?.version ?? 0) + 1, normalized, operator, "DRAFT");
  await tx.adminAuditLog.create({
    data: {
      actionType: "APPROVAL_WORKFLOW_DRAFT_SAVED",
      operator: operator.displayName,
      detail: `保存审批流程“${normalized.name}”草稿版本 v${version.version}`,
      snapshot: JSON.stringify({ businessType: normalized.businessType, versionId: version.id, version: version.version }),
    },
  });
  return version;
});

export const publishApprovalWorkflowVersion = async (
  versionId: string,
  operator: Pick<AuthenticatedUser, "userId" | "displayName">,
) => prisma.$transaction(async (tx) => {
  const version = await tx.approvalWorkflowVersion.findUnique({
    where: { id: versionId },
    include: { definition: true, nodes: { orderBy: { nodeOrder: "asc" } } },
  });
  if (!version) throw new Error("审批流程版本不存在");
  if (version.status === "PUBLISHED") return version;
  const draft: ApprovalWorkflowDraftInput = {
    businessType: version.definition.businessType,
    moduleKey: version.definition.moduleKey,
    name: version.definition.name,
    description: version.definition.description,
    enabled: version.definition.enabled,
    triggerPermissionKey: version.triggerPermissionKey,
    completionHandlerKey: version.completionHandlerKey,
    config: asObject(version.config),
    nodes: version.nodes.map((node) => ({
      nodeKey: node.nodeKey,
      nodeOrder: node.nodeOrder,
      nodeType: node.nodeType as ApprovalWorkflowNodeInput["nodeType"],
      nodeName: node.nodeName,
      assignmentType: node.assignmentType as ApprovalWorkflowNodeInput["assignmentType"],
      projectRoleName: node.projectRoleName,
      accountId: node.accountId,
      approvalMode: node.approvalMode as ApprovalWorkflowNodeInput["approvalMode"],
      requiredApprovals: node.requiredApprovals,
      returnTargetNodeKey: node.returnTargetNodeKey,
      reminderAfterHours: node.reminderAfterHours,
      reminderIntervalHours: node.reminderIntervalHours,
      conditionConfig: asObject(node.conditionConfig),
      actionsConfig: Array.isArray(node.actionsConfig) ? node.actionsConfig as unknown as ApprovalWorkflowNodeInput["actionsConfig"] : [],
    })),
  };
  const issues = validateApprovalWorkflowDraft(draft);
  if (issues.length > 0) throw new Error(issues.map((item) => item.message).join("；"));
  assertPublishableCompletionHandler(version.definition.businessType, version.completionHandlerKey);
  await tx.approvalWorkflowVersion.updateMany({
    where: { definitionId: version.definitionId, status: "PUBLISHED" },
    data: { status: "RETIRED" },
  });
  const published = await tx.approvalWorkflowVersion.update({
    where: { id: version.id },
    data: {
      status: "PUBLISHED",
      publishedAt: new Date(),
      publishedByAccountId: operator.userId,
      publishedByName: operator.displayName,
    },
    include: { nodes: { orderBy: { nodeOrder: "asc" } } },
  });
  await tx.approvalWorkflowDefinition.update({
    where: { id: version.definitionId },
    data: {
      activeVersionNumber: version.version,
      updatedByAccountId: operator.userId,
      updatedByName: operator.displayName,
    },
  });
  await tx.adminAuditLog.create({
    data: {
      actionType: "APPROVAL_WORKFLOW_PUBLISHED",
      operator: operator.displayName,
      detail: `发布审批流程“${version.definition.name}”版本 v${version.version}`,
      snapshot: JSON.stringify({ businessType: version.definition.businessType, versionId: version.id, version: version.version }),
    },
  });
  return published;
});

type ResolvedApprover = {
  accountId: string;
  displayName: string;
  projectMemberId: string | null;
  roleName: string;
  delegatedFromAccountId: string;
};

const activeDelegationFor = async (db: DbClient, projectId: string, accountId: string) => {
  const now = new Date();
  return db.approvalDelegation.findFirst({
    where: {
      fromAccountId: accountId,
      enabled: true,
      startsAt: { lte: now },
      endsAt: { gte: now },
      OR: [{ projectId }, { projectId: null }],
    },
    orderBy: { createdAt: "desc" },
  });
};

const resolveNodeApprovers = async (
  db: DbClient,
  projectId: string,
  requester: Pick<AuthenticatedUser, "userId" | "displayName">,
  node: Prisma.ApprovalWorkflowNodeDefinitionGetPayload<Record<string, never>>,
): Promise<ResolvedApprover[]> => {
  let approvers: ResolvedApprover[] = [];
  if (node.assignmentType === "REQUESTER") {
    approvers = [{ accountId: requester.userId, displayName: requester.displayName, projectMemberId: null, roleName: "发起人", delegatedFromAccountId: "" }];
  } else if (node.assignmentType === "ACCOUNT") {
    const account = await db.userAccount.findUnique({ where: { id: node.accountId }, select: { id: true, displayName: true, enabled: true } });
    if (account?.enabled) approvers = [{ accountId: account.id, displayName: account.displayName, projectMemberId: null, roleName: "指定账号", delegatedFromAccountId: "" }];
  } else {
    const members = await db.projectMember.findMany({
      where: { projectId, roleName: node.projectRoleName, accountId: { not: null } },
      include: { account: { select: { id: true, displayName: true, enabled: true } } },
      orderBy: { createdAt: "asc" },
    });
    approvers = members.flatMap((member) => member.account?.enabled ? [{
      accountId: member.account.id,
      displayName: member.account.displayName,
      projectMemberId: member.id,
      roleName: member.roleName,
      delegatedFromAccountId: "",
    }] : []);
  }
  if (approvers.length === 0) throw new Error(`审批节点“${node.nodeName}”没有可用审批账号`);
  const delegated = await Promise.all(approvers.map(async (approver) => {
    const delegation = await activeDelegationFor(db, projectId, approver.accountId);
    return delegation ? {
      accountId: delegation.toAccountId,
      displayName: delegation.toDisplayName,
      projectMemberId: approver.projectMemberId,
      roleName: approver.roleName,
      delegatedFromAccountId: approver.accountId,
    } : approver;
  }));
  return Array.from(new Map(delegated.map((item) => [item.accountId, item])).values());
};

const createAssignmentTodos = async (
  db: DbClient,
  params: { instanceId: string; projectId: string; nodeInstanceId: string; nodeName: string; title: string; summary: string; reminderAfterHours: number; reminderIntervalHours: number },
) => {
  const assignments = await db.approvalAssignment.findMany({ where: { nodeInstanceId: params.nodeInstanceId, status: "PENDING" } });
  const dueAt = new Date(Date.now() + params.reminderAfterHours * 60 * 60 * 1000);
  for (const assignment of assignments) {
    await db.todoItem.upsert({
      where: { approvalAssignmentId: assignment.id },
      update: { status: "OPEN", dueAt },
      create: {
        projectId: params.projectId,
        approvalInstanceId: params.instanceId,
        approvalAssignmentId: assignment.id,
        targetAccountId: assignment.accountId,
        title: params.title,
        detail: `${params.summary}；当前节点：${params.nodeName}`,
        targetRole: assignment.roleNameSnapshot,
        targetPersonName: assignment.displayNameSnapshot,
        type: TodoType.APPROVAL_PENDING,
        status: "OPEN",
        dueAt,
        reminderIntervalHours: params.reminderIntervalHours,
      },
    });
    await db.systemNotification.create({
      data: {
        projectId: params.projectId,
        accountId: assignment.accountId,
        category: "审批",
        title: params.title,
        detail: `审批已流转至“${params.nodeName}”`,
        severity: "INFO",
        sourceType: "APPROVAL_INSTANCE",
        sourceId: params.instanceId,
      },
    });
  }
};

const activateNode = async (db: DbClient, instanceId: string, nodeId: string) => {
  const node = await db.approvalNodeInstance.update({
    where: { id: nodeId },
    data: { status: "PENDING", activatedAt: new Date() },
    include: { assignments: true, instance: true },
  });
  await db.approvalWorkflowInstance.update({ where: { id: instanceId }, data: { currentNodeOrder: node.nodeOrder, revision: { increment: 1 } } });
  const config = asObject(node.config);
  await createAssignmentTodos(db, {
    instanceId,
    projectId: node.instance.projectId,
    nodeInstanceId: node.id,
    nodeName: node.nodeName,
    title: node.instance.title,
    summary: node.instance.summary,
    reminderAfterHours: Number(config.reminderAfterHours) || 24,
    reminderIntervalHours: Number(config.reminderIntervalHours) || 24,
  });
};

const createApprovalThread = async (
  db: DbClient,
  instance: { id: string; projectId: string; title: string; requesterAccountId: string; requesterName: string },
) => {
  const assignments = await db.approvalAssignment.findMany({
    where: { nodeInstance: { instanceId: instance.id } },
    select: { accountId: true, displayNameSnapshot: true, projectMemberId: true },
  });
  const participants = new Map<string, { accountId: string; displayName: string; projectMemberId: string | null; participantRole: string }>();
  participants.set(instance.requesterAccountId, { accountId: instance.requesterAccountId, displayName: instance.requesterName, projectMemberId: null, participantRole: "OWNER" });
  assignments.forEach((assignment) => participants.set(assignment.accountId, {
    accountId: assignment.accountId,
    displayName: assignment.displayNameSnapshot,
    projectMemberId: assignment.projectMemberId,
    participantRole: "APPROVER",
  }));
  const thread = await db.collaborationThread.create({
    data: {
      projectId: instance.projectId,
      approvalInstanceId: instance.id,
      kind: "APPROVAL",
      entityType: "ApprovalWorkflowInstance",
      entityId: instance.id,
      title: `审批协同：${instance.title}`,
      createdByAccountId: instance.requesterAccountId,
      createdByName: instance.requesterName,
      participants: { create: Array.from(participants.values()) },
    },
  });
  await db.collaborationMessage.create({
    data: {
      projectId: instance.projectId,
      threadId: thread.id,
      senderAccountId: "system",
      senderName: "系统",
      messageType: "APPROVAL_ROUTED",
      content: `审批已发起：${instance.title}`,
    },
  });
  return thread;
};

export const startApprovalWorkflow = async (params: {
  projectId: string;
  businessType: string;
  businessId: string;
  requester: AuthenticatedUser;
  payload?: Record<string, unknown>;
}) => {
  await ensureDefaultApprovalWorkflows(params.requester);
  return prisma.$transaction(async (tx) => {
  const project = await tx.project.findUnique({ where: { id: params.projectId }, select: { name: true } });
  if (!project) throw new Error("项目不存在");
  await assertProjectAccess(params.requester, params.projectId, tx);
  const activeKey = approvalActiveKey(params);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${activeKey}))`;
  const existing = await tx.approvalWorkflowInstance.findUnique({ where: { activeKey }, include: INSTANCE_INCLUDE });
  if (existing) return existing;
  const definition = await tx.approvalWorkflowDefinition.findUnique({ where: { businessType: params.businessType } });
  if (!definition?.enabled || definition.activeVersionNumber <= 0) {
    throw new Error(`审批流程未启用：${APPROVAL_BUSINESS_TYPE_LABEL[params.businessType] ?? params.businessType}`);
  }
  const version = await tx.approvalWorkflowVersion.findUnique({
    where: { definitionId_version: { definitionId: definition.id, version: definition.activeVersionNumber } },
    include: { definition: true, nodes: { orderBy: { nodeOrder: "asc" } } },
  });
  if (!version || version.status !== "PUBLISHED") throw new Error("审批流程没有已发布版本");
  const handler = getApprovalBusinessHandler(params.businessType);
  const payload = params.payload ?? {};
  await handler.validateStart(tx, { projectId: params.projectId, businessId: params.businessId, payload });
  const title = handler.buildTitle({ projectName: project.name, payload });
  const summary = handler.buildSummary({ projectName: project.name, payload });
  const firstApprovalNode = version.nodes.find((node) => node.nodeType === "APPROVAL");
  if (!firstApprovalNode) throw new Error("审批流程没有可执行节点");
  const instance = await tx.approvalWorkflowInstance.create({
    data: {
      projectId: params.projectId,
      definitionId: definition.id,
      versionId: version.id,
      businessType: params.businessType,
      businessId: params.businessId,
      activeKey,
      title,
      summary,
      status: "PENDING",
      requesterAccountId: params.requester.userId,
      requesterName: params.requester.displayName,
      currentNodeOrder: firstApprovalNode.nodeOrder,
      payload: jsonInput(payload),
      workflowSnapshot: jsonInput(snapshotVersion(version)),
    },
  });
  const nodeIds = new Map<string, string>();
  for (const node of version.nodes) {
    const nodeInstance = await tx.approvalNodeInstance.create({
      data: {
        instanceId: instance.id,
        definitionNodeId: node.id,
        nodeKey: node.nodeKey,
        nodeOrder: node.nodeOrder,
        nodeType: node.nodeType,
        nodeName: node.nodeName,
        status: node.nodeType === "APPROVAL" ? "WAITING" : "SKIPPED",
        approvalMode: node.approvalMode,
        requiredApprovals: node.requiredApprovals,
        returnTargetNodeKey: node.returnTargetNodeKey,
        config: jsonInput({
          reminderAfterHours: node.reminderAfterHours,
          reminderIntervalHours: node.reminderIntervalHours,
          conditionConfig: node.conditionConfig,
          actionsConfig: node.actionsConfig,
        }),
      },
    });
    nodeIds.set(node.nodeKey, nodeInstance.id);
    if (node.nodeType === "APPROVAL") {
      const approvers = await resolveNodeApprovers(tx, params.projectId, params.requester, node);
      const requiredApprovals = requiredApprovalCount(node.approvalMode as "ALL" | "ANY", approvers.length);
      await tx.approvalNodeInstance.update({ where: { id: nodeInstance.id }, data: { requiredApprovals } });
      await tx.approvalAssignment.createMany({
        data: approvers.map((approver) => ({
          nodeInstanceId: nodeInstance.id,
          projectMemberId: approver.projectMemberId,
          accountId: approver.accountId,
          displayNameSnapshot: approver.displayName,
          roleNameSnapshot: approver.roleName,
          delegatedFromAccountId: approver.delegatedFromAccountId,
        })),
      });
    }
  }
  const firstNodeInstanceId = nodeIds.get(firstApprovalNode.nodeKey);
  if (!firstNodeInstanceId) throw new Error("首个审批节点创建失败");
  await activateNode(tx, instance.id, firstNodeInstanceId);
  await createApprovalThread(tx, instance);
  await tx.operationHistory.create({
    data: {
      projectId: params.projectId,
      entityType: "ApprovalWorkflowInstance",
      entityId: instance.id,
      actionType: "APPROVAL_START",
      operator: params.requester.displayName,
      detail: `发起审批“${title}”，流程版本 v${version.version}`,
    },
  });
  return tx.approvalWorkflowInstance.findUniqueOrThrow({ where: { id: instance.id }, include: INSTANCE_INCLUDE });
  }, { timeout: 15000 });
};

const completeOpenTodos = (db: DbClient, instanceId: string, status = "DONE") => db.todoItem.updateMany({
  where: { approvalInstanceId: instanceId, status: "OPEN" },
  data: { status },
});

const markApprovalNotificationsRead = (db: DbClient, instanceId: string) => db.systemNotification.updateMany({
  where: { sourceType: "APPROVAL_INSTANCE", sourceId: instanceId, status: "UNREAD" },
  data: { status: "READ", readAt: new Date() },
});

const notifyApprovalRequester = (
  db: DbClient,
  instance: { id: string; projectId: string; requesterAccountId: string; title: string },
  detail: string,
  severity: "INFO" | "WARNING" | "ERROR" = "INFO",
) => db.systemNotification.create({
  data: {
    projectId: instance.projectId,
    accountId: instance.requesterAccountId,
    category: "审批",
    title: instance.title,
    detail,
    severity,
    sourceType: "APPROVAL_INSTANCE",
    sourceId: instance.id,
  },
});

const appendApprovalMessage = async (db: DbClient, instanceId: string, sender: Pick<AuthenticatedUser, "userId" | "displayName">, content: string) => {
  const thread = await db.collaborationThread.findUnique({ where: { approvalInstanceId: instanceId } });
  if (!thread) return;
  const now = new Date();
  await db.collaborationMessage.create({
    data: { projectId: thread.projectId, threadId: thread.id, senderAccountId: sender.userId, senderName: sender.displayName, messageType: "APPROVAL_EVENT", content },
  });
  await db.collaborationThread.update({ where: { id: thread.id }, data: { lastMessageAt: now } });
};

const enqueueCompletionEffect = async (db: DbClient, instanceId: string) => {
  const instance = await db.approvalWorkflowInstance.findUnique({ where: { id: instanceId }, include: { version: true } });
  if (!instance) throw new Error("审批实例不存在");
  const handlerKey = instance.version?.completionHandlerKey || "";
  if (!handlerKey) throw new Error("审批流程未配置完成处理器");
  return db.approvalEffect.upsert({
    where: { idempotencyKey: `${instance.id}:${handlerKey}` },
    update: {},
    create: { instanceId: instance.id, handlerKey, idempotencyKey: `${instance.id}:${handlerKey}`, payload: jsonInput(instance.payload) },
  });
};

export const processApprovalAction = async (params: {
  instanceId: string;
  action: "approve" | "reject" | "return";
  comment?: string;
  operator: AuthenticatedUser;
}) => {
  const transition = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "ApprovalWorkflowInstance" WHERE "id" = ${params.instanceId} FOR UPDATE`;
    const instance = await tx.approvalWorkflowInstance.findUnique({
      where: { id: params.instanceId },
      include: { nodes: { orderBy: { nodeOrder: "asc" }, include: { assignments: true, submissions: true } } },
    });
    if (!instance) throw new Error("审批实例不存在");
    if (instance.status !== "PENDING") throw new Error("该审批已结束");
    const currentNode = instance.nodes.find((node) => node.status === "PENDING");
    if (!currentNode) throw new Error("当前没有待处理审批节点");
    const assignment = currentNode.assignments.find((item) => item.accountId === params.operator.userId && item.status === "PENDING");
    if (!assignment) throw new Error("当前账号不是该节点的待审批人");
    const comment = String(params.comment || "").trim();
    if (params.action !== "approve" && !comment) throw new Error("退回或拒绝时必须填写原因");
    if (params.action === "approve") {
      const config = asObject(currentNode.config);
      const actions = Array.isArray(config.actionsConfig) ? config.actionsConfig : [];
      const completedKeys = new Set(currentNode.submissions.filter((item) => item.status === "COMPLETED").map((item) => item.actionKey));
      const missing = actions.filter((item) => {
        const record = asObject(item);
        return Boolean(record.required) && !completedKeys.has(String(record.actionKey || ""));
      });
      if (missing.length > 0) throw new Error(`请先完成节点动作：${missing.map((item) => String(asObject(item).actionName || "未命名动作")).join("、")}`);
    }
    const claimed = await tx.approvalAssignment.updateMany({
      where: { id: assignment.id, status: "PENDING" },
      data: { status: params.action === "approve" ? "APPROVED" : params.action === "reject" ? "REJECTED" : "RETURNED", comment, processedAt: new Date() },
    });
    if (claimed.count !== 1) throw new Error("该审批已被处理，请刷新后查看");
    await tx.todoItem.updateMany({ where: { approvalAssignmentId: assignment.id, status: "OPEN" }, data: { status: "DONE" } });
    await tx.systemNotification.updateMany({
      where: {
        accountId: params.operator.userId,
        sourceType: "APPROVAL_INSTANCE",
        sourceId: instance.id,
        status: "UNREAD",
      },
      data: { status: "READ", readAt: new Date() },
    });
    if (params.action !== "approve") {
      const finalStatus = params.action === "reject" ? "REJECTED" : "RETURNED";
      await tx.approvalNodeInstance.update({ where: { id: currentNode.id }, data: { status: finalStatus, completedAt: new Date(), resultComment: comment } });
      await tx.approvalWorkflowInstance.update({ where: { id: instance.id }, data: { status: finalStatus, activeKey: null, completedAt: new Date(), resultComment: comment, revision: { increment: 1 } } });
      await tx.approvalAssignment.updateMany({
        where: { nodeInstance: { instanceId: instance.id }, status: "PENDING" },
        data: { status: "SKIPPED" },
      });
      await completeOpenTodos(tx, instance.id, "CANCELED");
      await markApprovalNotificationsRead(tx, instance.id);
      await notifyApprovalRequester(
        tx,
        instance,
        params.action === "reject" ? `审批已被拒绝：${comment}` : `审批已被退回：${comment}`,
        "WARNING",
      );
      await appendApprovalMessage(tx, instance.id, params.operator, `${params.action === "reject" ? "拒绝" : "退回"}审批：${comment}`);
      return { instanceId: instance.id, runEffect: false };
    }
    // Re-read after claiming this assignment; the original node snapshot can be
    // stale when multiple approvers submit at nearly the same time.
    const approvedCount = await tx.approvalAssignment.count({
      where: { nodeInstanceId: currentNode.id, status: "APPROVED" },
    });
    if (approvedCount < currentNode.requiredApprovals) {
      await appendApprovalMessage(tx, instance.id, params.operator, `已同意节点“${currentNode.nodeName}”`);
      return { instanceId: instance.id, runEffect: false };
    }
    await tx.approvalNodeInstance.update({ where: { id: currentNode.id }, data: { status: "APPROVED", completedAt: new Date(), resultComment: comment } });
    await tx.approvalAssignment.updateMany({ where: { nodeInstanceId: currentNode.id, status: "PENDING" }, data: { status: "SKIPPED" } });
    await tx.todoItem.updateMany({ where: { approvalInstanceId: instance.id, status: "OPEN" }, data: { status: "DONE" } });
    await markApprovalNotificationsRead(tx, instance.id);
    const nextNode = instance.nodes.find((node) => node.nodeOrder > currentNode.nodeOrder && node.nodeType === "APPROVAL" && node.status === "WAITING");
    if (nextNode) {
      await activateNode(tx, instance.id, nextNode.id);
      await appendApprovalMessage(tx, instance.id, params.operator, `节点“${currentNode.nodeName}”已通过，流转至“${nextNode.nodeName}”`);
      return { instanceId: instance.id, runEffect: false };
    }
    await enqueueCompletionEffect(tx, instance.id);
    await appendApprovalMessage(tx, instance.id, params.operator, "全部审批节点已通过，正在执行业务结果");
    return { instanceId: instance.id, runEffect: true };
  }, { timeout: 15000 });
  if (transition.runEffect) await runApprovalEffects(transition.instanceId);
  return prisma.approvalWorkflowInstance.findUniqueOrThrow({ where: { id: transition.instanceId }, include: INSTANCE_INCLUDE });
};

export const runApprovalEffects = async (instanceId?: string) => {
  const effects = await prisma.approvalEffect.findMany({
    where: {
      ...(instanceId ? { instanceId } : {}),
      status: { in: ["PENDING", "FAILED"] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  for (const effect of effects) {
    const claimed = await prisma.approvalEffect.updateMany({
      where: { id: effect.id, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "RUNNING", attemptCount: { increment: 1 }, errorMessage: "" },
    });
    if (claimed.count !== 1) continue;
    try {
      await prisma.$transaction(async (tx) => {
        const runningEffect = await tx.approvalEffect.findUnique({ where: { id: effect.id } });
        if (!runningEffect || runningEffect.status !== "RUNNING") return;
        await tx.$queryRaw`SELECT "id" FROM "ApprovalWorkflowInstance" WHERE "id" = ${effect.instanceId} FOR UPDATE`;
        const instance = await tx.approvalWorkflowInstance.findUniqueOrThrow({ where: { id: effect.instanceId } });
        if (!(["PENDING", "COMPLETION_FAILED"] as string[]).includes(instance.status)) {
          await tx.approvalEffect.update({
            where: { id: runningEffect.id },
            data: { status: "CANCELED", completedAt: new Date(), nextAttemptAt: null },
          });
          return;
        }
        const handler = getApprovalCompletionHandler(runningEffect.handlerKey);
        if (handler.businessType !== instance.businessType) throw new Error("审批完成处理器与业务类型不匹配");
        const outcome = await handler.apply(tx, instance);
        await tx.approvalWorkflowInstance.update({
          where: { id: instance.id },
          data: { status: "APPROVED", activeKey: null, completedAt: new Date(), lastError: "", revision: { increment: 1 } },
        });
        await tx.operationHistory.create({
          data: { projectId: instance.projectId, entityType: "ApprovalWorkflowInstance", entityId: instance.id, actionType: "APPROVAL_APPROVE", operator: instance.requesterName, detail: `审批通过并完成业务执行：${instance.title}` },
        });
        await notifyApprovalRequester(tx, instance, "审批已通过，业务结果已执行完成");
        await tx.approvalEffect.update({
          where: { id: runningEffect.id },
          data: { status: "SUCCEEDED", result: jsonInput(outcome), completedAt: new Date(), nextAttemptAt: null },
        });
      }, { timeout: 15000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "审批业务执行失败";
      const completedAttemptCount = effect.attemptCount + 1;
      const failurePolicy = approvalEffectFailurePolicy(completedAttemptCount);
      const nextAttemptAt = failurePolicy.nextDelayMinutes === null
        ? null
        : new Date(Date.now() + failurePolicy.nextDelayMinutes * 60 * 1000);
      await prisma.$transaction(async (tx) => {
        const failed = await tx.approvalEffect.updateMany({
          where: { id: effect.id, status: "RUNNING" },
          data: { status: failurePolicy.status, errorMessage: message, nextAttemptAt },
        });
        if (failed.count !== 1) return;
        const instanceUpdated = await tx.approvalWorkflowInstance.updateMany({
          where: { id: effect.instanceId, status: { in: ["PENDING", "COMPLETION_FAILED"] } },
          data: { status: "COMPLETION_FAILED", lastError: message, revision: { increment: 1 } },
        });
        if (instanceUpdated.count !== 1) return;
        const instance = await tx.approvalWorkflowInstance.findUniqueOrThrow({ where: { id: effect.instanceId } });
        if (completedAttemptCount === 1 || failurePolicy.requiresManualRetry) {
          await notifyApprovalRequester(
            tx,
            instance,
            failurePolicy.requiresManualRetry
              ? `审批已通过，但业务结果连续执行失败，已停止自动重试，请管理员核查后手动重试：${message}`
              : `审批已通过，但业务结果执行失败，系统将自动重试：${message}`,
            "ERROR",
          );
        }
      });
    }
  }
};

export const retryApprovalEffect = async (instanceId: string) => {
  await prisma.approvalEffect.updateMany({
    where: { instanceId, status: { in: ["FAILED", "MANUAL_REVIEW"] } },
    data: { status: "PENDING", nextAttemptAt: null, attemptCount: 0 },
  });
  await prisma.approvalWorkflowInstance.updateMany({ where: { id: instanceId, status: "COMPLETION_FAILED" }, data: { status: "PENDING", lastError: "" } });
  await runApprovalEffects(instanceId);
  return prisma.approvalWorkflowInstance.findUniqueOrThrow({ where: { id: instanceId }, include: INSTANCE_INCLUDE });
};

export const cancelApprovalWorkflow = async (params: { instanceId: string; operator: AuthenticatedUser; reason: string; allowAny?: boolean }) => prisma.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT "id" FROM "ApprovalWorkflowInstance" WHERE "id" = ${params.instanceId} FOR UPDATE`;
  const instance = await tx.approvalWorkflowInstance.findUnique({ where: { id: params.instanceId } });
  if (!instance) throw new Error("审批实例不存在");
  if (instance.status !== "PENDING" && instance.status !== "COMPLETION_FAILED") throw new Error("该审批已结束");
  if (!params.allowAny && instance.requesterAccountId !== params.operator.userId) throw new Error("仅发起人可以撤销审批");
  const reason = params.reason.trim();
  if (!reason) throw new Error("撤销时必须填写原因");
  await tx.approvalWorkflowInstance.update({ where: { id: instance.id }, data: { status: "CANCELED", activeKey: null, completedAt: new Date(), resultComment: reason, revision: { increment: 1 } } });
  await tx.approvalNodeInstance.updateMany({ where: { instanceId: instance.id, status: { in: ["PENDING", "WAITING"] } }, data: { status: "SKIPPED", completedAt: new Date() } });
  await tx.approvalAssignment.updateMany({ where: { nodeInstance: { instanceId: instance.id }, status: "PENDING" }, data: { status: "SKIPPED" } });
  await tx.approvalEffect.updateMany({
    where: { instanceId: instance.id, status: { in: ["PENDING", "FAILED", "MANUAL_REVIEW", "RUNNING"] } },
    data: { status: "CANCELED", completedAt: new Date(), nextAttemptAt: null },
  });
  await completeOpenTodos(tx, instance.id, "CANCELED");
  await markApprovalNotificationsRead(tx, instance.id);
  await notifyApprovalRequester(tx, instance, `审批已撤销：${reason}`, "WARNING");
  await appendApprovalMessage(tx, instance.id, params.operator, `撤销审批：${reason}`);
  return tx.approvalWorkflowInstance.findUniqueOrThrow({ where: { id: instance.id }, include: INSTANCE_INCLUDE });
});

export const submitApprovalNodeAction = async (params: {
  instanceId: string;
  nodeInstanceId: string;
  actionKey: string;
  actionType: string;
  actionName: string;
  data?: Record<string, unknown>;
  operator: AuthenticatedUser;
}) => prisma.$transaction(async (tx) => {
  const node = await tx.approvalNodeInstance.findUnique({ where: { id: params.nodeInstanceId }, include: { assignments: true } });
  if (!node || node.instanceId !== params.instanceId || node.status !== "PENDING") throw new Error("审批节点不可提交动作");
  if (!node.assignments.some((item) => item.accountId === params.operator.userId && item.status === "PENDING")) throw new Error("当前账号不是该节点审批人");
  return tx.approvalSubmission.upsert({
    where: { nodeInstanceId_actionKey_submittedByAccountId: { nodeInstanceId: node.id, actionKey: params.actionKey, submittedByAccountId: params.operator.userId } },
    update: { actionType: params.actionType, actionName: params.actionName, status: "COMPLETED", data: jsonInput(params.data ?? {}), submittedByName: params.operator.displayName },
    create: { nodeInstanceId: node.id, actionKey: params.actionKey, actionType: params.actionType, actionName: params.actionName, data: jsonInput(params.data ?? {}), submittedByAccountId: params.operator.userId, submittedByName: params.operator.displayName },
  });
});

export const serializeApprovalInstance = <T extends { createdAt: Date; updatedAt: Date; requestedAt: Date; completedAt: Date | null }>(instance: T) => ({
  ...instance,
  createdAt: instance.createdAt.toISOString(),
  updatedAt: instance.updatedAt.toISOString(),
  requestedAt: instance.requestedAt.toISOString(),
  completedAt: instance.completedAt?.toISOString() ?? null,
});

export { INSTANCE_INCLUDE };
