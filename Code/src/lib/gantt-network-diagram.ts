import { buildGanttLeafScheduleNetwork } from "@/lib/gantt-schedule-network";

export type GanttNetworkDiagramKind = "AON" | "AOA" | "CRITICAL_PATH" | "MILESTONE_TIMELINE" | "TIME_SCALED_NETWORK";

export interface GanttNetworkDiagramTask {
  id: string;
  taskCode: string;
  taskName: string;
  parentId?: string | null;
  sortOrder?: number;
  startDate?: string | null;
  finishDate?: string | null;
  durationDays?: number | null;
  isMilestone?: boolean | null;
  isCritical?: boolean | null;
  scheduleStatus?: string | null;
  earlyStartDate?: string | null;
  earlyFinishDate?: string | null;
  lateStartDate?: string | null;
  lateFinishDate?: string | null;
  totalFloatMinutes?: number | null;
  freeFloatMinutes?: number | null;
}

export interface GanttNetworkDiagramDependency {
  id?: string;
  predecessorTaskId: string;
  successorTaskId: string;
  type?: number;
  lag?: number;
  lagFormat?: number;
}

export interface GanttNetworkDiagramInput {
  projectName: string;
  kind: GanttNetworkDiagramKind;
  tasks: GanttNetworkDiagramTask[];
  dependencies: GanttNetworkDiagramDependency[];
}

type DiagramNode = {
  id: string;
  value: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style: string;
};

type DiagramEdge = {
  id: string;
  value: string;
  source: string;
  target: string;
  style: string;
};

const XML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const GANTT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const dependencyTypeLabel = (type: number | undefined) => {
  const normalizedType = typeof type === "number" && Number.isInteger(type) ? type : 1;
  return ({
    0: "FF",
    1: "FS",
    2: "SF",
    3: "SS",
  }[normalizedType] ?? "FS");
};

const lagLabel = (dependency: GanttNetworkDiagramDependency) => {
  const rawLag = Number(dependency.lag ?? 0);
  if (!Number.isFinite(rawLag) || rawLag === 0) return "";
  // Project XML and the persisted model use tenths of a minute for LinkLag.
  const minutes = Math.round(rawLag / 10);
  if (minutes === 0) return "";
  const sign = minutes > 0 ? "+" : "";
  return `${sign}${minutes} 分钟`;
};

const dependencyLabel = (dependency: GanttNetworkDiagramDependency) => (
  [dependencyTypeLabel(dependency.type), lagLabel(dependency)].filter(Boolean).join(" ")
);

export const escapeDrawioXml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => {
  const safeCharacter = character ?? "";
  return XML_ESCAPE[safeCharacter] ?? safeCharacter;
});

const isGanttDate = (value?: string | null) => !!value && GANTT_DATE_PATTERN.test(value);

const parseGanttDate = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};

const formatGanttDate = (value: Date) => value.toISOString().slice(0, 10);

const addDaysInclusive = (startDate: string, durationDays: number) => {
  const start = parseGanttDate(startDate);
  return formatGanttDate(new Date(start.getTime() + Math.max(0, Math.ceil(durationDays) - 1) * MS_PER_DAY));
};

const diffDaysInclusive = (startDate: string, endDate: string) => (
  Math.max(1, Math.round((parseGanttDate(endDate).getTime() - parseGanttDate(startDate).getTime()) / MS_PER_DAY) + 1)
);

const taskFinishDate = (task: GanttNetworkDiagramTask) => {
  if (!isGanttDate(task.startDate)) return "";
  if (isGanttDate(task.finishDate) && task.finishDate! >= task.startDate!) return task.finishDate!;
  const durationDays = Number(task.durationDays);
  if (Number.isFinite(durationDays) && durationDays > 0) return addDaysInclusive(task.startDate!, durationDays);
  return task.startDate!;
};

const taskScheduleRange = (task: GanttNetworkDiagramTask) => {
  if (!isGanttDate(task.startDate)) return null;
  const finishDate = taskFinishDate(task);
  if (!finishDate) return null;
  return { startDate: task.startDate!, finishDate };
};

