import { describe, expect, it } from "vitest";

import {
  extractProjectSnapshots,
  transformProjectSnapshotAccounts,
  type ProjectDataSnapshot,
} from "@/lib/project-restore";

describe("project restore multi-owner data", () => {
  it("exports deliverable status through its parent deliverable project", async () => {
    const executedQueries: string[] = [];
    const queryRawUnsafe = async (query: string, tableOrProjectId: string) => {
      executedQueries.push(query);
      if (query.includes("information_schema.columns")) {
        if (tableOrProjectId === "Project") return [{ column_name: "id", data_type: "text", udt_name: "text" }];
        if (tableOrProjectId === "ProjectDeliverableStatus") return [{ column_name: "id", data_type: "text", udt_name: "text" }];
        return [];
      }
      if (query.includes('FROM "ProjectDeliverableStatus"')) return [{ id: "status-1" }];
      if (query.includes('FROM "Project"')) return [{ id: "project-1", name: "项目一" }];
      return [];
    };

    const snapshots = await extractProjectSnapshots({ $queryRawUnsafe: queryRawUnsafe } as never, ["project-1"]);
    expect(snapshots[0].tables.find((table) => table.table === "ProjectDeliverableStatus")?.rows).toEqual([{ id: "status-1" }]);
    expect(executedQueries.some((query) => query.includes('JOIN "ProjectDeliverable" deliverable'))).toBe(true);
    expect(executedQueries.some((query) => query.includes('FROM "ProjectDeliverableStatus" WHERE "projectId"'))).toBe(false);
  });

  it("exports the task owner join table as part of a project snapshot", async () => {
    const queryRawUnsafe = async (query: string, tableOrProjectId: string) => {
      if (query.includes("information_schema.columns")) {
        return tableOrProjectId === "ProjectGanttTaskOwner"
          ? [
            { column_name: "taskId", data_type: "text", udt_name: "text" },
            { column_name: "projectMemberId", data_type: "text", udt_name: "text" },
          ]
          : tableOrProjectId === "Project"
            ? [{ column_name: "id", data_type: "text", udt_name: "text" }]
            : [];
      }
      if (query.includes('FROM "ProjectGanttTaskOwner"')) {
        return [{ taskId: "task-1", projectMemberId: "member-1" }];
      }
      if (query.includes('FROM "Project"')) return [{ id: "project-1", name: "项目一" }];
      return [];
    };

    const snapshots = await extractProjectSnapshots({ $queryRawUnsafe: queryRawUnsafe } as never, ["project-1"]);
    expect(snapshots[0].tables.find((table) => table.table === "ProjectGanttTaskOwner")?.rows).toEqual([
      { taskId: "task-1", projectMemberId: "member-1" },
    ]);
  });

  it("remaps and deduplicates owner links when two source accounts map to one account", () => {
    const snapshot: ProjectDataSnapshot = {
      projectId: "project-1",
      projectName: "项目一",
      tables: [
        {
          table: "ProjectMember",
          columns: [],
          rows: [
            { id: "member-a", accountId: "source-a" },
            { id: "member-b", accountId: "source-b" },
          ],
        },
        {
          table: "ProjectGanttTask",
          columns: [],
          rows: [{ id: "task-1", ownerMemberId: "member-b" }],
        },
        {
          table: "ProjectGanttTaskOwner",
          columns: [],
          rows: [
            { taskId: "task-1", projectMemberId: "member-a" },
            { taskId: "task-1", projectMemberId: "member-b" },
          ],
        },
        {
          table: "ProjectProcurementItem",
          columns: [],
          rows: [{ id: "purchase-1", buyerMemberId: "member-b" }],
        },
      ],
    };

    const transformed = transformProjectSnapshotAccounts(snapshot, new Map([
      ["source-a", "target-account"],
      ["source-b", "target-account"],
    ]));

    expect(transformed.tables.find((table) => table.table === "ProjectMember")?.rows).toEqual([
      { id: "member-a", accountId: "target-account" },
    ]);
    expect(transformed.tables.find((table) => table.table === "ProjectGanttTask")?.rows[0].ownerMemberId).toBe("member-a");
    expect(transformed.tables.find((table) => table.table === "ProjectGanttTaskOwner")?.rows).toEqual([
      { taskId: "task-1", projectMemberId: "member-a" },
    ]);
    expect(transformed.tables.find((table) => table.table === "ProjectProcurementItem")?.rows[0].buyerMemberId).toBe("member-a");
  });
});
