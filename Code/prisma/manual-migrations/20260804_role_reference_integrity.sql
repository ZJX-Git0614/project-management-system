CREATE OR REPLACE FUNCTION pg_temp.try_parse_jsonb(value TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN value::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

DO $$
DECLARE
  account_row RECORD;
  normalized_role_names TEXT;
BEGIN
  FOR account_row IN
    SELECT "id", "assignedRoleNames"
    FROM "UserAccount"
  LOOP
    BEGIN
      SELECT COALESCE(
        jsonb_agg(valid_role."roleName" ORDER BY valid_role."firstOrdinal"),
        '[]'::jsonb
      )::text
      INTO normalized_role_names
      FROM (
        SELECT assigned_role."roleName", MIN(assigned_role.ordinality) AS "firstOrdinal"
        FROM jsonb_array_elements_text(account_row."assignedRoleNames"::jsonb)
          WITH ORDINALITY AS assigned_role("roleName", ordinality)
        INNER JOIN "RoleConfig" AS role
          ON role."roleName" = assigned_role."roleName"
        GROUP BY assigned_role."roleName"
      ) AS valid_role;
    EXCEPTION WHEN OTHERS THEN
      normalized_role_names := NULL;
    END;

    UPDATE "UserAccount"
    SET "assignedRoleNames" = normalized_role_names,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = account_row."id"
      AND normalized_role_names IS NOT NULL
      AND "assignedRoleNames" IS DISTINCT FROM normalized_role_names;
  END LOOP;
END $$;

CREATE TEMP TABLE "InvalidProjectMemberRole" AS
SELECT member."id"
FROM "ProjectMember" AS member
LEFT JOIN "RoleConfig" AS role
  ON role."roleName" = member."roleName"
WHERE role."id" IS NULL;

UPDATE "WeeklyItem" AS item
SET "owner" = '',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE item."owner" <> ''
  AND (
    EXISTS (
      SELECT 1
      FROM "ProjectGanttTask" AS task
      INNER JOIN "InvalidProjectMemberRole" AS invalid_member
        ON invalid_member."id" = task."ownerMemberId"
      WHERE task."id" = item."ganttTaskId"
    )
    OR EXISTS (
      SELECT 1
      FROM "WeeklyItemGanttTask" AS item_task
      INNER JOIN "ProjectGanttTask" AS task
        ON task."id" = item_task."ganttTaskId"
      INNER JOIN "InvalidProjectMemberRole" AS invalid_member
        ON invalid_member."id" = task."ownerMemberId"
      WHERE item_task."weeklyItemId" = item."id"
    )
  );

UPDATE "RiskRegisterItem" AS risk
SET "owner" = '',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE risk."owner" <> ''
  AND (
    EXISTS (
      SELECT 1
      FROM "ProjectGanttTask" AS task
      INNER JOIN "InvalidProjectMemberRole" AS invalid_member
        ON invalid_member."id" = task."ownerMemberId"
      WHERE task."id" = risk."ganttTaskId"
    )
    OR EXISTS (
      SELECT 1
      FROM "RiskRegisterItemWeeklyItem" AS risk_item
      INNER JOIN "WeeklyItemGanttTask" AS item_task
        ON item_task."weeklyItemId" = risk_item."weeklyItemId"
      INNER JOIN "ProjectGanttTask" AS task
        ON task."id" = item_task."ganttTaskId"
      INNER JOIN "InvalidProjectMemberRole" AS invalid_member
        ON invalid_member."id" = task."ownerMemberId"
      WHERE risk_item."riskItemId" = risk."id"
    )
    OR EXISTS (
      SELECT 1
      FROM "WeeklyItemGanttTask" AS item_task
      INNER JOIN "ProjectGanttTask" AS task
        ON task."id" = item_task."ganttTaskId"
      INNER JOIN "InvalidProjectMemberRole" AS invalid_member
        ON invalid_member."id" = task."ownerMemberId"
      WHERE item_task."weeklyItemId" = risk."weeklyItemId"
    )
  );

DELETE FROM "ProjectMember" AS member
USING "InvalidProjectMemberRole" AS invalid_member
WHERE member."id" = invalid_member."id";

UPDATE "RoleConfig" AS role
SET "persons" = normalized."persons",
    "updatedAt" = CURRENT_TIMESTAMP
FROM (
  SELECT role_source."id",
    COALESCE(
      jsonb_agg(DISTINCT account."displayName" ORDER BY account."displayName")
        FILTER (WHERE account."id" IS NOT NULL),
      '[]'::jsonb
    )::text AS "persons"
  FROM "RoleConfig" AS role_source
  LEFT JOIN "UserAccount" AS account
    ON account."enabled" = TRUE
    AND pg_temp.try_parse_jsonb(account."assignedRoleNames") ? role_source."roleName"
  GROUP BY role_source."id"
) AS normalized
WHERE role."id" = normalized."id"
  AND role."persons" IS DISTINCT FROM normalized."persons";

DO $$
DECLARE
  permission_row RECORD;
  normalized_permissions TEXT;
BEGIN
  FOR permission_row IN
    SELECT "id", "data"
    FROM "PermissionTree"
  LOOP
    BEGIN
      SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)::text
      INTO normalized_permissions
      FROM jsonb_each(permission_row."data"::jsonb) AS entry
      INNER JOIN "RoleConfig" AS role
        ON role."roleName" = entry.key;
    EXCEPTION WHEN OTHERS THEN
      normalized_permissions := NULL;
    END;

    UPDATE "PermissionTree"
    SET "data" = normalized_permissions
    WHERE "id" = permission_row."id"
      AND normalized_permissions IS NOT NULL
      AND "data" IS DISTINCT FROM normalized_permissions;
  END LOOP;
END $$;