const taskDurationLabel = (task: GanttNetworkDiagramTask) => {
  const durationDays = Number(task.durationDays);
  if (Number.isFinite(durationDays) && durationDays >= 0) return `${durationDays} 天`;
  const range = taskScheduleRange(task);
  return range ? `${diffDaysInclusive(range.startDate, range.finishDate)} 天` : "";
};

const taskScheduleLabel = (task: GanttNetworkDiagramTask) => {
  const range = taskScheduleRange(task);
  if (!range) return "未排期";
  return [
    `${range.startDate} 至 ${range.finishDate}`,
    taskDurationLabel(task) ? `工期 ${taskDurationLabel(task)}` : "",
  ].filter(Boolean).join(" · ");
};

const taskIsCritical = (task: GanttNetworkDiagramTask) => {
  if (task.totalFloatMinutes != null && Number(task.totalFloatMinutes) !== 0) return false;
  const status = String(task.scheduleStatus ?? "").toUpperCase();
  return task.isCritical === true || status === "CRITICAL";
};

const taskIsMilestone = (task: GanttNetworkDiagramTask) => task.isMilestone === true;

const scheduleRangeFor = (tasks: GanttNetworkDiagramTask[]) => {
  const ranges = tasks.map(taskScheduleRange).filter((range): range is { startDate: string; finishDate: string } => !!range);
  if (ranges.length === 0) return null;
  return {
    startDate: ranges.map((range) => range.startDate).sort()[0],
    finishDate: ranges.map((range) => range.finishDate).sort().at(-1)!,
  };
};

const compareTasks = (left: GanttNetworkDiagramTask, right: GanttNetworkDiagramTask) => (
  (left.sortOrder ?? 0) - (right.sortOrder ?? 0)
  || left.taskCode.localeCompare(right.taskCode, "zh-CN", { numeric: true })
  || left.taskName.localeCompare(right.taskName, "zh-CN")
  || left.id.localeCompare(right.id)
);

const hierarchyOrderedTasks = (tasks: GanttNetworkDiagramTask[]) => {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const childrenByParentId = new Map<string, GanttNetworkDiagramTask[]>();
  const roots: GanttNetworkDiagramTask[] = [];

  for (const task of tasks) {
    if (task.parentId && taskById.has(task.parentId)) {
      const children = childrenByParentId.get(task.parentId) ?? [];
      children.push(task);
      childrenByParentId.set(task.parentId, children);
    } else {
      roots.push(task);
    }
  }
  for (const children of childrenByParentId.values()) children.sort(compareTasks);
  roots.sort(compareTasks);

  const ordered: GanttNetworkDiagramTask[] = [];
  const visited = new Set<string>();
  const visit = (task: GanttNetworkDiagramTask) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    ordered.push(task);
    for (const child of childrenByParentId.get(task.id) ?? []) visit(child);
  };
  roots.forEach(visit);
  [...tasks].sort(compareTasks).forEach(visit);

  return { ordered, childrenByParentId };
};

