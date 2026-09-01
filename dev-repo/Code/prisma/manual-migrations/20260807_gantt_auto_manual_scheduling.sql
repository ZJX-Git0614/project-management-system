-- Capacity-aware scheduling fields. Existing records preserve their current behaviour:
-- 7.5 hours per day, 100% allocation, no concurrency limit (0 means unlimited).
ALTER TABLE "ProjectMember"
  ADD COLUMN IF NOT EXISTS "capacityHoursPerDay" DOUBLE PRECISION NOT NULL DEFAULT 7.5,
  ADD COLUMN IF NOT EXISTS "productivityRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "maxConcurrentAssignments" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ProjectGanttTaskOwner"
  ADD COLUMN IF NOT EXISTS "unitsPercent" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "plannedWorkHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "assignmentRole" TEXT NOT NULL DEFAULT 'EXECUTOR';

ALTER TABLE "ProjectGanttTask"
  ADD COLUMN IF NOT EXISTS "parentBoundaryMode" TEXT NOT NULL DEFAULT 'ROLLUP',
  ADD COLUMN IF NOT EXISTS "schedulePriority" INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS "effortDriven" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "parallelizable" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "ProjectMember"
  DROP CONSTRAINT IF EXISTS "ProjectMember_capacityHoursPerDay_positive";
ALTER TABLE "ProjectMember"
  ADD CONSTRAINT "ProjectMember_capacityHoursPerDay_positive"
  CHECK ("capacityHoursPerDay" > 0);

ALTER TABLE "ProjectMember"
  DROP CONSTRAINT IF EXISTS "ProjectMember_productivityRate_positive";
ALTER TABLE "ProjectMember"
  ADD CONSTRAINT "ProjectMember_productivityRate_positive"
  CHECK ("productivityRate" > 0);

ALTER TABLE "ProjectMember"
  DROP CONSTRAINT IF EXISTS "ProjectMember_maxConcurrentAssignments_nonnegative";
ALTER TABLE "ProjectMember"
  ADD CONSTRAINT "ProjectMember_maxConcurrentAssignments_nonnegative"
  CHECK ("maxConcurrentAssignments" >= 0);

ALTER TABLE "ProjectGanttTaskOwner"
  DROP CONSTRAINT IF EXISTS "ProjectGanttTaskOwner_unitsPercent_range";
ALTER TABLE "ProjectGanttTaskOwner"
  ADD CONSTRAINT "ProjectGanttTaskOwner_unitsPercent_range"
  CHECK ("unitsPercent" > 0 AND "unitsPercent" <= 100);

ALTER TABLE "ProjectGanttTaskOwner"
  DROP CONSTRAINT IF EXISTS "ProjectGanttTaskOwner_plannedWorkHours_nonnegative";
ALTER TABLE "ProjectGanttTaskOwner"
  ADD CONSTRAINT "ProjectGanttTaskOwner_plannedWorkHours_nonnegative"
  CHECK ("plannedWorkHours" >= 0);

ALTER TABLE "ProjectGanttTask"
  DROP CONSTRAINT IF EXISTS "ProjectGanttTask_parentBoundaryMode_valid";
ALTER TABLE "ProjectGanttTask"
  ADD CONSTRAINT "ProjectGanttTask_parentBoundaryMode_valid"
  CHECK ("parentBoundaryMode" IN ('ROLLUP', 'TARGET', 'LOCKED'));

ALTER TABLE "ProjectGanttTask"
  DROP CONSTRAINT IF EXISTS "ProjectGanttTask_schedulePriority_range";
ALTER TABLE "ProjectGanttTask"
  ADD CONSTRAINT "ProjectGanttTask_schedulePriority_range"
  CHECK ("schedulePriority" >= 0 AND "schedulePriority" <= 1000);
