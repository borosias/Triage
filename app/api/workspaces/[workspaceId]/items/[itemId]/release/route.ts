import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { getWorkspaceMembership } from "@/lib/workspace-access";

const releaseRouteParamsSchema = z
  .object({
    workspaceId: z.uuid(),
    itemId: z.uuid(),
  })
  .strict();

type ReleaseRouteContext = {
  params: Promise<{ workspaceId: string; itemId: string }>;
};

type ReleasedItemRow = {
  id: string;
  workspaceId: string;
  title: string;
  status: "OPEN";
  claimedById: null;
  claimedAt: null;
  createdAt: Date;
};

export async function POST(_request: Request, context: ReleaseRouteContext) {
  const parsedParams = releaseRouteParamsSchema.safeParse(await context.params);

  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid release target." },
      { status: 400 },
    );
  }

  const { workspaceId, itemId } = parsedParams.data;

  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const [releasedItem] = await db.$queryRaw<ReleasedItemRow[]>`
      UPDATE "Item" AS item
      SET
        "claimedById" = NULL,
        "claimedAt" = NULL
      FROM "WorkspaceMembership" AS membership
      WHERE item."id" = ${itemId}::uuid
        AND item."workspaceId" = ${workspaceId}::uuid
        AND item."status" = 'OPEN'::"ItemStatus"
        AND item."claimedById" = ${currentUser.id}::uuid
        AND membership."workspaceId" = item."workspaceId"
        AND membership."userId" = ${currentUser.id}::uuid
        AND membership."role" IN (
          'OWNER'::"WorkspaceRole",
          'MEMBER'::"WorkspaceRole"
        )
      RETURNING
        item."id",
        item."workspaceId",
        item."title",
        item."status"::text,
        item."claimedById",
        item."claimedAt",
        item."createdAt"
    `;

    if (releasedItem) {
      return NextResponse.json({
        item: {
          ...releasedItem,
          claimedBy: null,
        },
      });
    }

    const membership = await getWorkspaceMembership(
      currentUser.id,
      workspaceId,
    );

    if (!membership) {
      return NextResponse.json(
        { error: "Workspace or item not found." },
        { status: 404 },
      );
    }

    if (membership.role === "VIEWER") {
      return NextResponse.json(
        { error: "Viewers cannot release items." },
        { status: 403 },
      );
    }

    const canonicalItem = await db.item.findFirst({
      where: {
        id: itemId,
        workspaceId,
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
    });

    if (!canonicalItem) {
      return NextResponse.json(
        { error: "Workspace or item not found." },
        { status: 404 },
      );
    }

    return NextResponse.json(
      {
        error: canonicalItem.claimedBy
          ? "Item is claimed by another user."
          : "Item is not claimed.",
        item: canonicalItem,
      },
      { status: 409 },
    );
  } catch {
    return NextResponse.json(
      { error: "Release service unavailable." },
      { status: 503 },
    );
  }
}