const graphLayout = (
  tasks: GanttNetworkDiagramTask[],
  dependencies: GanttNetworkDiagramDependency[],
) => {
  const taskIds = new Set(tasks.map((task) => task.id));
  const hierarchyIndex = new Map(tasks.map((task, index) => [task.id, index]));
  const incoming = new Map(tasks.map((task) => [task.id, 0]));
  const successors = new Map(tasks.map((task) => [task.id, [] as string[]]));
  const validDependencies = dependencies.filter((dependency) => (
    taskIds.has(dependency.predecessorTaskId)
    && taskIds.has(dependency.successorTaskId)
    && dependency.predecessorTaskId !== dependency.successorTaskId
  ));

  for (const dependency of validDependencies) {
    successors.get(dependency.predecessorTaskId)?.push(dependency.successorTaskId);
    incoming.set(dependency.successorTaskId, (incoming.get(dependency.successorTaskId) ?? 0) + 1);
  }

  const byOrder = (left: string, right: string) => (
    (hierarchyIndex.get(left) ?? Number.MAX_SAFE_INTEGER) - (hierarchyIndex.get(right) ?? Number.MAX_SAFE_INTEGER)
  );
  const ready = [...tasks]
    .filter((task) => (incoming.get(task.id) ?? 0) === 0)
    .map((task) => task.id)
    .sort(byOrder);
  const levelByTaskId = new Map(tasks.map((task) => [task.id, 0]));
  const visited = new Set<string>();

  while (ready.length > 0) {
    const taskId = ready.shift()!;
    if (visited.has(taskId)) continue;
    visited.add(taskId);
    for (const successorId of (successors.get(taskId) ?? []).sort(byOrder)) {
      levelByTaskId.set(successorId, Math.max(
        levelByTaskId.get(successorId) ?? 0,
        (levelByTaskId.get(taskId) ?? 0) + 1,
      ));
      incoming.set(successorId, (incoming.get(successorId) ?? 1) - 1);
      if ((incoming.get(successorId) ?? 0) === 0) ready.push(successorId);
    }
    ready.sort(byOrder);
  }

  const hasCycle = visited.size !== tasks.length;
  if (hasCycle) {
    // Keep cyclic tasks deterministic and editable; no dependency is discarded.
    tasks.filter((task) => !visited.has(task.id)).forEach((task) => levelByTaskId.set(task.id, 0));
  }

  const positionByTaskId = new Map<string, { x: number; y: number }>();
  const buckets = new Map<number, GanttNetworkDiagramTask[]>();
  for (const task of tasks) {
    const level = levelByTaskId.get(task.id) ?? 0;
    const bucket = buckets.get(level) ?? [];
    bucket.push(task);
    buckets.set(level, bucket);
  }
  for (const [level, bucket] of buckets) {
    bucket.sort(compareTasks);
    bucket.forEach((task, index) => positionByTaskId.set(task.id, {
      x: 100 + level * 390,
      y: 120 + index * 142,
    }));
  }

  return { validDependencies, hasCycle, positionByTaskId };
};

const nodeXml = (node: DiagramNode) => [
  `<mxCell id="${escapeDrawioXml(node.id)}" value="${escapeDrawioXml(node.value)}" style="${escapeDrawioXml(node.style)}" vertex="1" parent="1">`,
  `<mxGeometry x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" as="geometry"/>`,
  "</mxCell>",
].join("");

const edgeXml = (edge: DiagramEdge) => [
  `<mxCell id="${escapeDrawioXml(edge.id)}" value="${escapeDrawioXml(edge.value)}" style="${escapeDrawioXml(edge.style)}" edge="1" parent="1" source="${escapeDrawioXml(edge.source)}" target="${escapeDrawioXml(edge.target)}">`,
  '<mxGeometry relative="1" as="geometry"/>',
  "</mxCell>",
].join("");

const noteNode = (value: string, y: number) => nodeXml({
  id: `note-${y}`,
  value,
  x: 24,
  y,
  width: 940,
  height: 32,
  style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f7fa;strokeColor=#7f8c8d;fontColor=#334155;align=left;spacingLeft=10;fontSize=12;",
});

const textNode = (
  id: string,
  value: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize = 11,
) => nodeXml({
  id,
  value,
  x,
  y,
  width,
  height,
  style: `text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;fontSize=${fontSize};fontColor=#334155;`,
});

const renderTimeScale = (
  tasks: GanttNetworkDiagramTask[],
  y: number,
  idPrefix = "time",
) => {
  const range = scheduleRangeFor(tasks);
  if (!range) {
    return {
      height: 36,
      nodes: [noteNode("未提供可用计划日期：图中仅显示任务逻辑关系。", y)],
    };
  }

  const axisX = 100;
  const axisY = y + 38;
  const axisWidth = 920;
  const totalDays = diffDaysInclusive(range.startDate, range.finishDate);
  const tickCount = Math.min(7, totalDays);
  const tickOffsets = tickCount <= 1
    ? [0]
    : Array.from({ length: tickCount }, (_, index) => Math.round((totalDays - 1) * index / (tickCount - 1)));

  const nodes = [
    nodeXml({
      id: `${idPrefix}-range`,
      value: `时间范围：${range.startDate} 至 ${range.finishDate}，共 ${totalDays} 天`,
      x: 24,
      y,
      width: 940,
      height: 28,
      style: "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=12;fontColor=#475569;",
    }),
    nodeXml({
      id: `${idPrefix}-axis`,
      value: "",
      x: axisX,
      y: axisY,
      width: axisWidth,
      height: 2,
      style: "rounded=0;whiteSpace=wrap;html=1;fillColor=#94a3b8;strokeColor=#94a3b8;",
    }),
  ];

  tickOffsets.forEach((offset, index) => {
    const x = axisX + Math.round(axisWidth * offset / Math.max(1, totalDays - 1));
    const date = formatGanttDate(new Date(parseGanttDate(range.startDate).getTime() + offset * MS_PER_DAY));
    nodes.push(nodeXml({
      id: `${idPrefix}-tick-${index}`,
      value: "",
      x,
      y: axisY - 5,
      width: 1,
      height: 12,
      style: "rounded=0;whiteSpace=wrap;html=1;fillColor=#64748b;strokeColor=#64748b;",
    }));
    nodes.push(textNode(`${idPrefix}-label-${index}`, date, x - 45, axisY + 8, 90, 18));
  });

  return { height: 72, nodes };
};

