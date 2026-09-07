-- Project delivery and procurement domain (re-runnable).
-- Enum values are constrained as CHECKs rather than native PostgreSQL enums so this
-- migration remains compatible with installations that already use text statuses.
CREATE TABLE IF NOT EXISTS "ProjectDeliverable" (
  "id" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, "projectId" TEXT NOT NULL, "name" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL, "unit" TEXT NOT NULL, "type" TEXT NOT NULL,
  "outsourceMode" TEXT NOT NULL, "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "linkedGanttTaskId" TEXT, "remark" TEXT NOT NULL DEFAULT '', "archivedAt" TIMESTAMP(3),
  CONSTRAINT "ProjectDeliverable_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectDeliverable_type_check" CHECK ("type" IN ('SOFTWARE','HARDWARE')),
  CONSTRAINT "ProjectDeliverable_outsourceMode_check" CHECK ("outsourceMode" IN ('NO','YES','PARTIAL'))
);
CREATE TABLE IF NOT EXISTS "ProjectDeliverableStatus" (
  "id" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, "deliverableId" TEXT NOT NULL, "lifecycleStatus" TEXT NOT NULL DEFAULT 'DRAFT',
  "gitUrl" TEXT NOT NULL DEFAULT '', "gitRef" TEXT NOT NULL DEFAULT '', "buildNotes" TEXT NOT NULL DEFAULT '',
  "hasPrototype" BOOLEAN NOT NULL DEFAULT false, "prototypeQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "massProductionQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0, "reviewNote" TEXT NOT NULL DEFAULT '',
  "acceptedAt" TIMESTAMP(3), "deliveredAt" TIMESTAMP(3), "cancelledReason" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ProjectDeliverableStatus_pkey" PRIMARY KEY ("id"), CONSTRAINT "ProjectDeliverableStatus_deliverableId_key" UNIQUE ("deliverableId"),
  CONSTRAINT "ProjectDeliverableStatus_lifecycleStatus_check" CHECK ("lifecycleStatus" IN ('DRAFT','IN_PROGRESS','READY_FOR_REVIEW','ACCEPTED','DELIVERED','REJECTED','CANCELLED'))
);
CREATE TABLE IF NOT EXISTS "ProjectMaterialRevision" (
  "id" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "projectId" TEXT NOT NULL, "deliverableId" TEXT NOT NULL, "stage" TEXT NOT NULL, "listType" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1, "status" TEXT NOT NULL DEFAULT 'DRAFT', "sourceDocumentFileId" TEXT,
  "releasedAt" TIMESTAMP(3), "supersedesRevisionId" TEXT,
  CONSTRAINT "ProjectMaterialRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectMaterialRevision_unique" UNIQUE ("deliverableId","stage","listType","version"),
  CONSTRAINT "ProjectMaterialRevision_stage_check" CHECK ("stage" IN ('PROTOTYPE','MASS_PRODUCTION')),
  CONSTRAINT "ProjectMaterialRevision_listType_check" CHECK ("listType" IN ('BOM','CABLE_LIST')),
  CONSTRAINT "ProjectMaterialRevision_status_check" CHECK ("status" IN ('DRAFT','RELEASED','SUPERSEDED'))
);
CREATE TABLE IF NOT EXISTS "ProjectMaterialItem" (
  "id" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "revisionId" TEXT NOT NULL, "materialCode" TEXT NOT NULL DEFAULT '', "name" TEXT NOT NULL, "specification" TEXT NOT NULL DEFAULT '',
  "unit" TEXT NOT NULL, "quantityPerUnit" DOUBLE PRECISION NOT NULL, "manufacturer" TEXT NOT NULL DEFAULT '',
  "preferredSupplier" TEXT NOT NULL DEFAULT '', "remark" TEXT NOT NULL DEFAULT '', "sortOrder" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ProjectMaterialItem_pkey" PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "ProjectProcurementItem" (
  "id" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  "projectId" TEXT NOT NULL, "sourceType" TEXT NOT NULL, "sourceRevisionId" TEXT, "sourceMaterialItemId" TEXT, "deliverableId" TEXT,
  "stage" TEXT, "name" TEXT NOT NULL, "specification" TEXT NOT NULL DEFAULT '', "plannedQuantity" DOUBLE PRECISION NOT NULL,
  "orderedQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0, "receivedQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0, "acceptedQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "unit" TEXT NOT NULL, "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0, "plannedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "orderAmount" DOUBLE PRECISION NOT NULL DEFAULT 0, "actualAmount" DOUBLE PRECISION NOT NULL DEFAULT 0, "currency" TEXT NOT NULL DEFAULT 'CNY',
  "status" TEXT NOT NULL DEFAULT 'DRAFT', "buyerMemberId" TEXT, "supplierName" TEXT NOT NULL DEFAULT '', "purchaseRequestNo" TEXT NOT NULL DEFAULT '',
  "orderNo" TEXT NOT NULL DEFAULT '', "expectedArrivalDate" TIMESTAMP(3), "actualArrivalDate" TIMESTAMP(3), "note" TEXT NOT NULL DEFAULT '',
  "budgetItemId" TEXT, "ganttTaskId" TEXT,
  CONSTRAINT "ProjectProcurementItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectProcurementItem_sourceType_check" CHECK ("sourceType" IN ('BOM','CABLE_LIST','MANUAL')),
  CONSTRAINT "ProjectProcurementItem_stage_check" CHECK ("stage" IS NULL OR "stage" IN ('PROTOTYPE','MASS_PRODUCTION')),
  CONSTRAINT "ProjectProcurementItem_status_check" CHECK ("status" IN ('DRAFT','PENDING_PURCHASE','SOURCING','ORDERED','PARTIALLY_RECEIVED','RECEIVED','INSPECTING','ACCEPTED','REJECTED','CLOSED','ON_HOLD','CANCELLED'))
);
CREATE TABLE IF NOT EXISTS "ProjectProcurementStatusLog" (
  "id" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "procurementItemId" TEXT NOT NULL,
  "fromStatus" TEXT, "toStatus" TEXT NOT NULL, "note" TEXT NOT NULL DEFAULT '', "operatorUserId" TEXT NOT NULL DEFAULT '', "operatorName" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ProjectProcurementStatusLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ProjectDeliverable_projectId_sortOrder_idx" ON "ProjectDeliverable"("projectId","sortOrder");
CREATE INDEX IF NOT EXISTS "ProjectDeliverable_projectId_type_idx" ON "ProjectDeliverable"("projectId","type");
CREATE INDEX IF NOT EXISTS "ProjectMaterialRevision_projectId_deliverableId_status_idx" ON "ProjectMaterialRevision"("projectId","deliverableId","status");
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectMaterialRevision_one_released_head_key" ON "ProjectMaterialRevision"("deliverableId","stage","listType") WHERE "status" = 'RELEASED';
CREATE INDEX IF NOT EXISTS "ProjectMaterialItem_revisionId_sortOrder_idx" ON "ProjectMaterialItem"("revisionId","sortOrder");
CREATE INDEX IF NOT EXISTS "ProjectMaterialItem_revisionId_materialCode_idx" ON "ProjectMaterialItem"("revisionId","materialCode");
CREATE INDEX IF NOT EXISTS "ProjectProcurementItem_projectId_status_createdAt_idx" ON "ProjectProcurementItem"("projectId","status","createdAt");
CREATE INDEX IF NOT EXISTS "ProjectProcurementItem_projectId_deliverableId_idx" ON "ProjectProcurementItem"("projectId","deliverableId");
CREATE INDEX IF NOT EXISTS "ProjectProcurementItem_sourceRevisionId_sourceMaterialItemId_idx" ON "ProjectProcurementItem"("sourceRevisionId","sourceMaterialItemId");
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectProcurementItem_projectId_sourceMaterialItemId_key" ON "ProjectProcurementItem"("projectId","sourceMaterialItemId");
CREATE INDEX IF NOT EXISTS "ProjectProcurementStatusLog_procurementItemId_createdAt_idx" ON "ProjectProcurementStatusLog"("procurementItemId","createdAt");
DO $$ BEGIN
  ALTER TABLE "ProjectDeliverable" ADD CONSTRAINT "ProjectDeliverable_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectDeliverable" ADD CONSTRAINT "ProjectDeliverable_linkedGanttTaskId_fkey" FOREIGN KEY ("linkedGanttTaskId") REFERENCES "ProjectGanttTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectDeliverableStatus" ADD CONSTRAINT "ProjectDeliverableStatus_deliverableId_fkey" FOREIGN KEY ("deliverableId") REFERENCES "ProjectDeliverable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectMaterialRevision" ADD CONSTRAINT "ProjectMaterialRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectMaterialRevision" ADD CONSTRAINT "ProjectMaterialRevision_deliverableId_fkey" FOREIGN KEY ("deliverableId") REFERENCES "ProjectDeliverable"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ProjectMaterialRevision_sourceDocumentFileId_fkey' AND confdeltype = 'r'
  ) THEN
    ALTER TABLE "ProjectMaterialRevision" DROP CONSTRAINT IF EXISTS "ProjectMaterialRevision_sourceDocumentFileId_fkey";
    ALTER TABLE "ProjectMaterialRevision" ADD CONSTRAINT "ProjectMaterialRevision_sourceDocumentFileId_fkey" FOREIGN KEY ("sourceDocumentFileId") REFERENCES "ProjectDocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectMaterialRevision" ADD CONSTRAINT "ProjectMaterialRevision_supersedesRevisionId_fkey" FOREIGN KEY ("supersedesRevisionId") REFERENCES "ProjectMaterialRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectMaterialItem" ADD CONSTRAINT "ProjectMaterialItem_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "ProjectMaterialRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectProcurementItem" ADD CONSTRAINT "ProjectProcurementItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectProcurementItem" ADD CONSTRAINT "ProjectProcurementItem_sourceRevisionId_fkey" FOREIGN KEY ("sourceRevisionId") REFERENCES "ProjectMaterialRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectProcurementItem" ADD CONSTRAINT "ProjectProcurementItem_sourceMaterialItemId_fkey" FOREIGN KEY ("sourceMaterialItemId") REFERENCES "ProjectMaterialItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectProcurementItem" ADD CONSTRAINT "ProjectProcurementItem_deliverableId_fkey" FOREIGN KEY ("deliverableId") REFERENCES "ProjectDeliverable"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectProcurementItem" ADD CONSTRAINT "ProjectProcurementItem_buyerMemberId_fkey" FOREIGN KEY ("buyerMemberId") REFERENCES "ProjectMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectProcurementItem" ADD CONSTRAINT "ProjectProcurementItem_budgetItemId_fkey" FOREIGN KEY ("budgetItemId") REFERENCES "ProjectBudgetItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectProcurementItem" ADD CONSTRAINT "ProjectProcurementItem_ganttTaskId_fkey" FOREIGN KEY ("ganttTaskId") REFERENCES "ProjectGanttTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ProjectProcurementStatusLog" ADD CONSTRAINT "ProjectProcurementStatusLog_procurementItemId_fkey" FOREIGN KEY ("procurementItemId") REFERENCES "ProjectProcurementItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
