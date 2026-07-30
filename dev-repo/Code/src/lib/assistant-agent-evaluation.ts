export type AssistantAgentEvaluationCase = {
  id: string;
  message: string;
  attachmentNames?: string[];
  expectedToolId: string | null;
  expectedCommandCues?: string[];
};

export const ASSISTANT_AGENT_EVALUATION_CASES: readonly AssistantAgentEvaluationCase[] = [
  { id: "todo-create-plain", message: "帮我新建待办：周五前完成接口联调", expectedToolId: "todo.create", expectedCommandCues: ["接口联调"] },
  { id: "todo-create-colloquial", message: "记一件事，安排我周五前把验收材料补齐", expectedToolId: "todo.create", expectedCommandCues: ["验收材料"] },
  { id: "todo-complete", message: "把待办‘完成接口联调’办结", expectedToolId: "todo.complete", expectedCommandCues: ["完成接口联调"] },
  { id: "weekly-update", message: "Matter007 推进到 35%，状态设为进行中", expectedToolId: "weekly.status.update", expectedCommandCues: ["Matter007", "35"] },
  { id: "weekly-update-spoken", message: "第七个事项做到百分之三十五了，改成处理中", expectedToolId: "weekly.status.update", expectedCommandCues: ["35"] },
  { id: "gantt-progress", message: "Task2.3 当前完成度更新为 80%", expectedToolId: "gantt.progress.update", expectedCommandCues: ["Task2.3", "80"] },
  { id: "gantt-indent", message: "把 Task3 下移一级，作为上一条任务的子任务", expectedToolId: "gantt.hierarchy.indent", expectedCommandCues: ["Task3"] },
  { id: "gantt-outdent", message: "将 Task2.1 上移一个层级", expectedToolId: "gantt.hierarchy.outdent", expectedCommandCues: ["Task2.1"] },
  { id: "risk-create", message: "登记风险：供应商设备可能延期到货", expectedToolId: "risk.create", expectedCommandCues: ["供应商", "延期"] },
  { id: "risk-close", message: "把 Risk003 状态更新为已关闭", expectedToolId: "risk.status.update", expectedCommandCues: ["Risk003", "已关闭"] },
  { id: "project-export", message: "下载当前项目的风险登记册", expectedToolId: "project.export", expectedCommandCues: ["风险"] },
  { id: "analysis-export", message: "把最新计划冲突和影响链导出成报告", expectedToolId: "schedule.analysis.export", expectedCommandCues: ["冲突", "影响链"] },
  { id: "schedule-convert-mpp", message: "把这个 MPP 做成系统能导入的甘特 Excel", attachmentNames: ["项目计划.mpp"], expectedToolId: "schedule.convert.file", expectedCommandCues: ["转换", "Excel"] },
  { id: "schedule-convert-xml", message: "将附件整理成系统甘特任务格式", attachmentNames: ["project.xml"], expectedToolId: "schedule.convert.file", expectedCommandCues: ["甘特"] },
  { id: "schedule-merge", message: "把这三份排期合并，输出可导入文件", attachmentNames: ["前端.xlsx", "后端.mpp", "引擎.xml"], expectedToolId: "schedule.merge.files", expectedCommandCues: ["合并"] },
  { id: "schedule-compare", message: "分析上传计划与当前进度的差异和冲突", attachmentNames: ["本周计划.mpp"], expectedToolId: "schedule.compare.file", expectedCommandCues: ["对比", "冲突"] },
  { id: "schedule-workflow", message: "对比这份计划和当前甘特，导出报告并把严重冲突转为风险", attachmentNames: ["更新计划.mpp"], expectedToolId: "schedule.compare.file", expectedCommandCues: ["对比"] },
  { id: "risk-from-analysis", message: "把最新分析里最严重的冲突创建为风险", expectedToolId: "risk.create.from-analysis", expectedCommandCues: ["冲突", "风险"] },
  { id: "todos-from-analysis", message: "将计划分析的处理建议生成整改待办", expectedToolId: "todo.create.batch", expectedCommandCues: ["整改", "待办"] },
  { id: "document-revise", message: "把这份逻辑混乱的文档梳理清楚并细化内容", attachmentNames: ["需求说明.docx"], expectedToolId: "document.revision.generate", expectedCommandCues: ["梳理", "细化"] },
  { id: "capability-question", message: "你能处理 MPP 文件吗？", expectedToolId: null },
  { id: "database-question", message: "当前项目有哪些延期任务？", expectedToolId: null },
  { id: "ambiguous-write", message: "把那个任务改一下", expectedToolId: null },
  { id: "missing-attachment", message: "把文件转成系统甘特格式", expectedToolId: "schedule.convert.file", expectedCommandCues: ["转换"] },
] as const;

export type AssistantAgentEvaluationPrediction = {
  toolId: string | null;
  command: string;
};

export const scoreAssistantAgentEvaluation = (
  predictions: ReadonlyMap<string, AssistantAgentEvaluationPrediction>,
  allowedToolIds: ReadonlySet<string>,
) => {
  let selectedCorrectly = 0;
  let commandCueCases = 0;
  let commandCuesCorrect = 0;
  let executablePlans = 0;
  let whitelistViolations = 0;
  for (const item of ASSISTANT_AGENT_EVALUATION_CASES) {
    const prediction = predictions.get(item.id) ?? { toolId: null, command: "" };
    if (prediction.toolId === item.expectedToolId) selectedCorrectly += 1;
    if (prediction.toolId && !allowedToolIds.has(prediction.toolId)) whitelistViolations += 1;
    if (prediction.toolId && prediction.command.trim()) executablePlans += 1;
    if (item.expectedCommandCues?.length) {
      commandCueCases += 1;
      if (item.expectedCommandCues.some((cue) => prediction.command.includes(cue))) commandCuesCorrect += 1;
    }
  }
  const total = ASSISTANT_AGENT_EVALUATION_CASES.length;
  return {
    total,
    intentSelectionAccuracy: selectedCorrectly / total,
    parameterCueAccuracy: commandCueCases ? commandCuesCorrect / commandCueCases : 1,
    executablePlanRate: executablePlans / ASSISTANT_AGENT_EVALUATION_CASES.filter((item) => item.expectedToolId).length,
    whitelistViolations,
    targetPassed: selectedCorrectly / total >= 0.95 && whitelistViolations === 0,
  };
};
