import { ItemPanel } from "@/components/item-panel";

export default function WeeklyItemsPage() {
  return (
    <ItemPanel
      kind="weekly"
      apiPath="/api/weekly-items"
      title="项目事项管理"
      description="统一管理项目全周期事项"
      dateRange={{ start: "", end: "" }}
      csvFilename="项目事项管理"
      csvHeaders={[
        "序号", "事项ID", "事项名称", "关联任务名称", "责任人", "优先级",
        "计划开始时间", "计划结束时间", "实际开始时间", "实际结束时间",
        "任务偏差", "进度", "状态", "任务健康状态",
        "当前问题/措施", "依赖条件", "关联风险", "风险状态", "备注",
      ]}
    />
  );
}
