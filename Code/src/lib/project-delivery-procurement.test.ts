import {
  DeliverableLifecycleStatus,
  DeliverableType,
  DeliveryStage,
  MaterialListType,
  MaterialRevisionStatus,
  OutsourceMode,
  ProcurementStatus,
} from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  isProcurementTransitionAllowed,
  parseDeliverableType,
  parseOutsourceMode,
  validateDeliveryReviewGate,
} from "@/lib/project-delivery-procurement";

const delivery = (type: DeliverableType, revisions: Array<{ stage: DeliveryStage; listType: MaterialListType; status: MaterialRevisionStatus }> = []) => ({
  id: "deliverable-1",
  name: "控制器",
  quantity: 2,
  unit: "套",
  type,
  outsourceMode: OutsourceMode.NO,
  sortOrder: 0,
  remark: "",
  createdAt: new Date("2026-09-06T00:00:00.000Z"),
  updatedAt: new Date("2026-09-06T00:00:00.000Z"),
  status: null,
  revisions,
});

describe("delivery and procurement lifecycle gates", () => {
  it("accepts the Chinese deliverable and outsource vocabulary used by the UI", () => {
    expect(parseDeliverableType("软件")).toBe(DeliverableType.SOFTWARE);
    expect(parseDeliverableType("硬件")).toBe(DeliverableType.HARDWARE);
    expect(parseOutsourceMode("部分")).toBe(OutsourceMode.PARTIAL);
  });

  it("requires a valid Git address before a software deliverable enters review", () => {
    const software = delivery(DeliverableType.SOFTWARE);
    expect(validateDeliveryReviewGate({
      deliverable: software,
      nextStatus: DeliverableLifecycleStatus.READY_FOR_REVIEW,
      gitUrl: "",
      hasPrototype: false,
    })).toContain("Git 地址");
    expect(validateDeliveryReviewGate({
      deliverable: software,
      nextStatus: DeliverableLifecycleStatus.READY_FOR_REVIEW,
      gitUrl: "git@git.example.com:group/controller.git",
      hasPrototype: false,
    })).toBeNull();
  });

  it("requires both sample and mass-production material lists for hardware with a prototype", () => {
    const released = (stage: DeliveryStage, listType: MaterialListType) => ({ stage, listType, status: MaterialRevisionStatus.RELEASED });
    const hardware = delivery(DeliverableType.HARDWARE, [
      released(DeliveryStage.MASS_PRODUCTION, MaterialListType.BOM),
      released(DeliveryStage.MASS_PRODUCTION, MaterialListType.CABLE_LIST),
    ]);
    expect(validateDeliveryReviewGate({
      deliverable: hardware,
      nextStatus: DeliverableLifecycleStatus.READY_FOR_REVIEW,
      gitUrl: "",
      hasPrototype: true,
    })).toContain("样机 BOM 清单");
    hardware.revisions.push(
      released(DeliveryStage.PROTOTYPE, MaterialListType.BOM),
      released(DeliveryStage.PROTOTYPE, MaterialListType.CABLE_LIST),
    );
    expect(validateDeliveryReviewGate({
      deliverable: hardware,
      nextStatus: DeliverableLifecycleStatus.READY_FOR_REVIEW,
      gitUrl: "",
      hasPrototype: true,
    })).toBeNull();
  });

  it("blocks procurement lifecycle shortcuts while allowing the defined recovery path", () => {
    expect(isProcurementTransitionAllowed(ProcurementStatus.SOURCING, ProcurementStatus.ORDERED)).toBe(true);
    expect(isProcurementTransitionAllowed(ProcurementStatus.ORDERED, ProcurementStatus.ACCEPTED)).toBe(false);
    expect(isProcurementTransitionAllowed(ProcurementStatus.REJECTED, ProcurementStatus.SOURCING)).toBe(true);
  });
});
