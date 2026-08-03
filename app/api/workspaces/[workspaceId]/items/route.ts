import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import {
  decodeItemCursor,
  encodeItemCursor,
  type ItemCursor,
} from "@/lib/item-pagination";
import { getCurrentUser } from "@/lib/session";
import { sweepStaleClaims } from "@/lib/stale-claims";
import { getWorkspaceMembership } from "@/lib/workspace-access";

const workspaceIdSchema = z.uuid();
const pageSize = 50;

type ItemsRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type QueueItemRow = {
  id: string;
  workspaceId: string;
  title: string;
  status: "OPEN";
  claimedById: string | null;
  claimedAt: Date | null;
  createdAt: Date;
  claimantId: string | null;
  claimantName: string | null;
  cursorCreatedAt: string;
};

async function readFirstPage(workspaceId: string) {
  return db.$queryRaw<QueueItemRow[]>`
    SELECT
      item."id",
      item."workspaceId",
      item."title",
      item."status"::text,
      item."claimedById",
      item."claimedAt",
      item."createdAt",
      claimant."id" AS "claimantId",
      claimant."name" AS "claimantName",
      to_char(
        item."createdAt" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS "cursorCreatedAt"
    FROM "Item" AS item
    LEFT JOIN "User" AS claimant ON claimant."id" = item."claimedById"
    WHERE item."workspaceId" = ${workspaceId}::uuid
      AND item."status" = 'OPEN'::"ItemStatus"
    ORDER BY item."createdAt" DESC, item."id" DESC
    LIMIT 51
  `;
}

async function readContinuationPage(workspaceId: string, cursor: ItemCursor) {
  return db.$queryRaw<QueueItemRow[]>`
    SELECT
      item."id",
      item."workspaceId",
      item."title",
      item."status"::text,
      item."claimedById",
      item."claimedAt",
      item."createdAt",
      claimant."id" AS "claimantId",
      claimant."name" AS "claimantName",
      to_char(
        item."createdAt" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS "cursorCreatedAt"
    FROM "Item" AS item
    LEFT JOIN "User" AS claimant ON claimant."id" = item."claimedById"
    WHERE item."workspaceId" = ${workspaceId}::uuid
      AND item."status" = 'OPEN'::"ItemStatus"
      AND (item."createdAt", item."id") < (
        ${cursor.createdAt}::timestamptz,
        ${cursor.id}::uuid
      )
    ORDER BY item."createdAt" DESC, item."id" DESC
    LIMIT 51
  `;
}

export async function GET(request: Request, context: ItemsRouteContext) {
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

    const cursorParams = new URL(request.url).searchParams.getAll("cursor");
    const cursor =
      cursorParams.length === 1
        ? decodeItemCursor(cursorParams[0])
        : cursorParams.length === 0
          ? undefined
          : null;

    if (
      cursor === null ||
      (cursor !== undefined && cursor.workspaceId !== parsedWorkspaceId.data)
    ) {
      return NextResponse.json({ error: "Invalid cursor." }, { status: 400 });
    }

    await sweepStaleClaims(db, parsedWorkspaceId.data);

    const rows = cursor
      ? await readContinuationPage(parsedWorkspaceId.data, cursor)
      : await readFirstPage(parsedWorkspaceId.data);
    const pageRows = rows.slice(0, pageSize);
    const items = pageRows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      status: row.status,
      claimedById: row.claimedById,
      claimedAt: row.claimedAt,
      createdAt: row.createdAt,
      claimedBy:
        row.claimantId && row.claimantName
          ? { id: row.claimantId, name: row.claimantName }
          : null,
    }));
    const finalRow = pageRows.at(-1);
    const nextCursor =
      rows.length > pageSize && finalRow
        ? encodeItemCursor({
            v: 1,
            workspaceId: parsedWorkspaceId.data,
            createdAt: finalRow.cursorCreatedAt,
            id: finalRow.id,
          })
        : null;

    return NextResponse.json({ items, nextCursor });
  } catch {
    return NextResponse.json(
      { error: "Queue service unavailable." },
      { status: 503 },
    );
  }
}
