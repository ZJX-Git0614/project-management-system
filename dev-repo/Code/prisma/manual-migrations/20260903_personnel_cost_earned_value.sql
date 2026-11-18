-- 人员预算、WBS 分工与实际工时成本。结构由 prisma db push 同步；本脚本同时
-- 支持旧库直接补齐，并且所有历史数据修复均只执行一次。
CREATE TABLE IF NOT EXISTS "PmsDataMigration" (
  "key" TEXT PRIMARY KEY,
  "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "ProjectGanttTask"
  ADD COLUMN IF NOT EXISTS "actualCostMode" TEXT NOT NULL DEFAULT 'AUTO_LABOR';

CREATE TABLE IF NOT EXISTS "ProjectGanttTaskLaborAssignment" (
  "taskId" TEXT NOT NULL,
  "projectMemberId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "plannedWorkHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "remark" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ProjectGanttTaskLaborAssignment_pkey" PRIMARY KEY ("taskId", "projectMemberId"),
  CONSTRAINT "ProjectGanttTaskLaborAssignment_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "ProjectGanttTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectGanttTaskLaborAssignment_projectMemberId_fkey"
    FOREIGN KEY ("projectMemberId") REFERENCES "ProjectMember"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "ProjectBudgetLaborAllocation" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "budgetItemId" TEXT NOT NULL,
  "projectMemberId" TEXT NOT NULL,
  "plannedHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "plannedHourlyCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "remark" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ProjectBudgetLaborAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectBudgetLaborAllocation_budgetItemId_projectMemberId_key" UNIQUE ("budgetItemId", "projectMemberId"),
  CONSTRAINT "ProjectBudgetLaborAllocation_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectBudgetLaborAllocation_budgetItemId_fkey"
    FOREIGN KEY ("budgetItemId") REFERENCES "ProjectBudgetItem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectBudgetLaborAllocation_projectMemberId_fkey"
    FOREIGN KEY ("projectMemberId") REFERENCES "ProjectMember"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "ProjectTaskWorklog" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "projectId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "projectMemberId" TEXT NOT NULL,
  "budgetLaborAllocationId" TEXT,
  "workDate" TEXT NOT NULL,
  "actualHours" DOUBLE PRECISION NOT NULL,
  "hourlyCostSnapshot" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "actualCostSnapshot" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "note" TEXT NOT NULL DEFAULT '',
  "createdBy" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "ProjectTaskWorklog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProjectTaskWorklog_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectTaskWorklog_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "ProjectGanttTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectTaskWorklog_projectMemberId_fkey"
    FOREIGN KEY ("projectMemberId") REFERENCES "ProjectMember"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProjectTaskWorklog_budgetLaborAllocationId_fkey"
    FOREIGN KEY ("budgetLaborAllocationId") REFERENCES "ProjectBudgetLaborAllocation"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ProjectGanttTaskLaborAssignment_projectMemberId_idx"
  ON "ProjectGanttTaskLaborAssignment"("projectMemberId");
CREATE INDEX IF NOT EXISTS "ProjectBudgetLaborAllocation_projectId_projectMemberId_idx"
  ON "ProjectBudgetLaborAllocation"("projectId", "projectMemberId");
CREATE INDEX IF NOT EXISTS "ProjectBudgetLaborAllocation_projectId_budgetItemId_idx"
  ON "ProjectBudgetLaborAllocation"("projectId", "budgetItemId");
CREATE INDEX IF NOT EXISTS "ProjectTaskWorklog_projectId_workDate_idx"
  ON "ProjectTaskWorklog"("projectId", "workDate");
CREATE INDEX IF NOT EXISTS "ProjectTaskWorklog_taskId_projectMemberId_idx"
  ON "ProjectTaskWorklog"("taskId", "projectMemberId");
CREATE INDEX IF NOT EXISTS "ProjectTaskWorklog_projectMemberId_workDate_idx"
  ON "ProjectTaskWorklog"("projectMemberId", "workDate");
CREATE INDEX IF NOT EXISTS "ProjectTaskWorklog_budgetLaborAllocationId_idx"
  ON "ProjectTaskWorklog"("budgetLaborAllocationId");

ALTER TABLE "ProjectGanttTask"
  DROP CONSTRAINT IF EXISTS "ProjectGanttTask_actualCostMode_valid";
ALTER TABLE "ProjectGanttTask"
  ADD CONSTRAINT "ProjectGanttTask_actualCostMode_valid"
  CHECK ("actualCostMode" IN ('LEGACY_AUTO_TASK_RATE', 'LEGACY_MANUAL_TOTAL', 'AUTO_LABOR', 'AUTO_PLUS_ADJUSTMENT'));

ALTER TABLE "ProjectGanttTaskLaborAssignment"
  DROP CONSTRAINT IF EXISTS "ProjectGanttTaskLaborAssignment_plannedWorkHours_nonnegative";
ALTER TABLE "ProjectGanttTaskLaborAssignment"
  ADD CONSTRAINT "ProjectGanttTaskLaborAssignment_plannedWorkHours_nonnegative"
  CHECK ("plannedWorkHours" >= 0);

ALTER TABLE "ProjectBudgetLaborAllocation"
  DROP CONSTRAINT IF EXISTS "ProjectBudgetLaborAllocation_plannedHours_nonnegative";
ALTER TABLE "ProjectBudgetLaborAllocation"
  ADD CONSTRAINT "ProjectBudgetLaborAllocation_plannedHours_nonnegative"
  CHECK ("plannedHours" >= 0);
ALTER TABLE "ProjectBudgetLaborAllocation"
  DROP CONSTRAINT IF EXISTS "ProjectBudgetLaborAllocation_plannedHourlyCost_nonnegative";
ALTER TABLE "ProjectBudgetLaborAllocation"
  ADD CONSTRAINT "ProjectBudgetLaborAllocation_plannedHourlyCost_nonnegative"
  CHECK ("plannedHourlyCost" >= 0);

ALTER TABLE "ProjectTaskWorklog"
  DROP CONSTRAINT IF EXISTS "ProjectTaskWorklog_actualHours_positive";
ALTER TABLE "ProjectTaskWorklog"
  ADD CONSTRAINT "ProjectTaskWorklog_actualHours_positive"
  CHECK ("actualHours" > 0);
ALTER TABLE "ProjectTaskWorklog"
  DROP CONSTRAINT IF EXISTS "ProjectTaskWorklog_cost_nonnegative";
ALTER TABLE "ProjectTaskWorklog"
  ADD CONSTRAINT "ProjectTaskWorklog_cost_nonnegative"
  CHECK ("hourlyCostSnapshot" >= 0 AND "actualCostSnapshot" >= 0);

WITH newly_applied AS (
  INSERT INTO "PmsDataMigration" ("key")
  VALUES ('20260903_personnel_cost_evm_mode_backfill')
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
)
UPDATE "ProjectGanttTask"
SET "actualCostMode" = CASE
  WHEN "actualCost" > 0 THEN 'LEGACY_MANUAL_TOTAL'
  WHEN "actualWorkHours" > 0 THEN 'LEGACY_AUTO_TASK_RATE'
  ELSE 'AUTO_LABOR'
END
WHERE EXISTS (SELECT 1 FROM newly_applied)
  AND "actualCostMode" = 'AUTO_LABOR';

-- 旧人力预算的姓名在项目成员中唯一时，自动建立成员预算分摊；歧义姓名保留为待人工归集。
WITH newly_applied AS (
  INSERT INTO "PmsDataMigration" ("key")
  VALUES ('20260903_personnel_cost_evm_budget_allocation_backfill')
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
)
INSERT INTO "ProjectBudgetLaborAllocation" (
  "id", "createdAt", "updatedAt", "projectId", "budgetItemId", "projectMemberId", "plannedHours", "plannedHourlyCost", "remark"
)
SELECT
  'legacy_' || item."id" || '_' || member."id",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  item."projectId",
  item."id",
  member."id",
  GREATEST(item."personMonths", 0) * 21.75 * 8,
  CASE WHEN item."monthlyCostPerPerson" > 0 THEN item."monthlyCostPerPerson" / (21.75 * 8) ELSE 0 END,
  '由原人力预算人员字段迁移'
FROM "ProjectBudgetItem" AS item
JOIN "ProjectBudgetCategory" AS category
  ON category."id" = item."categoryId" AND category."kind" = 'MANPOWER'
JOIN (
  SELECT "projectId", "personName", MIN("id") AS "id"
  FROM "ProjectMember"
  GROUP BY "projectId", "personName"
  HAVING COUNT(*) = 1
) AS member
  ON member."projectId" = item."projectId" AND member."personName" = item."person"
WHERE EXISTS (SELECT 1 FROM newly_applied)
  AND BTRIM(item."person") <> ''
ON CONFLICT ("budgetItemId", "projectMemberId") DO NOTHING;

-- 旧 WBS 的单一负责人自动成为投入人，父级汇总任务不创建人员分工。
WITH newly_applied AS (
  INSERT INTO "PmsDataMigration" ("key")
  VALUES ('20260903_personnel_cost_evm_task_assignment_backfill')
  ON CONFLICT ("key") DO NOTHING
  RETURNING "key"
)
INSERT INTO "ProjectGanttTaskLaborAssignment" (
  "taskId", "projectMemberId", "createdAt", "updatedAt", "plannedWorkHours", "remark"
)
SELECT
  link."taskId",
  link."projectMemberId",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CASE
    WHEN link."plannedWorkHours" > 0 THEN link."plannedWorkHours"
    ELSE GREATEST(task."estimatedWorkHours", 0) / GREATEST(COUNT(*) OVER (PARTITION BY link."taskId"), 1)
  END,
  '由现有负责人迁移'
FROM "ProjectGanttTaskOwner" AS link
JOIN "ProjectGanttTask" AS task ON task."id" = link."taskId"
WHERE EXISTS (SELECT 1 FROM newly_applied)
  AND NOT EXISTS (
    SELECT 1 FROM "ProjectGanttTask" AS child WHERE child."parentId" = task."id"
  )
ON CONFLICT ("taskId", "projectMemberId") DO NOTHING;
