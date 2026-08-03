import "server-only";

import { db } from "@/lib/db";

export function getWorkspaceMembership(userId: string, workspaceId: string) {
  return db.workspaceMembership.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId,
        userId,
      },
    },
    select: {
      role: true,
      workspaceId: true,
      userId: true,
    },
  });
}
