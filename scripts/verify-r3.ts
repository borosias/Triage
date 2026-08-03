import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { Client } from "pg";

const envFile = [".env.local", ".env"].find(existsSync);

if (envFile) {
  loadEnvFile(envFile);
}

const connectionString = process.env.DIRECT_URL;
const webhookSecret = process.env.NOTIFICATION_WEBHOOK_SECRET;

if (!connectionString) {
  throw new Error("DIRECT_URL must be configured before verifying R3.");
}

if (!webhookSecret) {
  throw new Error(
    "NOTIFICATION_WEBHOOK_SECRET must be configured before verifying R3.",
  );
}

const baseUrl = process.env.R3_VERIFY_BASE_URL ?? "http://127.0.0.1:3000";
const safeFailureValue = "Notification attempt failed.";

const users = {
  Alice: "00000000-0000-4000-8000-000000000001",
  Bob: "00000000-0000-4000-8000-000000000002",
  Carol: "00000000-0000-4000-8000-000000000003",
  Dana: "00000000-0000-4000-8000-000000000004",
} as const;

const workspaces = {
  Alpha: "10000000-0000-4000-8000-000000000001",
  Beta: "10000000-0000-4000-8000-000000000002",
} as const;

type QueueItem = {
  id: string;
  workspaceId: string;
  title: string;
  status: "OPEN";
  claimedById: string | null;
  claimedAt: string | null;
  createdAt: string;
  claimedBy: { id: string; name: string } | null;
};

type ItemState = {
  id: string;
  workspaceId: string;
  status: "OPEN" | "RESOLVED";
  claimedById: string | null;
  claimedAt: Date | null;
  resolvedById: string | null;
  resolvedAt: Date | null;
};

type DeliveryState = {
  id: string;
  itemId: string;
  workspaceId: string;
  resolvedById: string;
  status: "PENDING" | "PROCESSING" | "SENT" | "FAILED";
  createdAt: Date;
  processingAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
};

type TestNotificationDelivery = {
  id: string;
  itemId: string;
  workspaceId: string;
  resolvedById: string;
};

async function request(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    redirect: "manual",
  });
}

async function readJson<T>(response: Response) {
  assert.equal(
    response.headers.get("content-type")?.startsWith("application/json"),
    true,
    "response must be JSON",
  );

  return (await response.json()) as T;
}

async function login(name: keyof typeof users) {
  const response = await request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: users[name] }),
  });

  assert.equal(response.status, 200, `${name} login must return 200`);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, `${name} login must set a session cookie`);
  return setCookie.split(";", 1)[0];
}

