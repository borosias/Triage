import "server-only";

import { db } from "@/lib/db";
import type { AcquiredNotificationDelivery } from "@/lib/notification-dispatch";

type UpdatedDeliveryRow = {
  id: string;
};

export async function acquireNotificationDelivery(notificationId: string) {
  const [delivery] = await db.$queryRaw<AcquiredNotificationDelivery[]>`
    UPDATE "NotificationDelivery"
    SET
      "status" = 'PROCESSING'::"NotificationDeliveryStatus",
      "processingAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${notificationId}::uuid
      AND "status" = 'PENDING'::"NotificationDeliveryStatus"
    RETURNING
      "id",
      "itemId",
      "workspaceId",
      "resolvedById"
  `;

  return delivery ?? null;
}

export async function markNotificationDeliverySent(notificationId: string) {
  const [delivery] = await db.$queryRaw<UpdatedDeliveryRow[]>`
    UPDATE "NotificationDelivery"
    SET
      "status" = 'SENT'::"NotificationDeliveryStatus",
      "finishedAt" = CURRENT_TIMESTAMP,
      "error" = NULL
    WHERE "id" = ${notificationId}::uuid
      AND "status" = 'PROCESSING'::"NotificationDeliveryStatus"
    RETURNING "id"
  `;

  if (!delivery) {
    throw new Error("Notification delivery terminal state was not stored.");
  }
}

export async function markNotificationDeliveryFailed(
  notificationId: string,
  safeError: string,
) {
  const [delivery] = await db.$queryRaw<UpdatedDeliveryRow[]>`
    UPDATE "NotificationDelivery"
    SET
      "status" = 'FAILED'::"NotificationDeliveryStatus",
      "finishedAt" = CURRENT_TIMESTAMP,
      "error" = ${safeError}
    WHERE "id" = ${notificationId}::uuid
      AND "status" = 'PROCESSING'::"NotificationDeliveryStatus"
    RETURNING "id"
  `;

  if (!delivery) {
    throw new Error("Notification delivery terminal state was not stored.");
  }
}
