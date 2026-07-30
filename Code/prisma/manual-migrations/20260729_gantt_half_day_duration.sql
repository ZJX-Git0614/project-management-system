ALTER TABLE "ProjectGanttTask"
  ALTER COLUMN "durationDays" TYPE DOUBLE PRECISION
  USING "durationDays"::double precision;