const createAon = (
  tasks: GanttNetworkDiagramTask[],
  dependencies: GanttNetworkDiagramDependency[],
  positions: Map<string, { x: number; y: number }>,
  options: { criticalOnly?: boolean } = {},
) => {
  const nodes = tasks.map((task) => {
    const position = positions.get(task.id) ?? { x: 100, y: 120 };
    const isCritical = taskIsCritical(task);
    const earlyStart = task.earlyStartDate || task.startDate || "--";
    const earlyFinish = task.earlyFinishDate || taskFinishDate(task) || "--";
    const lateStart = task.lateStartDate || "--";
    const lateFinish = task.lateFinishDate || "--";
    const duration = taskDurationLabel(task) || "--";
    const totalFloat = task.totalFloatMinutes == null
      ? "--"
      : `${Math.round(Number(task.totalFloatMinutes) / 60 * 10) / 10} 小时`;
    const status = task.scheduleStatus ? `状态：${task.scheduleStatus}` : taskScheduleLabel(task);
    return nodeXml({
      id: `task-${task.id}`,
      value: [
        '<table border="1" cellpadding="4" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:10px;">',
        `<tr><td align="center">ES<br/><b>${earlyStart}</b></td><td align="center">工期<br/><b>${duration}</b></td><td align="center">EF<br/><b>${earlyFinish}</b></td></tr>`,
        `<tr><td colspan="3" align="center"><b>${task.taskCode || "未编号"} · ${task.taskName || "未命名任务"}</b><br/><font color="#64748b">${status}</font></td></tr>`,
        `<tr><td align="center">LS<br/><b>${lateStart}</b></td><td align="center">TF<br/><b>${totalFloat}</b></td><td align="center">LF<br/><b>${lateFinish}</b></td></tr>`,
        "</table>",
      ].join(""),
      x: position.x,
      y: position.y,
      width: 320,
      height: 122,
      style: isCritical
        ? "rounded=0;whiteSpace=wrap;html=1;spacing=0;fillColor=#fff7ed;strokeColor=#dc2626;fontColor=#1f2937;fontSize=11;align=center;verticalAlign=middle;strokeWidth=2;"
        : "rounded=0;whiteSpace=wrap;html=1;spacing=0;fillColor=#f8fafc;strokeColor=#64748b;fontColor=#1f2937;fontSize=11;align=center;verticalAlign=middle;",
    });
  });
  const edges = dependencies.map((dependency, index) => edgeXml({
    id: `dependency-${dependency.id || index}`,
    value: dependencyLabel(dependency),
    source: `task-${dependency.predecessorTaskId}`,
    target: `task-${dependency.successorTaskId}`,
    style: options.criticalOnly
      ? "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#dc2626;strokeWidth=2;fontSize=11;labelBackgroundColor=#ffffff;fontColor=#991b1b;"
      : "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#475569;fontSize=11;labelBackgroundColor=#ffffff;",
  }));
  return { nodes, edges };
};

