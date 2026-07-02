"use client";

import { KeyboardEvent, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { usePermission } from "@/lib/use-permission";

type RiskLevel = "高" | "中" | "低";
type RiskStatus = "识别中" | "跟踪中" | "处理中" | "已关闭";
type EditableRiskField =
  | "riskName"
  | "linkedItemName"
  | "category"
  | "trigger"
  | "probability"
  | "impact"
  | "level"
  | "response"
  | "owner"
  | "status"
  | "targetDate";

interface RiskRegisterItem {
  id: string;
  riskName: string;
  linkedItemName: string;
  category: string;
  trigger: string;
  probability: RiskLevel;
  impact: RiskLevel;
  level: RiskLevel;
  response: string;
  owner: string;
  status: RiskStatus;
  targetDate: string;
}

const itemNameOptions = [
  "结构件图纸会签",
  "PCB板焊接调试",
  "仿真接口文档编写",
  "质量检验报告整理",
];

const riskLevelOptions: RiskLevel[] = ["高", "中", "低"];
const riskStatusOptions: RiskStatus[] = ["识别中", "跟踪中", "处理中", "已关闭"];

const initialRiskItems: RiskRegisterItem[] = [
  {
    id: "Risk001",
    riskName: "关键器件交付延期",
    linkedItemName: "结构件图纸会签",
    category: "供应链",
    trigger: "供应商交期超过计划到货日期",
    probability: "中",
    impact: "高",
    level: "高",
    response: "锁定替代料号，提前确认安全库存和二供方案",
    owner: "赵佳鑫",
    status: "处理中",
    targetDate: "2026-07-10",
  },
  {
    id: "Risk002",
    riskName: "联调环境资源冲突",
    linkedItemName: "PCB板焊接调试",
    category: "进度",
    trigger: "测试设备占用导致联调窗口压缩",
    probability: "中",
    impact: "中",
    level: "中",
    response: "按模块拆分联调计划，预留夜间测试窗口",
    owner: "曹乾",
    status: "跟踪中",
    targetDate: "2026-07-15",
  },
  {
    id: "Risk003",
    riskName: "客户需求边界变更",
    linkedItemName: "仿真接口文档编写",
    category: "范围",
    trigger: "新增接口或验收口径变化",
    probability: "低",
    impact: "高",
    level: "中",
    response: "建立变更确认单，评估工期和成本影响后再纳入计划",
    owner: "王占新",
    status: "识别中",
    targetDate: "2026-07-20",
  },
  {
    id: "Risk004",
    riskName: "现场验收资料不完整",
    linkedItemName: "质量检验报告整理",
    category: "交付",
    trigger: "测试报告、图纸或签字记录缺失",
    probability: "低",
    impact: "中",
    level: "低",
    response: "按验收清单逐项归档，周会同步缺口项",
    owner: "潘露萍",
    status: "已关闭",
    targetDate: "2026-07-05",
  },
];

const inlineInputClass = "h-7 min-w-0 rounded border-border bg-background px-2 text-xs";
const inlineSelectClass = "h-7 min-w-[96px] rounded border-border bg-background px-2 text-xs";
const inlineTextareaClass = "min-h-14 min-w-[180px] resize-y rounded border-border bg-background px-2 py-1 text-xs";

const levelVariant: Record<RiskLevel, "destructive" | "warning" | "success"> = {
  高: "destructive",
  中: "warning",
  低: "success",
};

const statusVariant: Record<RiskStatus, "secondary" | "default" | "warning" | "success"> = {
  识别中: "secondary",
  跟踪中: "default",
  处理中: "warning",
  已关闭: "success",
};

export default function RiskRegisterPage() {
  const { can } = usePermission();
  const [riskItems, setRiskItems] = useState<RiskRegisterItem[]>(initialRiskItems);
  const [editingCell, setEditingCell] = useState<{ id: string; field: EditableRiskField } | null>(null);

  const closeEdit = () => setEditingCell(null);

  const updateRisk = <K extends EditableRiskField>(
    id: string,
    field: K,
    value: RiskRegisterItem[K]
  ) => {
    setRiskItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  };

  const isEditing = (item: RiskRegisterItem, field: EditableRiskField) =>
    editingCell?.id === item.id && editingCell.field === field;

  const handleEditKeyDown = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeEdit();
      return;
    }
    if (event.key !== "Enter") return;
    if (event.currentTarget instanceof HTMLTextAreaElement && event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    closeEdit();
  };

  const editTriggerProps = (item: RiskRegisterItem, field: EditableRiskField) => ({
    role: "button" as const,
    tabIndex: 0,
    onClick: () => setEditingCell({ id: item.id, field }),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setEditingCell({ id: item.id, field });
      }
    },
  });

  if (!can("risk-register:view")) {
    return (
      <Card className="border-warning/30 bg-warning/5">
        <CardContent className="py-4 text-sm">当前角色无权查看风险登记册。</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">风险登记册</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">风险ID</TableHead>
              <TableHead className="min-w-[180px] whitespace-nowrap">风险名称</TableHead>
              <TableHead className="min-w-[180px] whitespace-nowrap">关联事项名称</TableHead>
              <TableHead className="whitespace-nowrap">类别</TableHead>
              <TableHead className="min-w-[180px] whitespace-nowrap">触发条件</TableHead>
              <TableHead className="whitespace-nowrap">概率</TableHead>
              <TableHead className="whitespace-nowrap">影响</TableHead>
              <TableHead className="whitespace-nowrap">等级</TableHead>
              <TableHead className="min-w-[240px] whitespace-nowrap">应对措施</TableHead>
              <TableHead className="whitespace-nowrap">责任人</TableHead>
              <TableHead className="whitespace-nowrap">状态</TableHead>
              <TableHead className="whitespace-nowrap">计划关闭日期</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {riskItems.map((item) => (
              <TableRow
                key={item.id}
                className={editingCell?.id === item.id ? "align-top bg-primary/5" : "align-top"}
              >
                <TableCell className="whitespace-nowrap font-mono text-xs font-semibold text-muted-foreground">
                  {item.id}
                </TableCell>
                <TableCell className="cursor-pointer font-medium hover:bg-primary/5" {...editTriggerProps(item, "riskName")}>
                  {isEditing(item, "riskName") ? (
                    <Input
                      value={item.riskName}
                      onChange={(event) => updateRisk(item.id, "riskName", event.target.value)}
                      onKeyDown={handleEditKeyDown}
                      className={`${inlineInputClass} min-w-[160px]`}
                      autoFocus
                    />
                  ) : item.riskName}
                </TableCell>
                <TableCell className="cursor-pointer text-muted-foreground hover:bg-primary/5" {...editTriggerProps(item, "linkedItemName")}>
                  {isEditing(item, "linkedItemName") ? (
                    <Select
                      value={item.linkedItemName}
                      onChange={(event) => updateRisk(item.id, "linkedItemName", event.target.value)}
                      onKeyDown={handleEditKeyDown}
                      className={`${inlineSelectClass} min-w-[170px]`}
                      autoFocus
                    >
                      {itemNameOptions.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </Select>
                  ) : item.linkedItemName}
                </TableCell>
                <TableCell className="cursor-pointer whitespace-nowrap hover:bg-primary/5" {...editTriggerProps(item, "category")}>
                  {isEditing(item, "category") ? (
                    <Input
                      value={item.category}
                      onChange={(event) => updateRisk(item.id, "category", event.target.value)}
                      onKeyDown={handleEditKeyDown}
                      className={`${inlineInputClass} w-[96px]`}
                      autoFocus
                    />
                  ) : item.category}
                </TableCell>
                <TableCell className="cursor-pointer text-muted-foreground hover:bg-primary/5" {...editTriggerProps(item, "trigger")}>
                  {isEditing(item, "trigger") ? (
                    <Textarea
                      value={item.trigger}
                      onChange={(event) => updateRisk(item.id, "trigger", event.target.value)}
                      onKeyDown={handleEditKeyDown}
                      className={inlineTextareaClass}
                      autoFocus
                    />
                  ) : item.trigger}
                </TableCell>
                <TableCell className="cursor-pointer hover:bg-primary/5" {...editTriggerProps(item, "probability")}>
                  {isEditing(item, "probability") ? (
                    <Select
                      value={item.probability}
                      onChange={(event) => updateRisk(item.id, "probability", event.target.value as RiskLevel)}
                      onKeyDown={handleEditKeyDown}
                      className={inlineSelectClass}
                      autoFocus
                    >
                      {riskLevelOptions.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </Select>
                  ) : <Badge variant={levelVariant[item.probability]}>{item.probability}</Badge>}
                </TableCell>
                <TableCell className="cursor-pointer hover:bg-primary/5" {...editTriggerProps(item, "impact")}>
                  {isEditing(item, "impact") ? (
                    <Select
                      value={item.impact}
                      onChange={(event) => updateRisk(item.id, "impact", event.target.value as RiskLevel)}
                      onKeyDown={handleEditKeyDown}
                      className={inlineSelectClass}
                      autoFocus
                    >
                      {riskLevelOptions.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </Select>
                  ) : <Badge variant={levelVariant[item.impact]}>{item.impact}</Badge>}
                </TableCell>
                <TableCell className="cursor-pointer hover:bg-primary/5" {...editTriggerProps(item, "level")}>
                  {isEditing(item, "level") ? (
                    <Select
                      value={item.level}
                      onChange={(event) => updateRisk(item.id, "level", event.target.value as RiskLevel)}
                      onKeyDown={handleEditKeyDown}
                      className={inlineSelectClass}
                      autoFocus
                    >
                      {riskLevelOptions.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </Select>
                  ) : <Badge variant={levelVariant[item.level]}>{item.level}</Badge>}
                </TableCell>
                <TableCell className="cursor-pointer hover:bg-primary/5" {...editTriggerProps(item, "response")}>
                  {isEditing(item, "response") ? (
                    <Textarea
                      value={item.response}
                      onChange={(event) => updateRisk(item.id, "response", event.target.value)}
                      onKeyDown={handleEditKeyDown}
                      className={inlineTextareaClass}
                      autoFocus
                    />
                  ) : item.response}
                </TableCell>
                <TableCell className="cursor-pointer whitespace-nowrap hover:bg-primary/5" {...editTriggerProps(item, "owner")}>
                  {isEditing(item, "owner") ? (
                    <Input
                      value={item.owner}
                      onChange={(event) => updateRisk(item.id, "owner", event.target.value)}
                      onKeyDown={handleEditKeyDown}
                      className={`${inlineInputClass} w-[96px]`}
                      autoFocus
                    />
                  ) : item.owner}
                </TableCell>
                <TableCell className="cursor-pointer hover:bg-primary/5" {...editTriggerProps(item, "status")}>
                  {isEditing(item, "status") ? (
                    <Select
                      value={item.status}
                      onChange={(event) => updateRisk(item.id, "status", event.target.value as RiskStatus)}
                      onKeyDown={handleEditKeyDown}
                      className={inlineSelectClass}
                      autoFocus
                    >
                      {riskStatusOptions.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </Select>
                  ) : <Badge variant={statusVariant[item.status]}>{item.status}</Badge>}
                </TableCell>
                <TableCell className="cursor-pointer whitespace-nowrap hover:bg-primary/5" {...editTriggerProps(item, "targetDate")}>
                  {isEditing(item, "targetDate") ? (
                    <Input
                      type="date"
                      value={item.targetDate}
                      onChange={(event) => updateRisk(item.id, "targetDate", event.target.value)}
                      onKeyDown={handleEditKeyDown}
                      className={`${inlineInputClass} w-[122px]`}
                      autoFocus
                    />
                  ) : item.targetDate}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
