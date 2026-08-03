import "server-only";

import type { Prisma } from "@/generated/prisma/client";

export function sweepStaleClaims(
  client: Prisma.TransactionClient,
  workspaceId: string,
) {
  return client.$executeRaw`
    UPDATE "Item"
    SET
      "claimedById" = NULL,
      "claimedAt" = NULL
    WHERE "workspaceId" = ${workspaceId}::uuid
      AND "status" = 'OPEN'::"ItemStatus"
      AND "claimedAt" IS NOT NULL
      AND "claimedAt" < CURRENT_TIMESTAMP - INTERVAL '30 minutes'
  `;
}