const createAoa = (
  tasks: GanttNetworkDiagramTask[],
  dependencies: GanttNetworkDiagramDependency[],
  positions: Map<string, { x: number; y: number }>,
) => {
  const nodes: string[] = [];
  const edges: string[] = [];
  tasks.forEach((task, index) => {
    const position = positions.get(task.id) ?? { x: 100, y: 120 };
    const startId = `event-${task.id}-start`;
    const finishId = `event-${task.id}-finish`;
    nodes.push(nodeXml({
      id: startId,
      value: `E${index * 2 + 1}`,
      x: position.x,
      y: position.y + 18,
      width: 28,
      height: 28,
      style: "ellipse;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#475569;fontColor=#1f2937;fontSize=10;",
    }));
    nodes.push(nodeXml({
      id: finishId,
      value: `E${index * 2 + 2}`,
      x: position.x + 210,
      y: position.y + 18,
      width: 28,
      height: 28,
      style: "ellipse;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#475569;fontColor=#1f2937;fontSize=10;",
    }));
    edges.push(edgeXml({
      id: `activity-${task.id}`,
      value: `${task.taskCode || "未编号"} ${task.taskName || "未命名任务"}<br/>${taskScheduleLabel(task)}`,
      source: startId,
      target: finishId,
      style: "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#2563eb;fontColor=#1e3a8a;fontSize=11;labelBackgroundColor=#ffffff;",
    }));
  });
  dependencies.forEach((dependency, index) => edges.push(edgeXml({
    id: `logic-${dependency.id || index}`,
    value: dependencyLabel(dependency),
    source: `event-${dependency.predecessorTaskId}-finish`,
    target: `event-${dependency.successorTaskId}-start`,
    style: "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=open;endFill=0;dashed=1;dashPattern=4 4;strokeColor=#64748b;fontSize=10;labelBackgroundColor=#ffffff;",
  })));
  return { nodes, edges };
};