async function loadQueue(cookie: string, workspaceId: string) {
  const response = await request(`/api/workspaces/${workspaceId}/items`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = await readJson<{ items: QueueItem[] }>(response);
  assert.ok(Array.isArray(body.items));
  return body.items;
}

async function resolveItem(
  cookie: string | undefined,
  workspaceId: string,
  itemId: string,
) {
  return request(
    `/api/workspaces/${workspaceId}/items/${itemId}/resolve`,
    {
      method: "POST",
      headers: cookie ? { cookie } : undefined,
    },
  );
}

function webhookPayload(notificationId: string) {
  return {
    type: "INSERT",
    table: "NotificationDelivery",
    schema: "public",
    record: {
      id: notificationId,
      workspaceId: workspaces.Beta,
      resolvedById: users.Dana,
      status: "FAILED",
    },
    old_record: null,
  };
}

async function dispatchNotification(
  payload: unknown,
  secret: string | undefined,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (secret !== undefined) {
    headers["x-notification-webhook-secret"] = secret;
  }

  return request("/api/internal/notifications/dispatch", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

async function verifyError(response: Response, expectedStatus: number) {
  assert.equal(response.status, expectedStatus);
  const body = await readJson<{ error: string }>(response);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
}

async function readItemStates(client: Client, itemIds: string[]) {
  const { rows } = await client.query<ItemState>(
    `
      SELECT
        "id"::text AS "id",
        "workspaceId"::text AS "workspaceId",
        "status"::text AS "status",
        "claimedById"::text AS "claimedById",
        "claimedAt" AS "claimedAt",
        "resolvedById"::text AS "resolvedById",
        "resolvedAt" AS "resolvedAt"
      FROM "Item"
      WHERE "id" = ANY($1::uuid[])
    `,
    [itemIds],
  );

  return rows;
}

async function readDeliveryStates(client: Client, itemIds: string[]) {
  const { rows } = await client.query<DeliveryState>(
    `
      SELECT
        "id"::text AS "id",
        "itemId"::text AS "itemId",
        "workspaceId"::text AS "workspaceId",
        "resolvedById"::text AS "resolvedById",
        "status"::text AS "status",
        "createdAt" AS "createdAt",
        "processingAt" AS "processingAt",
        "finishedAt" AS "finishedAt",
        "error"
      FROM "NotificationDelivery"
      WHERE "itemId" = ANY($1::uuid[])
      ORDER BY "itemId"
    `,
    [itemIds],
  );

  return rows;
}

const client = new Client({ connectionString });
let clientConnected = false;
let originalItemStates: ItemState[] = [];
let originalDeliveryStates: DeliveryState[] = [];
let touchedItemIds: string[] = [];

try {
  await verifyError(
    await resolveItem(
      undefined,
      "not-a-uuid",
      "20000000-0000-4000-8000-000000000001",
    ),
    400,
  );
  await verifyError(
    await resolveItem(
      undefined,
      workspaces.Alpha,
      "not-an-item-uuid",
    ),
    400,
  );

  const [aliceCookie, bobCookie, carolCookie, danaCookie] = await Promise.all([
    login("Alice"),
    login("Bob"),
    login("Carol"),
    login("Dana"),
  ]);
  const [alphaItems, betaItems] = await Promise.all([
    loadQueue(aliceCookie, workspaces.Alpha),
    loadQueue(aliceCookie, workspaces.Beta),
  ]);

  assert.ok(alphaItems.length >= 7, "Alpha queue must expose seven test items");
  assert.ok(betaItems.length >= 1, "Beta queue must expose one test item");

  const [
    ownerItem,
    memberItem,
    viewerItem,
    outsiderItem,
    otherClaimantItem,
    alphaForeignItem,
    unauthenticatedItem,
  ] = alphaItems;
  const [betaForeignItem] = betaItems;
  touchedItemIds = [
    ownerItem.id,
    memberItem.id,
    viewerItem.id,
    outsiderItem.id,
    otherClaimantItem.id,
    alphaForeignItem.id,
    unauthenticatedItem.id,
    betaForeignItem.id,
  ];

  await client.connect();
  clientConnected = true;
  originalItemStates = await readItemStates(client, touchedItemIds);
  originalDeliveryStates = await readDeliveryStates(client, touchedItemIds);
  assert.equal(originalItemStates.length, touchedItemIds.length);

  const fixtureClaims = new Map<string, string>([
    [ownerItem.id, users.Alice],
    [memberItem.id, users.Bob],
    [viewerItem.id, users.Carol],
    [outsiderItem.id, users.Dana],
    [otherClaimantItem.id, users.Bob],
    [alphaForeignItem.id, users.Alice],
    [unauthenticatedItem.id, users.Alice],
    [betaForeignItem.id, users.Alice],
  ]);

  await client.query("BEGIN");

  try {
    await client.query(
      `DELETE FROM "NotificationDelivery" WHERE "itemId" = ANY($1::uuid[])`,
      [touchedItemIds],
    );

    for (const [itemId, claimedById] of fixtureClaims) {
      const result = await client.query(
        `
          UPDATE "Item"
          SET
            "status" = 'OPEN'::"ItemStatus",
            "claimedById" = $2::uuid,
            "claimedAt" = CURRENT_TIMESTAMP,
            "resolvedById" = NULL,
            "resolvedAt" = NULL
          WHERE "id" = $1::uuid
        `,
        [itemId, claimedById],
      );
      assert.equal(result.rowCount, 1);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const fixtureItemStates = await readItemStates(client, touchedItemIds);
  const fixtureById = new Map(fixtureItemStates.map((item) => [item.id, item]));
  assert.equal((await readDeliveryStates(client, touchedItemIds)).length, 0);

  await verifyError(
    await resolveItem(undefined, workspaces.Alpha, unauthenticatedItem.id),
    401,
  );

  const ownerResponse = await resolveItem(
    aliceCookie,
    workspaces.Alpha,
    ownerItem.id,
  );
  assert.equal(ownerResponse.status, 200);
  const ownerBody = await readJson<{
    item: {
      id: string;
      status: string;
      claimedById: null;
      claimedAt: null;
      resolvedById: string;
      resolvedAt: string;
    };
    notification: { id: string; status: string };
  }>(ownerResponse);
  assert.equal(ownerBody.item.id, ownerItem.id);
  assert.equal(ownerBody.item.status, "RESOLVED");
  assert.equal(ownerBody.item.claimedById, null);
  assert.equal(ownerBody.item.claimedAt, null);
  assert.equal(ownerBody.item.resolvedById, users.Alice);
  assert.equal(typeof ownerBody.item.resolvedAt, "string");
  assert.equal(ownerBody.notification.status, "PENDING");

  const memberResponse = await resolveItem(
    bobCookie,
    workspaces.Alpha,
    memberItem.id,
  );
  assert.equal(memberResponse.status, 200);
  const memberBody = await readJson<{
    item: {
      id: string;
      status: string;
      claimedById: null;
      claimedAt: null;
      resolvedById: string;
      resolvedAt: string;
    };
    notification: { id: string; status: string };
  }>(memberResponse);
  assert.equal(memberBody.item.id, memberItem.id);
  assert.equal(memberBody.item.status, "RESOLVED");
  assert.equal(memberBody.item.claimedById, null);
  assert.equal(memberBody.item.claimedAt, null);
  assert.equal(memberBody.item.resolvedById, users.Bob);
  assert.equal(typeof memberBody.item.resolvedAt, "string");
  assert.equal(memberBody.notification.status, "PENDING");

  await verifyError(
    await resolveItem(carolCookie, workspaces.Alpha, viewerItem.id),
    403,
  );
  await verifyError(
    await resolveItem(danaCookie, workspaces.Alpha, outsiderItem.id),
    404,
  );

  const otherClaimantResponse = await resolveItem(
    aliceCookie,
    workspaces.Alpha,
    otherClaimantItem.id,
  );
  assert.equal(otherClaimantResponse.status, 409);
  const otherClaimantBody = await readJson<{
    error: string;
    item: {
      id: string;
      status: string;
      claimedById: string;
      claimedBy: { id: string; name: string };
    };
  }>(otherClaimantResponse);
  assert.equal(otherClaimantBody.item.id, otherClaimantItem.id);
  assert.equal(otherClaimantBody.item.status, "OPEN");
  assert.equal(otherClaimantBody.item.claimedById, users.Bob);
  assert.equal(otherClaimantBody.item.claimedBy.id, users.Bob);

  await verifyError(
    await resolveItem(
      aliceCookie,
      workspaces.Beta,
      alphaForeignItem.id,
    ),
    404,
  );
  await verifyError(
    await resolveItem(
      aliceCookie,
      workspaces.Alpha,
      betaForeignItem.id,
    ),
    404,
  );
  await verifyError(
    await resolveItem(
      aliceCookie,
      workspaces.Alpha,
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ),
    404,
  );

  const repeatedResponse = await resolveItem(
    aliceCookie,
    workspaces.Alpha,
    ownerItem.id,
  );
  assert.equal(repeatedResponse.status, 409);
  const repeatedBody = await readJson<{
    error: string;
    item: { id: string; status: string; claimedById: null };
  }>(repeatedResponse);
  assert.equal(repeatedBody.item.id, ownerItem.id);
  assert.equal(repeatedBody.item.status, "RESOLVED");
  assert.equal(repeatedBody.item.claimedById, null);

  const resolvedStates = new Map(
    (await readItemStates(client, touchedItemIds)).map((item) => [item.id, item]),
  );

  for (const [resolvedItem, resolverId] of [
    [ownerItem, users.Alice],
    [memberItem, users.Bob],
  ] as const) {
    const state = resolvedStates.get(resolvedItem.id);
    assert.equal(state?.status, "RESOLVED");
    assert.equal(state?.claimedById, null);
    assert.equal(state?.claimedAt, null);
    assert.equal(state?.resolvedById, resolverId);
    assert.ok(state?.resolvedAt instanceof Date);
  }

  for (const unchangedItem of [
    viewerItem,
    outsiderItem,
    otherClaimantItem,
    alphaForeignItem,
    unauthenticatedItem,
    betaForeignItem,
  ]) {
    const finalState = resolvedStates.get(unchangedItem.id);
    const fixtureState = fixtureById.get(unchangedItem.id);
    assert.equal(finalState?.workspaceId, fixtureState?.workspaceId);
    assert.equal(finalState?.status, fixtureState?.status);
    assert.equal(finalState?.claimedById, fixtureState?.claimedById);
    assert.equal(
      finalState?.claimedAt?.getTime(),
      fixtureState?.claimedAt?.getTime(),
    );
    assert.equal(finalState?.resolvedById, fixtureState?.resolvedById);
    assert.equal(finalState?.resolvedAt, fixtureState?.resolvedAt);
  }

  const pendingDeliveries = await readDeliveryStates(client, touchedItemIds);
  assert.equal(pendingDeliveries.length, 2);
  const deliveriesByItemId = new Map(
    pendingDeliveries.map((delivery) => [delivery.itemId, delivery]),
  );
  const ownerDelivery = deliveriesByItemId.get(ownerItem.id);
  const memberDelivery = deliveriesByItemId.get(memberItem.id);
  assert.ok(ownerDelivery);
  assert.ok(memberDelivery);

  for (const [delivery, expectedResolver] of [
    [ownerDelivery, users.Alice],
    [memberDelivery, users.Bob],
  ] as const) {
    assert.equal(delivery.workspaceId, workspaces.Alpha);
    assert.equal(delivery.resolvedById, expectedResolver);
    assert.equal(delivery.status, "PENDING");
    assert.equal(delivery.processingAt, null);
    assert.equal(delivery.finishedAt, null);
    assert.equal(delivery.error, null);
  }

  assert.equal(ownerBody.notification.id, ownerDelivery.id);
  assert.equal(memberBody.notification.id, memberDelivery.id);

  const payload = webhookPayload(ownerDelivery.id);
  await verifyError(await dispatchNotification(payload, undefined), 401);
  await verifyError(
    await dispatchNotification(
      payload,
      "wrong-local-notification-secret-2026",
    ),
    401,
  );
  await verifyError(
    await dispatchNotification(
      { ...payload, type: "UPDATE" },
      webhookSecret,
    ),
    400,
  );
  await verifyError(
    await dispatchNotification(
      { ...payload, schema: "private" },
      webhookSecret,
    ),
    400,
  );
  await verifyError(
    await dispatchNotification(
      { ...payload, table: "Item" },
      webhookSecret,
    ),
    400,
  );
  await verifyError(
    await dispatchNotification(
      { ...payload, record: { id: "not-a-uuid" } },
      webhookSecret,
    ),
    400,
  );

  const dispatchResponse = await dispatchNotification(payload, webhookSecret);
  assert.equal(dispatchResponse.status, 200);
  const dispatchBody = await readJson<{
    attempted: boolean;
    status: "SENT" | "FAILED";
  }>(dispatchResponse);
  assert.equal(dispatchBody.attempted, true);
  assert.ok(["SENT", "FAILED"].includes(dispatchBody.status));

  const [attemptedDelivery] = await readDeliveryStates(client, [ownerItem.id]);
  assert.ok(attemptedDelivery);
  assert.equal(attemptedDelivery.status, dispatchBody.status);
  assert.ok(attemptedDelivery.processingAt instanceof Date);
  assert.ok(attemptedDelivery.finishedAt instanceof Date);

  if (attemptedDelivery.status === "FAILED") {
    assert.equal(attemptedDelivery.error, safeFailureValue);
    assert.ok(attemptedDelivery.error.length <= 160);
  } else {
    assert.equal(attemptedDelivery.error, null);
  }

  const duplicateResponse = await dispatchNotification(payload, webhookSecret);
  assert.equal(duplicateResponse.status, 200);
  assert.deepEqual(await readJson(duplicateResponse), { attempted: false });

  const [duplicateState] = await readDeliveryStates(client, [ownerItem.id]);
  assert.equal(duplicateState.id, attemptedDelivery.id);
  assert.equal(duplicateState.status, attemptedDelivery.status);
  assert.equal(
    duplicateState.processingAt?.getTime(),
    attemptedDelivery.processingAt.getTime(),
  );
  assert.equal(
    duplicateState.finishedAt?.getTime(),
    attemptedDelivery.finishedAt.getTime(),
  );
  assert.equal(duplicateState.error, attemptedDelivery.error);

  const [stillPendingMemberDelivery] = await readDeliveryStates(client, [
    memberItem.id,
  ]);
  assert.equal(stillPendingMemberDelivery.status, "PENDING");
  assert.equal(stillPendingMemberDelivery.processingAt, null);

  const { dispatchNotificationDelivery } = await import(
    "../lib/notification-dispatch"
  );
  const canonicalDelivery: TestNotificationDelivery = {
    id: "30000000-0000-4000-8000-000000000001",
    itemId: ownerItem.id,
    workspaceId: workspaces.Alpha,
    resolvedById: users.Alice,
  };
  let inMemoryStatus: "PENDING" | "PROCESSING" | "SENT" = "PENDING";
  let attemptCount = 0;
  const dependencies = {
    acquire: async (notificationId: string) => {
      assert.equal(notificationId, canonicalDelivery.id);

      if (inMemoryStatus !== "PENDING") {
        return null;
      }

      inMemoryStatus = "PROCESSING";
      return canonicalDelivery;
    },
    notify: async (delivery: TestNotificationDelivery) => {
      assert.deepEqual(delivery, canonicalDelivery);
      attemptCount += 1;
    },
    markSent: async (notificationId: string) => {
      assert.equal(notificationId, canonicalDelivery.id);
      assert.equal(inMemoryStatus, "PROCESSING");
      inMemoryStatus = "SENT";
    },
    markFailed: async () => {
      assert.fail("successful notification must not be marked failed");
    },
  };

  assert.deepEqual(
    await dispatchNotificationDelivery(canonicalDelivery.id, dependencies),
    { attempted: true, status: "SENT" },
  );
  assert.deepEqual(
    await dispatchNotificationDelivery(canonicalDelivery.id, dependencies),
    { attempted: false },
  );
  assert.equal(attemptCount, 1);
  assert.equal(inMemoryStatus, "SENT");

  const storedFailures: string[] = [];
  const failureResult = await dispatchNotificationDelivery(
    "30000000-0000-4000-8000-000000000002",
    {
      acquire: async () => ({
        ...canonicalDelivery,
        id: "30000000-0000-4000-8000-000000000002",
      }),
      notify: async () => {
        throw new Error("sensitive upstream detail");
      },
      markSent: async () => {
        assert.fail("failed notification must not be marked sent");
      },
      markFailed: async (_notificationId: string, error: string) => {
        storedFailures.push(error);
      },
    },
  );
  assert.deepEqual(failureResult, { attempted: true, status: "FAILED" });
  assert.equal(storedFailures.length, 1);
  const [storedFailure] = storedFailures;
  assert.equal(storedFailure, safeFailureValue);
  assert.equal(storedFailure.includes("sensitive"), false);
  assert.ok(storedFailure.length <= 160);

  const queueModule = await import("../app/workspace-queue");
  assert.equal(
    typeof queueModule.reconcileQueueAfterItemAction,
    "function",
    "queue must expose canonical action reconciliation",
  );
  const initialQueue = [
    {
      id: ownerItem.id,
      workspaceId: workspaces.Alpha,
      title: ownerItem.title,
      status: "OPEN" as const,
      claimedById: users.Alice,
      claimedAt: "2026-08-03T08:00:00.000Z",
      createdAt: ownerItem.createdAt,
      claimedBy: { id: users.Alice, name: "Alice" },
    },
    {
      id: memberItem.id,
      workspaceId: workspaces.Alpha,
      title: memberItem.title,
      status: "OPEN" as const,
      claimedById: users.Bob,
      claimedAt: "2026-08-03T08:01:00.000Z",
      createdAt: memberItem.createdAt,
      claimedBy: { id: users.Bob, name: "Bob" },
    },
  ];
  const resolvedQueue = queueModule.reconcileQueueAfterItemAction(
    initialQueue,
    {
      ...initialQueue[0],
      status: "RESOLVED",
      claimedById: null,
      claimedAt: null,
      claimedBy: null,
    },
  );
  assert.deepEqual(resolvedQueue, [initialQueue[1]]);

  const canonicalOpenItem = {
    ...initialQueue[0],
    claimedById: users.Bob,
    claimedAt: "2026-08-03T08:02:00.000Z",
    claimedBy: { id: users.Bob, name: "Bob" },
  };
  assert.deepEqual(
    queueModule.reconcileQueueAfterItemAction(
      initialQueue,
      canonicalOpenItem,
    ),
    [canonicalOpenItem, initialQueue[1]],
  );

  console.log(
    "R3 verification passed for resolve authorization, atomic delivery records, canonical one-attempt dispatch, duplicate no-op behavior, safe failures, and fixture restoration.",
  );
} finally {
  if (clientConnected && originalItemStates.length > 0) {
    await client.query("BEGIN");

    try {
      await client.query(
        `DELETE FROM "NotificationDelivery" WHERE "itemId" = ANY($1::uuid[])`,
        [touchedItemIds],
      );

      for (const item of originalItemStates) {
        await client.query(
          `
            UPDATE "Item"
            SET
              "status" = $2::"ItemStatus",
              "claimedById" = $3::uuid,
              "claimedAt" = $4::timestamptz,
              "resolvedById" = $5::uuid,
              "resolvedAt" = $6::timestamptz
            WHERE "id" = $1::uuid
          `,
          [
            item.id,
            item.status,
            item.claimedById,
            item.claimedAt,
            item.resolvedById,
            item.resolvedAt,
          ],
        );
      }

      for (const delivery of originalDeliveryStates) {
        await client.query(
          `
            INSERT INTO "NotificationDelivery" (
              "id",
              "itemId",
              "workspaceId",
              "resolvedById",
              "status",
              "createdAt",
              "processingAt",
              "finishedAt",
              "error"
            )
            VALUES (
              $1::uuid,
              $2::uuid,
              $3::uuid,
              $4::uuid,
              $5::"NotificationDeliveryStatus",
              $6::timestamptz,
              $7::timestamptz,
              $8::timestamptz,
              $9::varchar(160)
            )
          `,
          [
            delivery.id,
            delivery.itemId,
            delivery.workspaceId,
            delivery.resolvedById,
            delivery.status,
            delivery.createdAt,
            delivery.processingAt,
            delivery.finishedAt,
            delivery.error,
          ],
        );
      }

      await client.query("COMMIT");
    } catch {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error("Failed to restore R3 verification fixtures.");
      process.exitCode = 1;
    }
  }

  if (clientConnected) {
    await client.end();
  }
}
