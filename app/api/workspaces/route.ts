import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export async function GET() {
  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const memberships = await db.workspaceMembership.findMany({
      where: {
        userId: currentUser.id,
      },
      select: {
        role: true,
        workspace: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: {
        workspace: {
          name: "asc",
        },
      },
    });

    return NextResponse.json({
      workspaces: memberships.map((membership) => ({
        ...membership.workspace,
        role: membership.role,
      })),
    });
  } catch {
    return NextResponse.json(
      { error: "Workspace service unavailable." },
      { status: 503 },
    );
  }
}
