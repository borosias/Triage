import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";
import { getWorkspaceMembership } from "@/lib/workspace-access";

const resolveRouteParamsSchema = z
  .object({
    workspaceId: z.uuid(),
    itemId: z.uuid(),
  })
  .strict();

type ResolveRouteContext = {
  params: Promise<{ workspaceId: string; itemId: string }>;
};

type ResolvedItemRow = {
  id: string;
  workspaceId: string;
  title: string;
  status: "RESOLVED";
  claimedById: null;
  claimedAt: null;
  resolvedById: string;
  resolvedAt: Date;
  createdAt: Date;
};

export async function POST(_request: Request, context: ResolveRouteContext) {
  const parsedParams = resolveRouteParamsSchema.safeParse(await context.params);

  if (!parsedParams.success) {
    return NextResponse.json(
      { error: "Invalid resolve target." },
      { status: 400 },
    );
  }

  const { workspaceId, itemId } = parsedParams.data;

  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const resolution = await db.$transaction(async (tx) => {
      const [item] = await tx.$queryRaw<ResolvedItemRow[]>`
        UPDATE "Item" AS item
        SET
          "status" = 'RESOLVED'::"ItemStatus",
          "resolvedById" = ${currentUser.id}::uuid,
          "resolvedAt" = CURRENT_TIMESTAMP,
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
          item."resolvedById",
          item."resolvedAt",
          item."createdAt"
      `;

      if (!item) {
        return null;
      }

      const notification = await tx.notificationDelivery.create({
        data: {
          itemId: item.id,
          workspaceId: item.workspaceId,
          resolvedById: currentUser.id,
        },
        select: {
          id: true,
          status: true,
        },
      });

      return { item, notification };
    });

    if (resolution) {
      return NextResponse.json({
        item: {
          ...resolution.item,
          claimedBy: null,
        },
        notification: resolution.notification,
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
        { error: "Viewers cannot resolve items." },
        { status: 403 },
      );
    }

    const canonicalItem = await db.item.findFirst({
      where: {
        id: itemId,
        workspaceId,
      },
      select: {
        id: true,
        workspaceId: true,
        title: true,
        status: true,
        claimedById: true,
        claimedAt: true,
        resolvedById: true,
        resolvedAt: true,
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
        error:
          canonicalItem.status === "RESOLVED"
            ? "Item is already resolved."
            : canonicalItem.claimedById !== currentUser.id
              ? "Item is claimed by another user."
              : "Item state changed before it could be resolved.",
        item: canonicalItem,
      },
      { status: 409 },
    );
  } catch {
    return NextResponse.json(
      { error: "Resolve service unavailable." },
      { status: 503 },
    );
  }
}
