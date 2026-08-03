import type { NotificationTarget } from "@/lib/notify";

export const NOTIFICATION_FAILURE_VALUE = "Notification attempt failed.";

export type AcquiredNotificationDelivery = NotificationTarget & {
  id: string;
};

type DispatchNotificationDependencies = {
  acquire: (notificationId: string) => Promise<AcquiredNotificationDelivery | null>;
  notify: (delivery: AcquiredNotificationDelivery) => Promise<void>;
  markSent: (notificationId: string) => Promise<void>;
  markFailed: (notificationId: string, error: string) => Promise<void>;
};

export async function dispatchNotificationDelivery(
  notificationId: string,
  dependencies: DispatchNotificationDependencies,
) {
  const delivery = await dependencies.acquire(notificationId);

  if (!delivery) {
    return { attempted: false } as const;
  }

  try {
    await dependencies.notify(delivery);
  } catch {
    await dependencies.markFailed(notificationId, NOTIFICATION_FAILURE_VALUE);
    return { attempted: true, status: "FAILED" } as const;
  }

  await dependencies.markSent(notificationId);
  return { attempted: true, status: "SENT" } as const;
}
