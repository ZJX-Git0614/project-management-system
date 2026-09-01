import { prisma } from "@/lib/prisma";
import { deleteGanttTaskSubtrees, renumberProjectGanttTaskCodes } from "@/lib/gantt-task-service";
import { synchronizeGanttOwnerHierarchy } from "@/lib/gantt-owner-service";

const PROJECT_ID = "cmqwl8i1g000piqdjjan9j5p8";
const OPERATOR_USER_ID = "cmqwl8hzt000niqdjamrh1e7f";
const OPERATOR_NAME = "赵佳鑫";

type OwnerKey = "projectManager" | "productManager" | "researchLead" | "backendEngineer" | "simulationLead" | "simulationEngineer" | "frontendLead" | "frontendEngineer";

type WbsNode = {
  key: string;
  parentKey?: string;
  taskName: string;
  owner?: OwnerKey;
  predecessorKeys?: string[];
};

// Built only from the existing front-end functional list, back-end task list,
// and self-developed simulation-engine task list. Schedule fields intentionally
// stay empty so the project manager can establish the plan afterwards.
const WBS: WbsNode[] = [
  { key: "project", taskName: "网络状态控制设备软件项目" },

  { key: "foundation", parentKey: "project", taskName: "项目启动与总体设计" },
  { key: "foundation_requirements", parentKey: "foundation", taskName: "需求与总体设计" },
  { key: "foundation_architecture", parentKey: "foundation_requirements", taskName: "需求与架构" },
  { key: "foundation_requirements_definition", parentKey: "foundation_architecture", taskName: "需求梳理与验收定义", owner: "productManager" },
  { key: "foundation_system_architecture", parentKey: "foundation_architecture", taskName: "总体架构与接口边界", owner: "researchLead", predecessorKeys: ["foundation_requirements_definition"] },
  { key: "foundation_preparation", parentKey: "foundation", taskName: "项目实施准备" },
  { key: "foundation_preparation_setup", parentKey: "foundation_preparation", taskName: "开发与测试准备" },
  { key: "foundation_plan_coordination", parentKey: "foundation_preparation_setup", taskName: "项目计划与协同机制", owner: "projectManager", predecessorKeys: ["foundation_requirements_definition"] },
  { key: "foundation_environment", parentKey: "foundation_preparation_setup", taskName: "开发与测试环境准备", owner: "researchLead", predecessorKeys: ["foundation_system_architecture"] },

  { key: "platform", parentKey: "project", taskName: "平台与基础服务" },
  { key: "platform_information", parentKey: "platform", taskName: "信息管理" },
  { key: "platform_access_audit", parentKey: "platform_information", taskName: "账号权限与审计" },
  { key: "platform_auth", parentKey: "platform_access_audit", taskName: "统一认证与权限控制", owner: "backendEngineer", predecessorKeys: ["foundation_system_architecture"] },
  { key: "platform_audit", parentKey: "platform_access_audit", taskName: "日志与审计", owner: "backendEngineer", predecessorKeys: ["platform_auth"] },
  { key: "platform_data_protection", parentKey: "platform_information", taskName: "地理气象与数据保障" },
  { key: "platform_geo_weather", parentKey: "platform_data_protection", taskName: "地理环境与气象数据管理", owner: "backendEngineer", predecessorKeys: ["foundation_system_architecture"] },
  { key: "platform_backup", parentKey: "platform_data_protection", taskName: "数据备份与恢复", owner: "backendEngineer", predecessorKeys: ["platform_audit"] },
  { key: "platform_device", parentKey: "platform", taskName: "设备管理" },
  { key: "platform_device_configuration", parentKey: "platform_device", taskName: "设备资产与通信配置" },
  { key: "platform_device_information", parentKey: "platform_device_configuration", taskName: "设备清单与基础信息管理", owner: "backendEngineer", predecessorKeys: ["foundation_system_architecture"] },
  { key: "platform_serial_network_time", parentKey: "platform_device_configuration", taskName: "串口、网口与时间同步配置", owner: "backendEngineer", predecessorKeys: ["platform_device_information"] },
  { key: "platform_communication_mapping", parentKey: "platform_device_configuration", taskName: "通信参数与节点映射", owner: "backendEngineer", predecessorKeys: ["platform_serial_network_time"] },
  { key: "platform_device_operations", parentKey: "platform_device", taskName: "设备监控与运维" },
  { key: "platform_heartbeat_operations", parentKey: "platform_device_operations", taskName: "心跳告警与设备运维", owner: "backendEngineer", predecessorKeys: ["platform_device_information"] },

  { key: "scenario_models", parentKey: "project", taskName: "想定与模型管理" },
  { key: "scenario", parentKey: "scenario_models", taskName: "想定管理" },
  { key: "scenario_lifecycle", parentKey: "scenario", taskName: "想定生命周期" },
  { key: "scenario_lifecycle_management", parentKey: "scenario_lifecycle", taskName: "想定创建、编辑与版本管理", owner: "backendEngineer", predecessorKeys: ["foundation_system_architecture"] },
  { key: "scenario_import_export", parentKey: "scenario_lifecycle", taskName: "想定导入导出与复制", owner: "backendEngineer", predecessorKeys: ["scenario_lifecycle_management"] },
  { key: "scenario_modelling", parentKey: "scenario", taskName: "场景建模与分析" },
  { key: "scenario_platform_deployment", parentKey: "scenario_modelling", taskName: "平台部署与参数配置", owner: "frontendEngineer", predecessorKeys: ["scenario_lifecycle_management"] },
  { key: "scenario_topology_route_formation", parentKey: "scenario_modelling", taskName: "网络拓扑、航线与编队编辑", owner: "frontendEngineer", predecessorKeys: ["scenario_platform_deployment"] },
  { key: "scenario_environment", parentKey: "scenario_modelling", taskName: "地理气象环境设置", owner: "frontendEngineer", predecessorKeys: ["platform_geo_weather", "scenario_platform_deployment"] },
  { key: "scenario_spectrum_los_budget", parentKey: "scenario_modelling", taskName: "频谱、视距与链路预算", owner: "simulationEngineer", predecessorKeys: ["scenario_topology_route_formation"] },
  { key: "model", parentKey: "scenario_models", taskName: "模型管理" },
  { key: "model_platform_components", parentKey: "model", taskName: "平台模型与组件" },
  { key: "model_platform_organization", parentKey: "model_platform_components", taskName: "平台模型与组织架构管理", owner: "simulationLead", predecessorKeys: ["foundation_system_architecture"] },
  { key: "model_communication_components", parentKey: "model_platform_components", taskName: "通信组件参数与方向图管理", owner: "simulationEngineer", predecessorKeys: ["model_platform_organization"] },

  { key: "engine_simulation", parentKey: "project", taskName: "仿真引擎与推演控制" },
  { key: "simulation_engine", parentKey: "engine_simulation", taskName: "仿真引擎" },
  { key: "engine_core", parentKey: "simulation_engine", taskName: "引擎基础与对象模型" },
  { key: "engine_afsim", parentKey: "engine_core", taskName: "AFSIM 构建部署", owner: "simulationLead", predecessorKeys: ["foundation_environment"] },
  { key: "engine_runtime", parentKey: "engine_core", taskName: "仿真实例与运行时对象管理", owner: "simulationEngineer", predecessorKeys: ["engine_afsim"] },
  { key: "engine_time_output", parentKey: "engine_core", taskName: "仿真时间推进、动态指令与数据输出", owner: "simulationEngineer", predecessorKeys: ["engine_runtime"] },
  { key: "engine_communication", parentKey: "simulation_engine", taskName: "通信与传播模型" },
  { key: "engine_common_communication", parentKey: "engine_communication", taskName: "通信链路公共能力", owner: "simulationEngineer", predecessorKeys: ["engine_runtime"] },
  { key: "engine_multi_standard", parentKey: "engine_communication", taskName: "多制式通信装备组件", owner: "simulationEngineer", predecessorKeys: ["engine_common_communication"] },
  { key: "engine_itu", parentKey: "engine_communication", taskName: "ITU 传播计算服务", owner: "simulationEngineer", predecessorKeys: ["engine_common_communication"] },
  { key: "simulation_control", parentKey: "engine_simulation", taskName: "仿真推演" },
  { key: "simulation_task_control", parentKey: "simulation_control", taskName: "推演控制与训练计划" },
  { key: "simulation_offline_online", parentKey: "simulation_task_control", taskName: "离线仿真任务与在线控制", owner: "simulationLead", predecessorKeys: ["engine_runtime", "scenario_lifecycle_management"] },
  { key: "simulation_training_realtime", parentKey: "simulation_task_control", taskName: "训练计划与实时数据接入", owner: "backendEngineer", predecessorKeys: ["simulation_offline_online"] },
  { key: "simulation_realtime_directing", parentKey: "simulation_control", taskName: "实时接入与导调" },
  { key: "simulation_realtime_input", parentKey: "simulation_realtime_directing", taskName: "实时数据接入", owner: "backendEngineer", predecessorKeys: ["simulation_training_realtime"] },
  { key: "simulation_directing_feedback", parentKey: "simulation_realtime_directing", taskName: "导调指令与执行反馈", owner: "backendEngineer", predecessorKeys: ["simulation_realtime_input"] },

  { key: "frontend", parentKey: "project", taskName: "前端应用与交互" },
  { key: "frontend_dashboard", parentKey: "frontend", taskName: "首页与工作台" },
  { key: "frontend_entry_status", parentKey: "frontend_dashboard", taskName: "系统入口与状态通知" },
  { key: "frontend_navigation_status", parentKey: "frontend_entry_status", taskName: "模块导航、动态拓扑与状态通知", owner: "frontendLead", predecessorKeys: ["platform_auth", "foundation_environment"] },
  { key: "frontend_business", parentKey: "frontend", taskName: "业务应用界面" },
  { key: "frontend_information_device_model", parentKey: "frontend_business", taskName: "信息、设备与模型界面" },
  { key: "frontend_information_device_model_ui", parentKey: "frontend_information_device_model", taskName: "信息、设备与模型管理界面", owner: "frontendLead", predecessorKeys: ["platform_audit", "platform_serial_network_time", "model_communication_components"] },
  { key: "frontend_scenario_simulation", parentKey: "frontend_business", taskName: "想定、仿真与分析界面" },
  { key: "frontend_scenario_map_control", parentKey: "frontend_scenario_simulation", taskName: "想定编辑、三维地图与仿真控制界面", owner: "frontendEngineer", predecessorKeys: ["scenario_topology_route_formation", "simulation_offline_online"] },
  { key: "frontend_analysis_hitl", parentKey: "frontend_scenario_simulation", taskName: "态势分析与人机在环交互界面", owner: "frontendEngineer", predecessorKeys: ["scenario_spectrum_los_budget", "simulation_realtime_input"] },

  { key: "integration_delivery", parentKey: "project", taskName: "集成测试与交付" },
  { key: "system_integration", parentKey: "integration_delivery", taskName: "系统集成" },
  { key: "integration_external_device_engine", parentKey: "system_integration", taskName: "外部服务、设备与引擎联调" },
  { key: "integration_external_services", parentKey: "integration_external_device_engine", taskName: "外部身份、平台与训练计划服务联调", owner: "researchLead", predecessorKeys: ["platform_auth", "scenario_import_export", "simulation_training_realtime"] },
  { key: "integration_geo_communication_directing", parentKey: "integration_external_device_engine", taskName: "地理、通信与导调服务联调", owner: "researchLead", predecessorKeys: ["platform_geo_weather", "scenario_spectrum_los_budget", "simulation_directing_feedback"] },
  { key: "integration_device_engine_frontend", parentKey: "integration_external_device_engine", taskName: "设备、仿真引擎与前端联调", owner: "researchLead", predecessorKeys: ["platform_communication_mapping", "engine_multi_standard", "engine_time_output", "frontend_information_device_model_ui", "frontend_scenario_map_control"] },
  { key: "testing_delivery", parentKey: "integration_delivery", taskName: "测试、验收与交付" },
  { key: "testing_acceptance_delivery", parentKey: "testing_delivery", taskName: "测试验收与交付" },
  { key: "testing_functional", parentKey: "testing_acceptance_delivery", taskName: "功能测试与缺陷闭环", owner: "projectManager", predecessorKeys: ["integration_external_services", "integration_geo_communication_directing", "integration_device_engine_frontend"] },
  { key: "testing_performance", parentKey: "testing_acceptance_delivery", taskName: "性能、稳定性与安全测试", owner: "researchLead", predecessorKeys: ["testing_functional"] },
  { key: "testing_uat", parentKey: "testing_acceptance_delivery", taskName: "用户验收与问题整改", owner: "projectManager", predecessorKeys: ["testing_performance"] },
  { key: "testing_delivery_docs", parentKey: "testing_acceptance_delivery", taskName: "部署文档与交付培训", owner: "productManager", predecessorKeys: ["testing_uat"] },
];

