import {
  getOrderedGanttTasks,
  materializeProjectGanttRelativeSchedule,
  serializeGanttTaskList,
} from "@/lib/gantt-task-service";

export const readProjectGanttTasks = async (params: {
  projectId: string;
  projectStartDate?: string | null;
}) => {
  let tasks = await getOrderedGanttTasks(params.projectId);
  if (/^\d{4}-\d{2}-\d{2}$/.test(params.projectStartDate || "") && tasks.some((task) => (
    task.relativeStartOffsetDays != null || task.relativeFinishOffsetDays != null
  ))) {
    await materializeProjectGanttRelativeSchedule(params.projectId, params.projectStartDate as string);
    tasks = await getOrderedGanttTasks(params.projectId);
  }
  return serializeGanttTaskList(tasks);
};
