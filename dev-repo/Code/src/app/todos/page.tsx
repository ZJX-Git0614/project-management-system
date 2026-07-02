"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function TodosPage() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">待办中心</CardTitle>
          <CardDescription className="text-xs">
            跨项目待办聚合视图
          </CardDescription>
        </CardHeader>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          待办中心在 v0.1 阶段为占位模块，后续版本将接入项目级推送（接收/退回/驳回）的待办聚合。
        </CardContent>
      </Card>
    </div>
  );
}
