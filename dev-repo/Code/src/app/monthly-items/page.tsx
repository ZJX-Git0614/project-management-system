"use client";

import { useEffect, useState } from "react";
import { ItemPanel } from "@/components/item-panel";
import { getMonthRange } from "@/lib/utils";

export default function MonthlyItemsPage() {
  const [dateRange, setDateRange] = useState<{ start: string; end: string } | null>(null);

  useEffect(() => {
    setDateRange(getMonthRange());
  }, []);

  if (!dateRange) {
    return null;
  }

  return (
    <ItemPanel
      kind="monthly"
      apiPath="/api/monthly-items"
      title="本月事项"
      description="按月聚合的全局项目事项列表"
      dateRange={dateRange}
      csvFilename="本月事项"
      csvHeaders={[
        "月份", "周重点事件", "周", "事项名称", "归属方", "责任人", "优先级",
        "计划开始时间", "实际开始时间", "计划结束时间", "实际结束时间",
        "任务偏差", "进度", "状态", "任务健康状态",
        "当前问题/措施", "依赖条件", "风险", "风险状态", "备注",
      ]}
    />
  );
}
