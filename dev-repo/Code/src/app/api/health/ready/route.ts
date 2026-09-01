import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    await Promise.all([
      prisma.project.findFirst({ select: { id: true } }),
      prisma.projectGanttTask.findFirst({ select: { id: true } }),
      prisma.projectGanttTaskOwner.findFirst({ select: { taskId: true, projectMemberId: true } }),
      prisma.pmsDataMigration.findFirst({ select: { key: true } }),
    ]);
    return NextResponse.json({ status: "ready" });
  } catch (error) {
    console.error("[ready-check] database validation failed", error);
    return NextResponse.json({ status: "not-ready" }, { status: 503 });
  }
}
