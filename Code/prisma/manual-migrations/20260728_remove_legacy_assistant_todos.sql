-- Remove legacy assistant-generated placeholder todos that existed before this release.
-- Manual/user-created todos and system notifications are intentionally untouched.
DELETE FROM "TodoItem"
WHERE "type" = 'ASSISTANT'
  AND "createdAt" < TIMESTAMPTZ '2026-07-28 15:30:00+08';
