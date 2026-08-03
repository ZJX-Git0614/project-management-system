ALTER TABLE "ProjectGanttTask"
  ALTER COLUMN "taskDescription" SET DEFAULT '无';

UPDATE "ProjectGanttTask"
SET "taskDescription" = '无',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE BTRIM(COALESCE("taskDescription", '')) = '';