const OWNER_NAMES: Record<OwnerKey, string> = {
  projectManager: "赵佳鑫",
  productManager: "郑礼文",
  researchLead: "丁荣盛",
  backendEngineer: "孟洵",
  simulationLead: "张明峰",
  simulationEngineer: "葛福星",
  frontendLead: "苗松",
  frontendEngineer: "姚家福",
};

const unique = <T>(values: T[]) => [...new Set(values)];

const hierarchyDepthByKey = (nodesByKey: Map<string, WbsNode>, key: string, path = new Set<string>()): number => {
  if (path.has(key)) throw new Error(`WBS 层级存在循环：${key}`);
  const node = nodesByKey.get(key);
  if (!node) throw new Error(`WBS 节点不存在：${key}`);
  if (!node.parentKey) return 1;
  return hierarchyDepthByKey(nodesByKey, node.parentKey, new Set(path).add(key)) + 1;
};

const categoryForKey = (nodesByKey: Map<string, WbsNode>, key: string): string => {
  const parts: string[] = [];
  let current = nodesByKey.get(key);
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.key)) throw new Error(`WBS 类别路径存在循环：${current.key}`);
    visited.add(current.key);
    parts.unshift(current.taskName);
    current = current.parentKey ? nodesByKey.get(current.parentKey) : undefined;
  }
  return parts.join(" / ");
};