const createTimeScaledNetwork = (
  tasks: GanttNetworkDiagramTask[],
  dependencies: GanttNetworkDiagramDependency[],
  top: number,
) => {
  const range = scheduleRangeFor(tasks);
  if (!range) {
    return {
      nodes: [noteNode("时标网络图需要至少一个叶子任务具备计划开始和计划完成日期。", top)],
      edges: [] as string[],
    };
  }

  const totalDays = diffDaysInclusive(range.startDate, range.finishDate);
  const axisX = 190;
  const dayWidth = Math.max(38, Math.min(72, Math.floor(1500 / Math.max(totalDays, 1))));
  const axisWidth = Math.max(920, totalDays * dayWidth);
  const axisY = top + 54;
  const laneHeight = 58;
  const bottomY = axisY + 36 + Math.max(1, tasks.length) * laneHeight;
  const tickStep = Math.max(1, Math.ceil(totalDays / 20));
  const tickOffsets = Array.from(new Set([
    ...Array.from({ length: Math.ceil(totalDays / tickStep) }, (_, index) => index * tickStep),
    totalDays - 1,
  ].filter((offset) => offset >= 0 && offset < totalDays)));
  const xAt = (offset: number) => axisX + Math.max(0, Math.min(totalDays, offset)) * dayWidth;
  const offsetOf = (date: string) => Math.max(0, Math.min(totalDays - 1, Math.round(
    (parseGanttDate(date).getTime() - parseGanttDate(range.startDate).getTime()) / MS_PER_DAY,
  )));
  const nodes: string[] = [
    nodeXml({
      id: "time-scaled-range",
      value: `时标网络图：${range.startDate} 至 ${range.finishDate}，共 ${totalDays} 天。实线箭线表示活动，虚线箭线表示 FS 逻辑关系；红色活动属于关键路径。`,
      x: 24,
      y: top,
      width: Math.max(960, axisX + axisWidth),
      height: 28,
      style: "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=12;fontColor=#475569;",
    }),
    nodeXml({
      id: "time-scaled-axis",
      value: "",
      x: axisX,
      y: axisY,
      width: axisWidth,
      height: 2,
      style: "rounded=0;whiteSpace=wrap;html=1;fillColor=#334155;strokeColor=#334155;",
    }),
  ];
  const edges: string[] = [];
  const eventIdsByTaskId = new Map<string, { startId: string; finishId: string }>();

  tickOffsets.forEach((offset) => {
    const x = xAt(offset);
    const date = formatGanttDate(new Date(parseGanttDate(range.startDate).getTime() + offset * MS_PER_DAY));
    nodes.push(nodeXml({
      id: `time-scaled-grid-${offset}`,
      value: "",
      x,
      y: axisY - 6,
      width: 1,
      height: bottomY - axisY + 12,
      style: "rounded=0;whiteSpace=wrap;html=1;fillColor=#cbd5e1;strokeColor=#cbd5e1;dashed=1;dashPattern=3 3;",
    }));
    nodes.push(textNode(`time-scaled-label-${offset}`, date, x - 42, axisY - 28, 84, 18, 10));
  });

  tasks.forEach((task, index) => {
    const taskRange = taskScheduleRange(task);
    if (!taskRange) return;
    const startOffset = offsetOf(taskRange.startDate);
    const durationDays = Math.max(1, diffDaysInclusive(taskRange.startDate, taskRange.finishDate));
    const y = axisY + 38 + index * laneHeight;
    const startX = xAt(startOffset);
    const finishX = xAt(Math.min(totalDays, startOffset + durationDays));
    const startId = `time-scaled-start-${task.id}`;
    const finishId = `time-scaled-finish-${task.id}`;
    const isCritical = taskIsCritical(task);
    eventIdsByTaskId.set(task.id, { startId, finishId });
    nodes.push(nodeXml({
      id: startId,
      value: "",
      x: startX - 5,
      y: y - 5,
      width: 10,
      height: 10,
      style: "ellipse;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#334155;strokeWidth=1.5;",
    }));
    nodes.push(nodeXml({
      id: finishId,
      value: "",
      x: finishX - 5,
      y: y - 5,
      width: 10,
      height: 10,
      style: "ellipse;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#334155;strokeWidth=1.5;",
    }));
    nodes.push(textNode(
      `time-scaled-task-label-${task.id}`,
      `${task.taskCode || "未编号"} · ${task.taskName || "未命名任务"}`,
      24,
      y - 12,
      152,
      24,
      11,
    ));
    edges.push(edgeXml({
      id: `time-scaled-activity-${task.id}`,
      value: `${task.taskCode || "未编号"} · ${task.taskName || "未命名任务"}<br/>${taskDurationLabel(task) || "--"}`,
      source: startId,
      target: finishId,
      style: isCritical
        ? "edgeStyle=none;rounded=0;html=1;endArrow=block;endFill=1;strokeColor=#dc2626;strokeWidth=2;fontColor=#991b1b;fontSize=11;labelBackgroundColor=#ffffff;"
        : "edgeStyle=none;rounded=0;html=1;endArrow=block;endFill=1;strokeColor=#2563eb;strokeWidth=1.5;fontColor=#1e3a8a;fontSize=11;labelBackgroundColor=#ffffff;",
    }));
  });

  dependencies.forEach((dependency, index) => {
    const predecessor = eventIdsByTaskId.get(dependency.predecessorTaskId);
    const successor = eventIdsByTaskId.get(dependency.successorTaskId);
    if (!predecessor || !successor) return;
    edges.push(edgeXml({
      id: `time-scaled-dependency-${dependency.id || index}`,
      value: dependencyLabel(dependency),
      source: predecessor.finishId,
      target: successor.startId,
      style: "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=open;endFill=0;dashed=1;dashPattern=5 4;strokeColor=#64748b;fontColor=#475569;fontSize=10;labelBackgroundColor=#ffffff;",
    }));
  });

  return { nodes, edges };
};

const xForDate = (
  date: string,
  range: { startDate: string; finishDate: string },
  axisX = 100,
  axisWidth = 920,
) => {
  const totalDays = diffDaysInclusive(range.startDate, range.finishDate);
  const offset = Math.max(0, Math.min(totalDays - 1, Math.round(
    (parseGanttDate(date).getTime() - parseGanttDate(range.startDate).getTime()) / MS_PER_DAY,
  )));
  return axisX + Math.round(axisWidth * offset / Math.max(1, totalDays - 1));
};

