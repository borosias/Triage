import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { getWorkspaceMembership } from "@/lib/workspace-access";

const workspaceIdSchema = z.uuid();

type ItemsRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(_request: Request, context: ItemsRouteContext) {
  const { workspaceId } = await context.params;
  const parsedWorkspaceId = workspaceIdSchema.safeParse(workspaceId);

  if (!parsedWorkspaceId.success) {
    return NextResponse.json(
      { error: "Invalid workspace ID." },
      { status: 400 },
    );
  }

  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const membership = await getWorkspaceMembership(
      currentUser.id,
      parsedWorkspaceId.data,
    );

    if (!membership) {
      return NextResponse.json(
        { error: "Workspace not found." },
        { status: 404 },
      );
    }

    const items = await db.item.findMany({
      where: {
        workspaceId: parsedWorkspaceId.data,
        status: "OPEN",
      },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        status: true,
        claimedById: true,
        claimedAt: true,
        createdAt: true,
        claimedBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
    });

    return NextResponse.json({ items });
  } catch {
    return NextResponse.json(
      { error: "Queue service unavailable." },
      { status: 503 },
    );
  }
}
