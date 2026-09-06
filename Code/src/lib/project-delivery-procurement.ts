import {
  DeliverableLifecycleStatus,
  DeliverableType,
  DeliveryStage,
  MaterialListType,
  MaterialRevisionStatus,
  OutsourceMode,
  ProcurementStatus,
  ProcurementSourceType,
} from "@prisma/client";

export const DELIVERY_REVIEW_STATUSES = new Set<DeliverableLifecycleStatus>([
  DeliverableLifecycleStatus.READY_FOR_REVIEW,
  DeliverableLifecycleStatus.ACCEPTED,
  DeliverableLifecycleStatus.DELIVERED,
]);

const deliverableTypeLabels: Record<DeliverableType, string> = {
  SOFTWARE: "软件",
  HARDWARE: "硬件",
};

const outsourceModeLabels: Record<OutsourceMode, string> = {
  NO: "否",
  YES: "是",
  PARTIAL: "部分",
};

const procurementStatusLabels: Record<ProcurementStatus, string> = {
  DRAFT: "草稿",
  PENDING_PURCHASE: "待采购",
  SOURCING: "寻源中",
  ORDERED: "已下单",
  PARTIALLY_RECEIVED: "部分到货",
  RECEIVED: "已到货",
  INSPECTING: "检验中",
  ACCEPTED: "验收通过",
  REJECTED: "验收退回",
  CLOSED: "已关闭",
  ON_HOLD: "已挂起",
  CANCELLED: "已取消",
};

const procurementTransitions: Partial<Record<ProcurementStatus, ProcurementStatus[]>> = {
  DRAFT: ["PENDING_PURCHASE", "SOURCING", "ON_HOLD", "CANCELLED"],
  PENDING_PURCHASE: ["SOURCING", "ON_HOLD", "CANCELLED"],
  SOURCING: ["ORDERED", "ON_HOLD", "CANCELLED"],
  ORDERED: ["PARTIALLY_RECEIVED", "RECEIVED", "ON_HOLD"],
  PARTIALLY_RECEIVED: ["RECEIVED", "ON_HOLD"],
  RECEIVED: ["INSPECTING", "ACCEPTED", "ON_HOLD"],
  INSPECTING: ["ACCEPTED", "REJECTED", "ON_HOLD"],
  REJECTED: ["SOURCING", "ON_HOLD", "CANCELLED"],
  ACCEPTED: ["CLOSED"],
  ON_HOLD: ["PENDING_PURCHASE", "SOURCING", "ORDERED", "CANCELLED"],
};

type DeliveryRecord = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  type: DeliverableType;
  outsourceMode: OutsourceMode;
  sortOrder: number;
  remark: string;
  createdAt: Date;
  updatedAt: Date;
  status: {
    lifecycleStatus: DeliverableLifecycleStatus;
    gitUrl: string;
    gitRef: string;
    hasPrototype: boolean;
    prototypeQuantity: number;
    massProductionQuantity: number;
    acceptedAt: Date | null;
    deliveredAt: Date | null;
  } | null;
  revisions: Array<{
    stage: DeliveryStage;
    listType: MaterialListType;
    status: MaterialRevisionStatus;
  }>;
};

export const parseDeliverableType = (value: unknown): DeliverableType | null => {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "SOFTWARE" || value === "软件") return DeliverableType.SOFTWARE;
  if (normalized === "HARDWARE" || value === "硬件") return DeliverableType.HARDWARE;
  return null;
};

export const parseOutsourceMode = (value: unknown): OutsourceMode | null => {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "NO" || value === "否") return OutsourceMode.NO;
  if (normalized === "YES" || value === "是") return OutsourceMode.YES;
  if (normalized === "PARTIAL" || value === "部分") return OutsourceMode.PARTIAL;
  return null;
};

export const parseDeliveryStage = (value: unknown): DeliveryStage | null => {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "PROTOTYPE" || value === "样机") return DeliveryStage.PROTOTYPE;
  if (normalized === "MASS_PRODUCTION" || value === "量产") return DeliveryStage.MASS_PRODUCTION;
  return null;
};

export const parseMaterialListType = (value: unknown): MaterialListType | null => {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "BOM" || value === "BOM清单") return MaterialListType.BOM;
  if (normalized === "CABLE_LIST" || value === "线缆清单") return MaterialListType.CABLE_LIST;
  return null;
};

export const parseDeliveryStatus = (value: unknown): DeliverableLifecycleStatus | null => {
  const normalized = String(value ?? "").trim().toUpperCase();
  return Object.values(DeliverableLifecycleStatus).includes(normalized as DeliverableLifecycleStatus)
    ? normalized as DeliverableLifecycleStatus
    : null;
};