const createMilestoneTimeline = (
  tasks: GanttNetworkDiagramTask[],
  top: number,
) => {
  const milestones = tasks
    .filter(taskIsMilestone)
    .sort((left, right) => (
      (taskFinishDate(left) || left.startDate || "").localeCompare(taskFinishDate(right) || right.startDate || "")
      || compareTasks(left, right)
    ));
  if (milestones.length === 0) {
    return [noteNode("当前项目没有标记为里程碑的任务；里程碑时间线不推断普通任务。", top)];
  }

  const range = scheduleRangeFor(milestones);
  if (!range) {
    return [noteNode("里程碑任务缺少可用日期，无法生成时间线刻度。", top)];
  }

  const scale = renderTimeScale(milestones, top, "milestone-time");
  const axisY = top + 38;
  const lanes = [axisY + 62, axisY + 164, axisY + 266];
  const nodes = [...scale.nodes];

  milestones.forEach((task, index) => {
    const date = taskFinishDate(task) || task.startDate!;
    const x = xForDate(date, range);
    const y = lanes[index % lanes.length];
    nodes.push(nodeXml({
      id: `milestone-connector-${task.id}`,
      value: "",
      x,
      y: axisY + 2,
      width: 1,
      height: Math.max(18, y - axisY - 2),
      style: "rounded=0;whiteSpace=wrap;html=1;fillColor=#cbd5e1;strokeColor=#cbd5e1;",
    }));
    nodes.push(nodeXml({
      id: `milestone-${task.id}`,
      value: `${task.taskCode || "未编号"}<br/><b>${task.taskName || "未命名里程碑"}</b><br/>${date}`,
      x: Math.max(24, Math.min(1000, x - 80)),
      y,
      width: 160,
      height: 72,
      style: "shape=rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;fontColor=#1f2937;fontSize=11;align=center;verticalAlign=middle;",
    }));
  });

  return nodes;
};

const diagramTitle = (kind: GanttNetworkDiagramKind) => ({
  AON: "单代号网络图（活动节点）",
  AOA: "双代号网络图（活动箭线）",
  CRITICAL_PATH: "关键路径网络图",
  MILESTONE_TIMELINE: "里程碑时间线",
  TIME_SCALED_NETWORK: "时标网络图",
}[kind]);

const diagramPageName = (kind: GanttNetworkDiagramKind) => ({
  AON: "单代号网络图",
  AOA: "双代号网络图",
  CRITICAL_PATH: "关键路径网络图",
  MILESTONE_TIMELINE: "里程碑时间线",
  TIME_SCALED_NETWORK: "时标网络图",
}[kind]);

const diagramDescription = (kind: GanttNetworkDiagramKind) => ({
  AON: "任务以节点表示；节点分别展示 ES、EF、LS、LF 与 TF，便于核对 CPM 计算结果。",
  AOA: "任务以实线箭线表示，事件以圆点表示；虚线仅表示任务逻辑关联。",
  CRITICAL_PATH: "仅显示项目 CPM 已计算为关键、且总时差为零的叶子任务及其相互依赖，不重新计算关键路径。",
  MILESTONE_TIMELINE: "仅显示已标记为里程碑的任务，并按计划日期放置在时间线上。",
  TIME_SCALED_NETWORK: "按计划日期绘制活动箭线、时间刻度和 FS 逻辑关系，可用于核对工期与依赖。",
}[kind]);