const validateWbs = () => {
  if (WBS.length > 80) throw new Error(`WBS 条数 ${WBS.length} 超过上限 80`);
  const nodesByKey = new Map(WBS.map((node) => [node.key, node]));
  if (nodesByKey.size !== WBS.length) throw new Error("WBS 节点键重复");
  const roots = WBS.filter((node) => !node.parentKey);
  if (roots.length !== 1) throw new Error(`WBS 必须只有一个根任务，当前为 ${roots.length} 个`);

  const parentKeys = new Set(WBS.flatMap((node) => node.parentKey ? [node.parentKey] : []));
  const leafCount = WBS.filter((node) => !parentKeys.has(node.key)).length;
  const depths = WBS.map((node) => hierarchyDepthByKey(nodesByKey, node.key));
  const maxDepth = Math.max(...depths);
  const minLeafDepth = Math.min(...WBS.filter((node) => !parentKeys.has(node.key)).map((node) => hierarchyDepthByKey(nodesByKey, node.key)));
  if (maxDepth < 4 || maxDepth > 6 || minLeafDepth < 4) {
    throw new Error(`WBS 层级不符合 4-6 层要求：最大 ${maxDepth} 层，末级最浅 ${minLeafDepth} 层`);
  }

  for (const node of WBS) {
    if (node.parentKey && !nodesByKey.has(node.parentKey)) throw new Error(`父任务不存在：${node.key} -> ${node.parentKey}`);
    if (parentKeys.has(node.key) && node.owner) throw new Error(`父任务不得直接指定负责人：${node.taskName}`);
    if (!parentKeys.has(node.key) && !node.owner) throw new Error(`末级任务必须指定负责人：${node.taskName}`);
    const predecessors = unique(node.predecessorKeys ?? []);
    if (predecessors.some((key) => key === node.key || !nodesByKey.has(key))) {
      throw new Error(`紧前任务无效：${node.taskName}`);
    }
  }

  const successors = new Map<string, string[]>();
  WBS.forEach((node) => (node.predecessorKeys ?? []).forEach((predecessorKey) => {
    successors.set(predecessorKey, [...(successors.get(predecessorKey) ?? []), node.key]);
  }));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    const cyclic = (successors.get(key) ?? []).some(visit);
    visiting.delete(key);
    visited.add(key);
    return cyclic;
  };
  if (WBS.some((node) => visit(node.key))) throw new Error("WBS 紧前任务存在循环依赖");

  return { nodesByKey, parentKeys, leafCount, maxDepth };
};

