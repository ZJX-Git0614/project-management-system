ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "ganttCalendarMode" TEXT NOT NULL DEFAULT 'CALENDAR_DAYS';
ALTER TABLE "ProjectGanttTask" ADD COLUMN IF NOT EXISTS "ownerMemberId" TEXT;

UPDATE "ProjectGanttTask"
SET
  "durationMinutes" = GREATEST(1, "durationDays") * 450,
  "estimatedWorkHours" = ROUND((GREATEST(1, "durationDays") * 7.5)::numeric, 2)::double precision;

CREATE INDEX IF NOT EXISTS "ProjectGanttTask_projectId_ownerMemberId_idx"
  ON "ProjectGanttTask"("projectId", "ownerMemberId");

DO $$ BEGIN
  ALTER TABLE "ProjectGanttTask"
    ADD CONSTRAINT "ProjectGanttTask_ownerMemberId_fkey"
    FOREIGN KEY ("ownerMemberId") REFERENCES "ProjectMember"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
