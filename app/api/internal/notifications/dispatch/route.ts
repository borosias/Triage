import { NextResponse } from "next/server";
import { z } from "zod";

import { dispatchNotificationDelivery } from "@/lib/notification-dispatch";
import {
  acquireNotificationDelivery,
  markNotificationDeliveryFailed,
  markNotificationDeliverySent,
} from "@/lib/notification-delivery-store";
import { env } from "@/lib/env";
import { notify } from "@/lib/notify";

const webhookPayloadSchema = z
  .object({
    type: z.literal("INSERT"),
    table: z.literal("NotificationDelivery"),
    schema: z.literal("public"),
    record: z
      .object({
        id: z.uuid(),
      })
      .passthrough(),
  })
  .passthrough();

const dispatchDependencies = {
  acquire: acquireNotificationDelivery,
  notify,
  markSent: markNotificationDeliverySent,
  markFailed: markNotificationDeliveryFailed,
};

export async function POST(request: Request) {
  if (
    request.headers.get("x-notification-webhook-secret") !==
    env.NOTIFICATION_WEBHOOK_SECRET
  ) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid notification webhook." },
      { status: 400 },
    );
  }

  const parsedPayload = webhookPayloadSchema.safeParse(payload);

  if (!parsedPayload.success) {
    return NextResponse.json(
      { error: "Invalid notification webhook." },
      { status: 400 },
    );
  }

  try {
    const result = await dispatchNotificationDelivery(
      parsedPayload.data.record.id,
      dispatchDependencies,
    );

    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      { error: "Notification dispatch unavailable." },
      { status: 503 },
    );
  }
}