export const buildGanttNetworkDiagramXml = ({ projectName, kind, tasks, dependencies }: GanttNetworkDiagramInput) => {
  const { ordered } = hierarchyOrderedTasks(tasks);
  const dependenciesBySuccessorId = new Map<string, GanttNetworkDiagramDependency[]>();
  dependencies.forEach((dependency) => {
    dependenciesBySuccessorId.set(dependency.successorTaskId, [
      ...(dependenciesBySuccessorId.get(dependency.successorTaskId) ?? []),
      dependency,
    ]);
  });
  const leafNetwork = buildGanttLeafScheduleNetwork(tasks.map((task) => ({
    id: task.id,
    parentId: task.parentId,
    predecessorDependencies: dependenciesBySuccessorId.get(task.id) ?? [],
  })));
  const leafTaskIds = new Set(leafNetwork.leafTaskIds);
  const leafTasks = ordered.filter((task) => leafTaskIds.has(task.id));
  const expandedDependencies = leafNetwork.dependencies.map((dependency) => ({
    predecessorTaskId: dependency.predecessorTaskId,
    successorTaskId: dependency.successorTaskId,
    type: dependency.type,
    lag: dependency.lag,
    lagFormat: dependency.lagFormat,
  }));

  const criticalTaskIds = new Set(leafTasks.filter(taskIsCritical).map((task) => task.id));
  const displayTasks = kind === "CRITICAL_PATH"
    ? leafTasks.filter((task) => criticalTaskIds.has(task.id))
    : leafTasks;
  const displayDependencies = kind === "CRITICAL_PATH"
    ? expandedDependencies.filter((dependency) => (
        criticalTaskIds.has(dependency.predecessorTaskId)
        && criticalTaskIds.has(dependency.successorTaskId)
      ))
    : expandedDependencies;
  const { validDependencies, hasCycle, positionByTaskId } = graphLayout(displayTasks, displayDependencies);
  const title = diagramTitle(kind);
  const description = diagramDescription(kind);
  const warnings = [
    kind !== "MILESTONE_TIMELINE" && hasCycle ? "检测到循环依赖：已保留全部关系，布局可能无法反映顺序。" : "",
    kind !== "MILESTONE_TIMELINE" && displayDependencies.length !== validDependencies.length ? "已忽略与不存在任务相连或自指的关系；网络图只表达叶子任务。" : "",
  ].filter(Boolean);
  const summary = kind === "MILESTONE_TIMELINE"
    ? `${description} 共 ${ordered.filter(taskIsMilestone).length} 个里程碑。`
    : `${description} 共 ${displayTasks.length} 个叶子任务，${validDependencies.length} 条有效逻辑关系。`;

  const header = [
    nodeXml({
      id: "title",
      value: `${projectName || "项目"} - ${title}`,
      x: 24,
      y: 20,
      width: 940,
      height: 38,
      style: "text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;fontSize=20;fontStyle=1;fontColor=#1f2937;",
    }),
    noteNode(summary, 64),
    ...warnings.map((warning, index) => noteNode(`提示：${warning}`, 102 + index * 36)),
  ];
  const graphTop = 120 + warnings.length * 36;
  const timeScale = kind === "MILESTONE_TIMELINE" || kind === "TIME_SCALED_NETWORK"
    ? { height: 0, nodes: [] as string[] }
    : renderTimeScale(displayTasks, graphTop);
  const contentTop = graphTop + timeScale.height + 24;
  const shiftedPositions = new Map(
    [...positionByTaskId].map(([taskId, position]) => [taskId, { ...position, y: position.y + contentTop - 120 }]),
  );
  const content = kind === "MILESTONE_TIMELINE"
    ? createMilestoneTimeline(ordered, graphTop)
    : kind === "TIME_SCALED_NETWORK"
      ? (() => {
          const graph = createTimeScaledNetwork(displayTasks, validDependencies, graphTop);
          return [...graph.nodes, ...graph.edges];
        })()
    : displayTasks.length === 0
      ? [noteNode(
          kind === "CRITICAL_PATH"
            ? "当前项目没有传入关键路径标记的甘特叶子任务；关键路径网络图不自动推断关键任务。"
            : "当前项目没有可用于网络图的甘特叶子任务。请先创建任务后再导出。",
          contentTop,
        )]
    : (() => {
        const graph = kind === "AON"
          ? createAon(displayTasks, validDependencies, shiftedPositions)
          : kind === "AOA"
            ? createAoa(leafTasks, validDependencies, shiftedPositions)
            : createAon(displayTasks, validDependencies, shiftedPositions, { criticalOnly: true });
        return [...graph.nodes, ...graph.edges];
      })();
  const pageName = diagramPageName(kind);
  const diagramId = `${kind.toLowerCase()}-network`;

  return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net" modified="${new Date().toISOString()}" agent="Ceastar PMS" version="26.0.14" type="device" compressed="false">\n  <diagram id="${diagramId}" name="${pageName}">\n    <mxGraphModel dx="1600" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">\n      <root><mxCell id="0"/><mxCell id="1" parent="0"/>${[...header, ...timeScale.nodes, ...content].join("")}</root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n`;
};

export const buildGanttNetworkDiagramDownloadResponse = (xml: string, fileName: string) => new Response(xml, {
  headers: {
    "Content-Type": "application/vnd.jgraph.mxfile; charset=utf-8",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Cache-Control": "no-store",
  },
});