const rebuild = async () => {
  if (process.env.PMS_CONFIRM_REBUILD !== "YES") {
    throw new Error("这是破坏性数据操作。请使用 PMS_CONFIRM_REBUILD=YES npx tsx scripts/rebuild-f26007-wbs.ts 明确执行。");
  }

  const { nodesByKey, leafCount, maxDepth } = validateWbs();
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: PROJECT_ID },
    select: {
      id: true,
      name: true,
      code: true,
      ganttBaselineState: true,
      ganttBaselineVersion: true,
    },
  });
  if (project.ganttBaselineState === "PUBLISHED" || project.ganttBaselineVersion > 0) {
    throw new Error("当前项目已有已发布 WBS 基线，不能直接替换任务。请先创建并确认变更基线。");
  }

  const members = await prisma.projectMember.findMany({
    where: { projectId: PROJECT_ID },
    select: { id: true, personName: true },
  });
  const memberIdByName = new Map(members.map((member) => [member.personName, member.id]));
  const memberIdByOwnerKey = new Map<OwnerKey, string>();
  (Object.entries(OWNER_NAMES) as Array<[OwnerKey, string]>).forEach(([key, personName]) => {
    const memberId = memberIdByName.get(personName);
    if (!memberId) throw new Error(`项目组成员缺失，无法分配负责人：${personName}`);
    memberIdByOwnerKey.set(key, memberId);
  });

  const oldRootTaskIds = (await prisma.projectGanttTask.findMany({
    where: { projectId: PROJECT_ID, parentId: null },
    select: { id: true },
  })).map((task) => task.id);
  const deletion = oldRootTaskIds.length > 0
    ? await deleteGanttTaskSubtrees({
      projectId: PROJECT_ID,
      rootTaskIds: oldRootTaskIds,
      operator: OPERATOR_NAME,
      operatorUserId: OPERATOR_USER_ID,
    })
    : null;
  const deletionBatchId = deletion && "deletionBatchId" in deletion && typeof deletion.deletionBatchId === "string"
    ? deletion.deletionBatchId
    : "";
  const deletionBatch = deletionBatchId
    ? await prisma.projectGanttDeletionBatch.findUnique({
      where: { id: deletionBatchId },
      select: { id: true, expiresAt: true },
    })
    : null;

  const siblingPositionByKey = new Map<string, number>();
  const created = await prisma.$transaction(async (tx) => {
    const idByKey = new Map<string, string>();
    for (const node of WBS) {
      const parentId = node.parentKey ? idByKey.get(node.parentKey) : null;
      if (node.parentKey && !parentId) throw new Error(`父任务创建失败：${node.parentKey}`);
      const siblingKey = parentId ?? "__root__";
      const sortOrder = (siblingPositionByKey.get(siblingKey) ?? 0) + 1;
      siblingPositionByKey.set(siblingKey, sortOrder);
      const predecessorNames = unique(node.predecessorKeys ?? [])
        .map((key) => nodesByKey.get(key)?.taskName ?? "")
        .filter(Boolean);
      const ownerMemberId = node.owner ? memberIdByOwnerKey.get(node.owner) ?? null : null;
      const task = await tx.projectGanttTask.create({
        data: {
          projectId: PROJECT_ID,
          parentId,
          ownerMemberId,
          taskCode: "",
          taskCategory: categoryForKey(nodesByKey, node.key),
          taskName: node.taskName,
          taskDescription: "无",
          startDate: "",
          finishDate: "",
          durationDays: 0,
          durationMinutes: 0,
          estimatedWorkHours: 0,
          actualWorkHours: 0,
          actualStartDate: "",
          actualEndDate: "",
          progress: 0,
          predecessorTask: predecessorNames.join(","),
          taskMode: "AUTO",
          parentBoundaryMode: "ROLLUP",
          sortOrder,
        },
      });
      idByKey.set(node.key, task.id);
    }

    const ownerLinks = WBS.flatMap((node) => {
      if (!node.owner) return [];
      const taskId = idByKey.get(node.key);
      const projectMemberId = memberIdByOwnerKey.get(node.owner);
      return taskId && projectMemberId ? [{ taskId, projectMemberId }] : [];
    });
    await tx.projectGanttTaskOwner.createMany({ data: ownerLinks, skipDuplicates: true });

    const dependencies = WBS.flatMap((node) => unique(node.predecessorKeys ?? []).map((predecessorKey) => ({
      projectId: PROJECT_ID,
      predecessorTaskId: idByKey.get(predecessorKey)!,
      successorTaskId: idByKey.get(node.key)!,
      type: 1,
      lag: 0,
      lagFormat: 7,
      unsupportedReason: "",
    })));
    if (dependencies.length > 0) await tx.projectGanttDependency.createMany({ data: dependencies, skipDuplicates: true });

    await synchronizeGanttOwnerHierarchy({ tx, projectId: PROJECT_ID });
    await Promise.all([
      tx.projectScheduleImportMetadata.deleteMany({ where: { projectId: PROJECT_ID } }),
      tx.projectGanttBaselineDraft.deleteMany({ where: { projectId: PROJECT_ID } }),
      tx.project.update({
        where: { id: PROJECT_ID },
        data: {
          startDate: "",
          expectedEndDate: "",
          ganttHardFinishDate: "",
          ganttRevision: { increment: 1 },
        },
      }),
      tx.operationHistory.create({
        data: {
          projectId: PROJECT_ID,
          entityType: "PROJECT_GANTT_TASK",
          entityId: PROJECT_ID,
          actionType: "CREATE",
          operator: OPERATOR_NAME,
          detail: `按网络状态控制设备任务清单重建 WBS：创建 ${WBS.length} 条任务，最大 ${maxDepth} 层；仅录入末级负责人和 ${dependencies.length} 条 FS 紧前任务，日期、工期、进度、工时均留空。`,
        },
      }),
    ]);
    return { idByKey, dependencyCount: dependencies.length, ownerLinkCount: ownerLinks.length };
  }, { timeout: 30_000, maxWait: 10_000 });

  // Renumbering is intentionally separated from schedule recalculation: the user
  // requested an unscheduled WBS and will enter dates/durations manually.
  await renumberProjectGanttTaskCodes(PROJECT_ID);

  const persisted = await prisma.projectGanttTask.findMany({
    where: { projectId: PROJECT_ID },
    select: {
      id: true,
      parentId: true,
      taskCode: true,
      taskName: true,
      taskDescription: true,
      startDate: true,
      finishDate: true,
      durationDays: true,
      durationMinutes: true,
      estimatedWorkHours: true,
      actualWorkHours: true,
      progress: true,
      predecessorDependencies: { select: { type: true } },
      ownerLinks: { select: { projectMemberId: true } },
    },
  });
  const persistedById = new Map(persisted.map((task) => [task.id, task]));
  const depths = persisted.map((task) => {
    let depth = 1;
    let parentId = task.parentId;
    const visited = new Set<string>([task.id]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = persistedById.get(parentId)?.parentId ?? null;
    }
    return depth;
  });
  const hasScheduleData = persisted.some((task) => (
    task.startDate
    || task.finishDate
    || task.durationDays !== 0
    || task.durationMinutes !== 0
    || task.estimatedWorkHours !== 0
    || task.actualWorkHours !== 0
    || task.progress !== 0
  ));
  // Parent owner links are system-generated rollups from descendant leaves.
  // Only a leaf has a direct, manually assigned responsible person.
  const invalidOwners = persisted.filter((task) => {
    const isParent = persisted.some((candidate) => candidate.parentId === task.id);
    return !isParent && task.ownerLinks.length !== 1;
  });
  const invalidDependencies = persisted.flatMap((task) => task.predecessorDependencies).filter((dependency) => dependency.type !== 1);
  if (
    persisted.length !== WBS.length
    || Math.max(...depths) !== maxDepth
    || hasScheduleData
    || invalidOwners.length > 0
    || invalidDependencies.length > 0
  ) {
    throw new Error(`重建后校验失败：任务=${persisted.length}/${WBS.length}，最大层级=${Math.max(...depths)}/${maxDepth}，排期数据=${hasScheduleData}，负责人异常=${invalidOwners.length}，依赖异常=${invalidDependencies.length}`);
  }

  console.log(JSON.stringify({
    project: `${project.code || project.name} ${project.name}`,
    replacement: {
      taskCount: persisted.length,
      leafCount,
      maxDepth: Math.max(...depths),
      ownerAssignments: created.ownerLinkCount,
      fsDependencies: created.dependencyCount,
      scheduleFieldsBlank: !hasScheduleData,
    },
    oldWbsBackup: deletionBatch ? {
      deletionBatchId: deletionBatch.id,
      deletedTaskCount: deletion?.deletedTaskCount ?? 0,
      expiresAt: deletionBatch.expiresAt.toISOString(),
    } : null,
  }, null, 2));
};

rebuild()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
