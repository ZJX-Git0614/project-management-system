"use client";

import { useEffect, useState } from "react";
import { ItemPanel } from "@/components/item-panel";
import { getWeekRange } from "@/lib/utils";

export default function WeeklyItemsPage() {
  const [dateRange, setDateRange] = useState<{ start: string; end: string } | null>(null);

  useEffect(() => {
    setDateRange(getWeekRange());
  }, []);

  if (!dateRange) {
    return null;
  }

  return (
    <ItemPanel
      kind="weekly"
      apiPath="/api/weekly-items"
      title="本周事项"
      description="按周聚合的全局项目事项列表"
      dateRange={dateRange}
      csvFilename="本周事项"
      csvHeaders={[
        "月份", "周重点事件", "周", "事项", "归属方", "责任人", "优先级",
        "计划开始时间", "实际开始时间", "计划结束时间", "实际结束时间",
        "任务偏差", "进度", "状态", "任务健康状态",
        "当前问题/措施", "依赖条件", "风险", "风险状态", "备注",
      ]}
    />
  );
}
