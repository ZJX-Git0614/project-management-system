export type GanttNetworkDiagramKind = "AON" | "AOA";

export interface GanttNetworkDiagramTask {
  id: string;
  taskCode: string;
  taskName: string;
  parentId?: string | null;
  sortOrder?: number;
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
      x: 100 + level * 300,
      y: 120 + index * 110,
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

const createAon = (
  tasks: GanttNetworkDiagramTask[],
  dependencies: GanttNetworkDiagramDependency[],
  positions: Map<string, { x: number; y: number }>,
) => {
  const nodes = tasks.map((task) => {
    const position = positions.get(task.id) ?? { x: 100, y: 120 };
    return nodeXml({
      id: `task-${task.id}`,
      value: `${task.taskCode || "未编号"}<br/><b>${task.taskName || "未命名任务"}</b>`,
      x: position.x,
      y: position.y,
      width: 210,
      height: 58,
      style: "rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#1f2937;fontSize=12;align=center;verticalAlign=middle;",
    });
  });
  const edges = dependencies.map((dependency, index) => edgeXml({
    id: `dependency-${dependency.id || index}`,
    value: dependencyLabel(dependency),
    source: `task-${dependency.predecessorTaskId}`,
    target: `task-${dependency.successorTaskId}`,
    style: "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#475569;fontSize=11;labelBackgroundColor=#ffffff;",
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
      value: `${task.taskCode || "未编号"} ${task.taskName || "未命名任务"}`,
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

export const buildGanttNetworkDiagramXml = ({ projectName, kind, tasks, dependencies }: GanttNetworkDiagramInput) => {
  const { ordered, childrenByParentId } = hierarchyOrderedTasks(tasks);
  const leafTasks = ordered.filter((task) => !(childrenByParentId.get(task.id)?.length));
  const { validDependencies, hasCycle, positionByTaskId } = graphLayout(leafTasks, dependencies);
  const title = kind === "AON" ? "单代号网络图（活动节点）" : "双代号网络图（活动箭线）";
  const description = kind === "AON"
    ? "任务以节点表示，连线表示任务逻辑关系。"
    : "任务以实线箭线表示，事件以圆点表示；虚线仅表示任务逻辑关联。";
  const warnings = [
    hasCycle ? "检测到循环依赖：已保留全部关系，布局可能无法反映顺序。" : "",
    dependencies.length !== validDependencies.length ? "已忽略与汇总任务或不存在任务相连的关系；网络图只表达叶子任务。" : "",
  ].filter(Boolean);

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
    noteNode(`${description} 共 ${leafTasks.length} 个叶子任务，${validDependencies.length} 条有效逻辑关系。`, 64),
    ...warnings.map((warning, index) => noteNode(`提示：${warning}`, 102 + index * 36)),
  ];
  const graphTop = 120 + warnings.length * 36;
  const shiftedPositions = new Map(
    [...positionByTaskId].map(([taskId, position]) => [taskId, { ...position, y: position.y + graphTop - 120 }]),
  );
  const content = leafTasks.length === 0
    ? [noteNode("当前项目没有可用于网络图的甘特叶子任务。请先创建任务后再导出。", graphTop)]
    : (() => {
        const graph = kind === "AON"
          ? createAon(leafTasks, validDependencies, shiftedPositions)
          : createAoa(leafTasks, validDependencies, shiftedPositions);
        return [...graph.nodes, ...graph.edges];
      })();
  const pageName = kind === "AON" ? "单代号网络图" : "双代号网络图";
  const diagramId = `${kind.toLowerCase()}-network`;

  return `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net" modified="${new Date().toISOString()}" agent="Ceastar PMS" version="26.0.14" type="device" compressed="false">\n  <diagram id="${diagramId}" name="${pageName}">\n    <mxGraphModel dx="1600" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">\n      <root><mxCell id="0"/><mxCell id="1" parent="0"/>${[...header, ...content].join("")}</root>\n    </mxGraphModel>\n  </diagram>\n</mxfile>\n`;
};

export const buildGanttNetworkDiagramDownloadResponse = (xml: string, fileName: string) => new Response(xml, {
  headers: {
    "Content-Type": "application/vnd.jgraph.mxfile; charset=utf-8",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Cache-Control": "no-store",
  },
});
