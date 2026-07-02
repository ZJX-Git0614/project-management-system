import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // 清空（按依赖顺序）
  await prisma.permissionTree.deleteMany();
  await prisma.operationHistory.deleteMany();
  await prisma.todoItem.deleteMany();
  await prisma.weeklyItem.deleteMany();
  await prisma.monthlyItem.deleteMany();
  await prisma.projectBudgetItem.deleteMany();
  await prisma.projectBudgetCategory.deleteMany();
  await prisma.projectBudgetSetting.deleteMany();
  await prisma.projectGanttTask.deleteMany();
  await prisma.projectMember.deleteMany();
  await prisma.project.deleteMany();
  await prisma.roleConfig.deleteMany();
  await prisma.systemPerson.deleteMany();
  await prisma.userAccount.deleteMany();

  // ============= 角色 =============
  await prisma.roleConfig.createMany({
    data: [
      { roleName: "管理员", allowMultiple: true, systemPreset: true, persons: JSON.stringify([]) },
      { roleName: "项目经理", allowMultiple: false, systemPreset: true, persons: JSON.stringify([]) },
      { roleName: "项目成员", allowMultiple: true, systemPreset: true, persons: JSON.stringify([]) },
    ],
  });

  // ============= 系统人员库 =============
  const personNames = [
    "曹乾", "王占新", "冉茂琪", "杨凤山",
    "李瑞鸣", "周辉", "苏雪", "潘露萍",
    "姚家福", "陈顺", "葛福星", "丁荣盛", "孟洵", "高路路", "王凤",
    "郑礼文", "周蕊", "赵佳鑫", "张国庆",
  ];
  await prisma.systemPerson.createMany({
    data: personNames.map((personName) => ({ personName })),
  });

  // ============= 账号 =============
  await prisma.userAccount.create({
    data: {
      username: "admin",
      displayName: "系统管理员",
      enabled: true,
      assignedRoleNames: JSON.stringify(["管理员"]),
      passwordHash: hashSync("admin123", 10),
      passwordResetRequired: false,
      passwordUpdatedAt: new Date(),
    },
  });
  await prisma.userAccount.create({
    data: {
      username: "pm1",
      displayName: "赵佳鑫",
      enabled: true,
      assignedRoleNames: JSON.stringify(["项目经理"]),
      passwordHash: hashSync("pm123", 10),
      passwordResetRequired: false,
      passwordUpdatedAt: new Date(),
    },
  });
  await prisma.userAccount.create({
    data: {
      username: "user1",
      displayName: "张三",
      enabled: true,
      assignedRoleNames: JSON.stringify(["项目成员"]),
      passwordHash: hashSync("user123", 10),
      passwordResetRequired: false,
      passwordUpdatedAt: new Date(),
    },
  });

  // ============= 权限树 =============
  const { cloneDefaultPermissionTree } = await import("../src/lib/permissions");
  await prisma.permissionTree.create({
    data: {
      id: "default_tree",
      data: JSON.stringify(cloneDefaultPermissionTree()),
    },
  });

  // ============= 项目 =============
  const project = await prisma.project.create({
    data: {
      name: "网络状态控制设备",
      code: "NSCD-2024-001",
      clientName: "某客户单位",
      amountWan: 519.13,
      deviceCount: 44,
      startDate: "2024-01-01",
      expectedEndDate: "2025-12-31",
      status: "IN_PROGRESS",
    },
  });

  // ============= 项目成员 =============
  await prisma.projectMember.createMany({
    data: [
      { projectId: project.id, roleName: "项目经理", personName: "赵佳鑫" },
      { projectId: project.id, roleName: "项目成员", personName: "曹乾" },
      { projectId: project.id, roleName: "项目成员", personName: "王占新" },
      { projectId: project.id, roleName: "项目成员", personName: "郑礼文" },
    ],
  });

  // ============= 预算分类 =============
  // 系统预装 3 个 RATE 型分类（公摊/审价/风险）— 每个分类下放 1 条档位条目
  const rateOverhead = await prisma.projectBudgetCategory.create({
    data: {
      projectId: project.id,
      name: "公摊成本比例",
      kind: "RATE",
      description: "公司管理/分摊费用占合同比例；行业惯例 10%~16%",
      sortOrder: 1,
    },
  });
  const rateAudit = await prisma.projectBudgetCategory.create({
    data: {
      projectId: project.id,
      name: "审价扣除预留",
      kind: "RATE",
      description: "审计/审价环节可能扣减的比例；行业惯例 10%~20%",
      sortOrder: 2,
    },
  });
  const rateRisk = await prisma.projectBudgetCategory.create({
    data: {
      projectId: project.id,
      name: "风险成本预留",
      kind: "RATE",
      description: "项目风险准备金占合同比例；行业惯例 10%~15%",
      sortOrder: 3,
    },
  });
  // RATE 分类下的档位条目（min/max 为建议上下限，current 为当前使用值）
  await prisma.projectBudgetItem.createMany({
    data: [
      {
        projectId: project.id, categoryId: rateOverhead.id, sortOrder: 1,
        title: "公摊档位", remark: "",
        minRate: 10, maxRate: 16, currentRate: 16,
      },
      {
        projectId: project.id, categoryId: rateAudit.id, sortOrder: 1,
        title: "审价档位", remark: "",
        minRate: 10, maxRate: 20, currentRate: 15,
      },
      {
        projectId: project.id, categoryId: rateRisk.id, sortOrder: 1,
        title: "风险档位", remark: "",
        minRate: 10, maxRate: 15, currentRate: 10,
      },
    ],
  });

  // 网络状态控制设备-人力（重庆 + 南京合并）
  const manpowerDevice = await prisma.projectBudgetCategory.create({
    data: {
      projectId: project.id,
      name: "网络状态控制设备-人力",
      kind: "MANPOWER",
      description: "网络状态控制设备研发人力（重庆+南京）",
      sortOrder: 10,
    },
  });
  // 软件仿真服务人力
  const manpowerSw = await prisma.projectBudgetCategory.create({
    data: {
      projectId: project.id,
      name: "软件仿真服务-人力",
      kind: "MANPOWER",
      description: "通信链路仿真服务软件人力",
      sortOrder: 20,
    },
  });
  // 硬件采购
  const purchaseHw = await prisma.projectBudgetCategory.create({
    data: {
      projectId: project.id,
      name: "硬件采购",
      kind: "PURCHASE",
      description: "D3000M模块、PCB、滤波器、连接器、结构件等",
      sortOrder: 30,
    },
  });
  // 差旅
  const travel = await prisma.projectBudgetCategory.create({
    data: {
      projectId: project.id,
      name: "差旅成本",
      kind: "OTHER",
      description: "项目实施差旅整体成本",
      sortOrder: 40,
    },
  });

  // ============= 预算条目 =============
  // 重庆人力（4人共享 20000/人月）
  // 源表: 曹乾 0.5 / 王占新 1 / 冉茂琪 1.5 / 杨凤山 2 = 5人月 × 20000 = 100000
  await prisma.projectBudgetItem.createMany({
    data: [
      { projectId: project.id, categoryId: manpowerDevice.id, sortOrder: 1, groupName: "硬件工程师", person: "曹乾", personMonths: 0.5, monthlyCostPerPerson: 20000, remark: "" },
      { projectId: project.id, categoryId: manpowerDevice.id, sortOrder: 2, groupName: "硬件工程师", person: "王占新", personMonths: 1, monthlyCostPerPerson: 20000, remark: "" },
      { projectId: project.id, categoryId: manpowerDevice.id, sortOrder: 3, groupName: "软件工程师", person: "冉茂琪", personMonths: 1.5, monthlyCostPerPerson: 20000, remark: "" },
      { projectId: project.id, categoryId: manpowerDevice.id, sortOrder: 4, groupName: "软件工程师", person: "杨凤山", personMonths: 2, monthlyCostPerPerson: 20000, remark: "" },
      // 南京人力
      { projectId: project.id, categoryId: manpowerDevice.id, sortOrder: 5, groupName: "结构工程师", person: "李瑞鸣", personMonths: 0.5, monthlyCostPerPerson: 16000, remark: "" },
      { projectId: project.id, categoryId: manpowerDevice.id, sortOrder: 6, groupName: "硬件测试工程师", person: "周辉、苏雪", personMonths: 1.5, monthlyCostPerPerson: 16000, remark: "周辉+苏雪" },
      { projectId: project.id, categoryId: manpowerDevice.id, sortOrder: 7, groupName: "生产部门", person: "/", personMonths: 2.5, monthlyCostPerPerson: 10000, remark: "生产部门" },
      { projectId: project.id, categoryId: manpowerDevice.id, sortOrder: 8, groupName: "质量工程师", person: "潘露萍", personMonths: 2.5, monthlyCostPerPerson: 14000, remark: "" },
      // 软件仿真人力
      { projectId: project.id, categoryId: manpowerSw.id, sortOrder: 1, groupName: "前端工程师", person: "姚家福", personMonths: 6, monthlyCostPerPerson: 17000, remark: "" },
      { projectId: project.id, categoryId: manpowerSw.id, sortOrder: 2, groupName: "前端工程师", person: "陈顺", personMonths: 4, monthlyCostPerPerson: 17000, remark: "" },
      { projectId: project.id, categoryId: manpowerSw.id, sortOrder: 3, groupName: "仿真组工程师", person: "葛福星", personMonths: 3, monthlyCostPerPerson: 18000, remark: "" },
      { projectId: project.id, categoryId: manpowerSw.id, sortOrder: 4, groupName: "仿真组工程师", person: "丁荣盛", personMonths: 6, monthlyCostPerPerson: 18000, remark: "" },
      { projectId: project.id, categoryId: manpowerSw.id, sortOrder: 5, groupName: "仿真组工程师", person: "孟洵", personMonths: 5, monthlyCostPerPerson: 18000, remark: "" },
      { projectId: project.id, categoryId: manpowerSw.id, sortOrder: 6, groupName: "软件测试工程师", person: "高路路、王凤", personMonths: 3, monthlyCostPerPerson: 10000, remark: "高路路+王凤" },
      { projectId: project.id, categoryId: manpowerSw.id, sortOrder: 7, groupName: "产品经理", person: "郑礼文", personMonths: 4, monthlyCostPerPerson: 22000, remark: "" },
      { projectId: project.id, categoryId: manpowerSw.id, sortOrder: 8, groupName: "UI工程师", person: "周蕊", personMonths: 1, monthlyCostPerPerson: 18000, remark: "" },
      { projectId: project.id, categoryId: manpowerSw.id, sortOrder: 9, groupName: "项目经理", person: "赵佳鑫", personMonths: 4, monthlyCostPerPerson: 17000, remark: "" },
      { projectId: project.id, categoryId: manpowerSw.id, sortOrder: 10, groupName: "售后工程师", person: "张国庆", personMonths: 4, monthlyCostPerPerson: 10000, remark: "" },
    ],
  });

  // 硬件采购
  await prisma.projectBudgetItem.createMany({
    data: [
      { projectId: project.id, categoryId: purchaseHw.id, sortOrder: 1, title: "D3000M模块", unitPrice: 16000, sampleQuantity: 2, productionQuantity: 42, remark: "" },
      { projectId: project.id, categoryId: purchaseHw.id, sortOrder: 2, title: "底板PCB设计+器件+贴片", unitPrice: 5000, sampleQuantity: 2, productionQuantity: 42, remark: "" },
      { projectId: project.id, categoryId: purchaseHw.id, sortOrder: 3, title: "滤波器组件", unitPrice: 3000, sampleQuantity: 2, productionQuantity: 42, remark: "" },
      { projectId: project.id, categoryId: purchaseHw.id, sortOrder: 4, title: "整机连接器+线缆", unitPrice: 2100, sampleQuantity: 2, productionQuantity: 42, remark: "" },
      { projectId: project.id, categoryId: purchaseHw.id, sortOrder: 5, title: "结构件采购", unitPrice: 5000, sampleQuantity: 2, productionQuantity: 42, remark: "" },
      { projectId: project.id, categoryId: purchaseHw.id, sortOrder: 6, title: "用于快速验证的D3000M模块加价成本", unitPrice: 2300, sampleQuantity: 2, productionQuantity: 0, remark: "仅样机" },
    ],
  });

  // 差旅
  await prisma.projectBudgetItem.create({
    data: {
      projectId: project.id,
      categoryId: travel.id,
      sortOrder: 1,
      title: "项目实施差旅",
      amount: 120000,
      remark: "10 人月 × 12000/人月",
    },
  });

  // ============= 预算设置 =============
  await prisma.projectBudgetSetting.create({
    data: {
      projectId: project.id,
      contractAmount: 5191300,
      profitTargetRate: 13.71,
      note: "合同金额 5,191,300（来自项目信息）；公摊 16% / 审价 15% / 风险 10% 已在 RATE 分类中管理；利润率 13.71%",
    },
  });

  // ============= 本月事项 =============
  const monthlyItems = [
    { title: "网络状态控制设备硬件联调", description: "完成硬件联调并输出测试报告", dueDate: "2026-06-30", status: "IN_PROGRESS", owner: "曹乾", priority: "HIGH", progress: 40, health: "AT_RISK", plannedStartDate: "2026-06-01", plannedEndDate: "2026-06-30", issueAndAction: "滤波器到货延迟", risk: "供应商交期不稳", riskStatus: "OPEN" },
    { title: "仿真平台前端交付", description: "前端页面开发及联调", dueDate: "2026-06-28", status: "IN_PROGRESS", owner: "姚家福", priority: "NORMAL", progress: 65, health: "HEALTHY", plannedStartDate: "2026-06-01", plannedEndDate: "2026-06-28" },
    { title: "D3000M模块样机验证", description: "2套样机功能验证", dueDate: "2026-06-20", status: "DONE", owner: "王占新", priority: "HIGH", progress: 100, health: "HEALTHY", plannedStartDate: "2026-06-01", plannedEndDate: "2026-06-20", actualEndDate: "2026-06-18" },
    { title: "项目月度成本核算", description: "汇总本月人力及采购成本", dueDate: "2026-06-30", status: "PENDING", owner: "赵佳鑫", priority: "NORMAL", progress: 0, health: "UNKNOWN", plannedStartDate: "2026-06-25", plannedEndDate: "2026-06-30" },
  ]
  for (const item of monthlyItems) {
    await prisma.monthlyItem.create({ data: { projectId: project.id, ...item } })
  }

  // ============= 本周事项 =============
  const weeklyItems = [
    { title: "PCB板焊接调试", description: "完成底板PCB焊接及初步调试", dueDate: "2026-07-04", status: "IN_PROGRESS", owner: "王占新", priority: "HIGH", progress: 50, health: "HEALTHY", plannedStartDate: "2026-06-30", plannedEndDate: "2026-07-04" },
    { title: "仿真接口文档编写", description: "输出REST API接口文档", dueDate: "2026-07-04", status: "PENDING", owner: "陈顺", priority: "NORMAL", progress: 0, health: "UNKNOWN", plannedStartDate: "2026-07-01", plannedEndDate: "2026-07-04" },
    { title: "结构件图纸会签", description: "与客户确认结构件图纸", dueDate: "2026-07-03", status: "IN_PROGRESS", owner: "李瑞鸣", priority: "NORMAL", progress: 30, health: "AT_RISK", plannedStartDate: "2026-06-30", plannedEndDate: "2026-07-03", issueAndAction: "客户反馈延迟", dependency: "客户技术部确认" },
    { title: "质量检验报告整理", description: "汇总本月质检数据", dueDate: "2026-07-04", status: "PENDING", owner: "潘露萍", priority: "LOW", progress: 0, health: "UNKNOWN", plannedStartDate: "2026-07-02", plannedEndDate: "2026-07-04" },
  ]
  for (const item of weeklyItems) {
    await prisma.weeklyItem.create({ data: { projectId: project.id, ...item } })
  }

  // ============= 待办事项 =============
  await prisma.todoItem.createMany({
    data: [
      { projectId: project.id, title: "跟踪滤波器到货进度", detail: "供应商承诺7月5日前到货，需每日跟进", targetRole: "PROJECT_MANAGER", targetPersonName: "赵佳鑫", type: "CUSTOM", status: "OPEN" },
      { projectId: project.id, title: "样机测试报告评审", detail: "王占新已完成样机验证，需组织评审", targetRole: "PROJECT_MANAGER", targetPersonName: "赵佳鑫", type: "CUSTOM", status: "OPEN" },
      { projectId: project.id, title: "本月事项逾期预警", detail: "网络状态控制设备硬件联调进度滞后", targetRole: "PROJECT_MANAGER", type: "MONTHLY_ITEM_OVERDUE", status: "OPEN" },
    ],
  })

  // ============= 甘特图任务 =============
  const ganttTasks = [
    { taskCategory: "硬件研发", taskName: "需求分析", startDate: "2024-01-01", durationDays: 30, sortOrder: 1 },
    { taskCategory: "硬件研发", taskName: "方案设计", startDate: "2024-02-01", durationDays: 45, predecessorTask: "需求分析", sortOrder: 2 },
    { taskCategory: "硬件研发", taskName: "详细设计", startDate: "2024-03-15", durationDays: 60, predecessorTask: "方案设计", sortOrder: 3 },
    { taskCategory: "硬件研发", taskName: "样机试制", startDate: "2024-05-15", durationDays: 45, predecessorTask: "详细设计", sortOrder: 4 },
    { taskCategory: "硬件研发", taskName: "联调测试", startDate: "2024-07-01", durationDays: 60, predecessorTask: "样机试制", sortOrder: 5 },
    { taskCategory: "软件研发", taskName: "架构设计", startDate: "2024-02-15", durationDays: 30, sortOrder: 10 },
    { taskCategory: "软件研发", taskName: "核心模块开发", startDate: "2024-03-15", durationDays: 90, predecessorTask: "架构设计", sortOrder: 11 },
    { taskCategory: "软件研发", taskName: "前端开发", startDate: "2024-06-15", durationDays: 60, sortOrder: 12 },
    { taskCategory: "软件研发", taskName: "系统集成", startDate: "2024-08-15", durationDays: 45, predecessorTask: "核心模块开发", sortOrder: 13 },
    { taskCategory: "项目管理", taskName: "项目启动", startDate: "2024-01-01", durationDays: 7, sortOrder: 20 },
    { taskCategory: "项目管理", taskName: "里程碑评审", startDate: "2024-06-01", durationDays: 3, sortOrder: 21 },
    { taskCategory: "项目管理", taskName: "验收交付", startDate: "2025-10-01", durationDays: 60, sortOrder: 22 },
  ]
  for (const task of ganttTasks) {
    await prisma.projectGanttTask.create({ data: { projectId: project.id, ...task } })
  }

  console.log("✅ 数据库初始化完成");
  console.log("   账号：");
  console.log("     admin / admin123（管理员）");
  console.log("     pm1   / pm123  （项目经理 - 赵佳鑫）");
  console.log("     user1 / user123（项目成员 - 张三）");
  console.log("   已创建项目「网络状态控制设备」并导入预算表数据");
  console.log("   4 个常规分类：网络状态控制设备-人力 / 软件仿真服务-人力 / 硬件采购 / 差旅成本");
  console.log("   3 个费率型分类（系统预装）：公摊成本比例 / 审价扣除预留 / 风险成本预留");
  console.log("   预算设置：合同 5,191,300 / 利润率 13.71%");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