export const parseProcurementStatus = (value: unknown): ProcurementStatus | null => {
  const normalized = String(value ?? "").trim().toUpperCase();
  return Object.values(ProcurementStatus).includes(normalized as ProcurementStatus)
    ? normalized as ProcurementStatus
    : null;
};

export const parseProcurementSourceType = (value: unknown): ProcurementSourceType | null => {
  const normalized = String(value ?? "").trim().toUpperCase();
  return Object.values(ProcurementSourceType).includes(normalized as ProcurementSourceType)
    ? normalized as ProcurementSourceType
    : null;
};

const hasReleasedMaterial = (
  revisions: DeliveryRecord["revisions"],
  stage: DeliveryStage,
  listType: MaterialListType,
) => revisions.some((revision) => (
  revision.stage === stage
  && revision.listType === listType
  && revision.status === MaterialRevisionStatus.RELEASED
));

export const serializeDeliverable = (deliverable: DeliveryRecord) => {
  const status = deliverable.status;
  const prototypeBomReady = hasReleasedMaterial(deliverable.revisions, DeliveryStage.PROTOTYPE, MaterialListType.BOM);
  const prototypeCableListReady = hasReleasedMaterial(deliverable.revisions, DeliveryStage.PROTOTYPE, MaterialListType.CABLE_LIST);
  const massBomReady = hasReleasedMaterial(deliverable.revisions, DeliveryStage.MASS_PRODUCTION, MaterialListType.BOM);
  const massCableListReady = hasReleasedMaterial(deliverable.revisions, DeliveryStage.MASS_PRODUCTION, MaterialListType.CABLE_LIST);

  return {
    id: deliverable.id,
    name: deliverable.name,
    quantity: deliverable.quantity,
    unit: deliverable.unit,
    type: deliverableTypeLabels[deliverable.type],
    typeCode: deliverable.type,
    outsourceMode: outsourceModeLabels[deliverable.outsourceMode],
    outsourceModeCode: deliverable.outsourceMode,
    sortOrder: deliverable.sortOrder,
    remark: deliverable.remark,
    lifecycleStatus: status?.lifecycleStatus ?? DeliverableLifecycleStatus.DRAFT,
    gitUrl: status?.gitUrl ?? "",
    gitRef: status?.gitRef ?? "",
    hasPrototype: status?.hasPrototype ?? false,
    prototypeQuantity: status?.prototypeQuantity ?? 0,
    massProductionQuantity: status?.massProductionQuantity ?? 0,
    prototypeBomReady,
    prototypeCableListReady,
    massBomReady,
    massCableListReady,
    bomReady: massBomReady && (!status?.hasPrototype || prototypeBomReady),
    cableListReady: massCableListReady && (!status?.hasPrototype || prototypeCableListReady),
    acceptedAt: status?.acceptedAt?.toISOString() ?? null,
    deliveredAt: status?.deliveredAt?.toISOString() ?? null,
    createdAt: deliverable.createdAt.toISOString(),
    updatedAt: deliverable.updatedAt.toISOString(),
  };
};

export const validateDeliveryReviewGate = (params: {
  deliverable: DeliveryRecord;
  nextStatus: DeliverableLifecycleStatus;
  gitUrl: string;
  hasPrototype: boolean;
}) => {
  if (!DELIVERY_REVIEW_STATUSES.has(params.nextStatus)) return null;

  if (params.deliverable.type === DeliverableType.SOFTWARE) {
    const normalizedGitUrl = params.gitUrl.trim();
    if (!normalizedGitUrl) return "软件交付物进入待评审前必须填写 Git 地址";
    if (!/^(https?|ssh|git):\/\/|^[\w.-]+@[\w.-]+:/.test(normalizedGitUrl)) {
      return "Git 地址格式无效";
    }
    return null;
  }

  const requiresPrototype = params.hasPrototype;
  const required = [
    [DeliveryStage.MASS_PRODUCTION, MaterialListType.BOM, "量产 BOM 清单"],
    [DeliveryStage.MASS_PRODUCTION, MaterialListType.CABLE_LIST, "量产线缆清单"],
    ...(requiresPrototype ? [
      [DeliveryStage.PROTOTYPE, MaterialListType.BOM, "样机 BOM 清单"],
      [DeliveryStage.PROTOTYPE, MaterialListType.CABLE_LIST, "样机线缆清单"],
    ] as const : []),
  ] as const;

  const missing = required
    .filter(([stage, listType]) => !hasReleasedMaterial(params.deliverable.revisions, stage, listType))
    .map(([, , label]) => label);
  return missing.length ? `硬件交付物进入待评审前必须发布：${missing.join("、")}` : null;
};

export const isProcurementTransitionAllowed = (from: ProcurementStatus, to: ProcurementStatus) => (
  from === to || procurementTransitions[from]?.includes(to) === true
);

export const procurementStatusLabel = (status: ProcurementStatus) => procurementStatusLabels[status];
