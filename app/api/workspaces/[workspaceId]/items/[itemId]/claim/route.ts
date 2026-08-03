import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { sweepStaleClaims } from "@/lib/stale-claims";
import { getWorkspaceMembership } from "@/lib/workspace-access";

const claimRouteParamsSchema = z
  .object({
    workspaceId: z.uuid(),
    itemId: z.uuid(),
  })
  .strict();

type ClaimRouteContext = {
  params: Promise<{ workspaceId: string; itemId: string }>;
};

type ClaimedItemRow = {
  id: string;
  workspaceId: string;
  title: string;
  status: "OPEN";
  claimedById: string;
  claimedAt: Date;
  createdAt: Date;
};

export async function POST(_request: Request, context: ClaimRouteContext) {
  const parsedParams = claimRouteParamsSchema.safeParse(await context.params);

  if (!parsedParams.success) {
    return NextResponse.json({ error: "Invalid claim target." }, { status: 400 });
  }

  const { workspaceId, itemId } = parsedParams.data;

  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
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
        { error: "Viewers cannot claim items." },
        { status: 403 },
      );
    }

    const claimedItem = await db.$transaction(async (tx) => {
      await sweepStaleClaims(tx, workspaceId);

      const [item] = await tx.$queryRaw<ClaimedItemRow[]>`
        UPDATE "Item" AS item
        SET
          "claimedById" = ${currentUser.id}::uuid,
          "claimedAt" = CURRENT_TIMESTAMP
        FROM "WorkspaceMembership" AS membership
        WHERE item."id" = ${itemId}::uuid
          AND item."workspaceId" = ${workspaceId}::uuid
          AND item."status" = 'OPEN'::"ItemStatus"
          AND (
            item."claimedById" IS NULL
            OR (
              item."claimedAt" IS NOT NULL
              AND item."claimedAt" < CURRENT_TIMESTAMP - INTERVAL '30 minutes'
            )
          )
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

      return item ?? null;
    });

    if (claimedItem) {
      return NextResponse.json({
        item: {
          ...claimedItem,
          claimedBy: {
            id: currentUser.id,
            name: currentUser.name,
          },
        },
      });
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
          ? "Item is already claimed."
          : "Item state changed before it could be claimed.",
        item: canonicalItem,
      },
      { status: 409 },
    );
  } catch {
    return NextResponse.json(
      { error: "Claim service unavailable." },
      { status: 503 },
    );
  }
}
