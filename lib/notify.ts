import "server-only";

import { scheduler } from "node:timers/promises";

export type NotificationTarget = {
  itemId: string;
  workspaceId: string;
  resolvedById: string;
};

export async function notify(_target: NotificationTarget) {
  void _target;
  await scheduler.wait(1_000);

  if (Math.random() < 0.2) {
    throw new Error("Notification attempt failed.");
  }
}
