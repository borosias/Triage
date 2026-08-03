import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { Client } from "pg";

const envFile = [".env.local", ".env"].find(existsSync);

if (envFile) {
  loadEnvFile(envFile);
}

const connectionString = process.env.DIRECT_URL;

if (!connectionString) {
  throw new Error("DIRECT_URL must be configured before verifying R5.");
}

const baseUrl = process.env.R5_VERIFY_BASE_URL ?? "http://127.0.0.1:3000";
const users = {
  Alice: "00000000-0000-4000-8000-000000000001",
  Bob: "00000000-0000-4000-8000-000000000002",
  Carol: "00000000-0000-4000-8000-000000000003",
  Dana: "00000000-0000-4000-8000-000000000004",
} as const;

type UserName = keyof typeof users;
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
type QueueResponse = {
  items: QueueItem[];
  nextCursor: string | null;
};
type ItemActionResponse = {
  error?: string;
  item?: QueueItem;
};
type DatabaseItem = {
  id: string;
  workspaceId: string;
  status: "OPEN" | "RESOLVED";
  claimedById: string | null;
  claimedAt: Date | null;
};

const client = new Client({ connectionString });
const fixtureWorkspaceIds: string[] = [];
let clientConnected = false;

function request(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, { ...init, redirect: "manual" });
}

async function readJson<T>(response: Response) {
  assert.equal(
    response.headers.get("content-type")?.startsWith("application/json"),
    true,
  );

  return response.json() as Promise<T>;
}

async function login(name: UserName) {
  const response = await request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: users[name] }),
  });

  assert.equal(response.status, 200, `${name} login must return 200`);

  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, `${name} login must set a cookie`);

  return setCookie.split(";", 1)[0];
}

async function createFixtureWorkspace(label: string, itemCount: number) {
  const workspaceId = randomUUID();
  const itemIds = Array.from({ length: itemCount }, () => randomUUID());
  fixtureWorkspaceIds.push(workspaceId);

  await client.query("BEGIN");

  try {
    await client.query(
      `
        INSERT INTO "Workspace" ("id", "name")
        VALUES ($1::uuid, $2)
      `,
      [workspaceId, `R5 ${label}`],
    );
    await client.query(
      `
        INSERT INTO "WorkspaceMembership" ("workspaceId", "userId", "role")
        VALUES
          ($1::uuid, $2::uuid, 'OWNER'::"WorkspaceRole"),
          ($1::uuid, $3::uuid, 'MEMBER'::"WorkspaceRole"),
          ($1::uuid, $4::uuid, 'VIEWER'::"WorkspaceRole")
      `,
      [workspaceId, users.Alice, users.Bob, users.Carol],
    );
    await client.query(
      `
        INSERT INTO "Item" ("id", "workspaceId", "title", "createdAt")
        SELECT
          fixture."id",
          $1::uuid,
          'R5 fixture ' || fixture."position"::text,
          CURRENT_TIMESTAMP - fixture."position" * INTERVAL '1 second'
        FROM unnest($2::uuid[]) WITH ORDINALITY
          AS fixture("id", "position")
      `,
      [workspaceId, itemIds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return { workspaceId, itemIds };
}

async function setClaim(
  workspaceId: string,
  itemId: string,
  userId: string,
  age: string,
) {
  const result = await client.query(
    `
      UPDATE "Item"
      SET
        "status" = 'OPEN'::"ItemStatus",
        "claimedById" = $3::uuid,
        "claimedAt" = CURRENT_TIMESTAMP - $4::interval,
        "resolvedById" = NULL,
        "resolvedAt" = NULL
      WHERE "id" = $1::uuid
        AND "workspaceId" = $2::uuid
    `,
    [itemId, workspaceId, userId, age],
  );

  assert.equal(result.rowCount, 1);
}

async function readDatabaseItem(workspaceId: string, itemId: string) {
  const { rows } = await client.query<DatabaseItem>(
    `
      SELECT
        "id"::text AS "id",
        "workspaceId"::text AS "workspaceId",
        "status"::text AS "status",
        "claimedById"::text AS "claimedById",
        "claimedAt" AS "claimedAt"
      FROM "Item"
      WHERE "id" = $1::uuid
        AND "workspaceId" = $2::uuid
    `,
    [itemId, workspaceId],
  );

  assert.equal(rows.length, 1);
  return rows[0];
}

async function readQueue(cookie: string, workspaceId: string) {
  const response = await request(`/api/workspaces/${workspaceId}/items`, {
    headers: { cookie },
  });

  assert.equal(response.status, 200);
  return readJson<QueueResponse>(response);
}

async function postItemAction(
  cookie: string,
  workspaceId: string,
  itemId: string,
  action: "claim" | "resolve",
) {
  const response = await request(
    `/api/workspaces/${workspaceId}/items/${itemId}/${action}`,
    { method: "POST", headers: { cookie } },
  );

  return {
    status: response.status,
    body: await readJson<ItemActionResponse>(response),
  };
}

try {
  await client.connect();
  clientConnected = true;

  const [aliceCookie, bobCookie, carolCookie, danaCookie] = await Promise.all([
    login("Alice"),
    login("Bob"),
    login("Carol"),
    login("Dana"),
  ]);
  const coreFixture = await createFixtureWorkspace("core", 4);
  const [staleItemId, freshItemId, lateResolveItemId, reclaimItemId] =
    coreFixture.itemIds;

  await setClaim(
    coreFixture.workspaceId,
    staleItemId,
    users.Alice,
    "31 minutes",
  );
  const staleQueue = await readQueue(carolCookie, coreFixture.workspaceId);
  const staleHttpItem = staleQueue.items.find((item) => item.id === staleItemId);
  assert.ok(staleHttpItem);
  assert.equal(staleHttpItem.claimedById, null);
  assert.equal(staleHttpItem.claimedAt, null);
  assert.equal(staleHttpItem.claimedBy, null);
  const staleDatabaseItem = await readDatabaseItem(
    coreFixture.workspaceId,
    staleItemId,
  );
  assert.equal(staleDatabaseItem.claimedById, null);
  assert.equal(staleDatabaseItem.claimedAt, null);

  await setClaim(
    coreFixture.workspaceId,
    freshItemId,
    users.Alice,
    "29 minutes",
  );
  const freshQueue = await readQueue(aliceCookie, coreFixture.workspaceId);
  const freshHttpItem = freshQueue.items.find((item) => item.id === freshItemId);
  assert.ok(freshHttpItem);
  assert.equal(freshHttpItem.claimedById, users.Alice);
  assert.deepEqual(freshHttpItem.claimedBy, {
    id: users.Alice,
    name: "Alice",
  });
  assert.equal(typeof freshHttpItem.claimedAt, "string");
  const freshDatabaseItem = await readDatabaseItem(
    coreFixture.workspaceId,
    freshItemId,
  );
  assert.equal(freshDatabaseItem.claimedById, users.Alice);
  assert.ok(freshDatabaseItem.claimedAt instanceof Date);

  await setClaim(
    coreFixture.workspaceId,
    lateResolveItemId,
    users.Alice,
    "31 minutes",
  );
  const lateResolve = await postItemAction(
    aliceCookie,
    coreFixture.workspaceId,
    lateResolveItemId,
    "resolve",
  );
  assert.equal(lateResolve.status, 409);
  assert.ok(lateResolve.body.item);
  assert.equal(lateResolve.body.item.status, "OPEN");
  assert.equal(lateResolve.body.item.claimedById, null);
  assert.equal(lateResolve.body.item.claimedAt, null);
  assert.equal(lateResolve.body.item.claimedBy, null);
  const lateResolveDatabaseItem = await readDatabaseItem(
    coreFixture.workspaceId,
    lateResolveItemId,
  );
  assert.equal(lateResolveDatabaseItem.status, "OPEN");
  assert.equal(lateResolveDatabaseItem.claimedById, null);
  assert.equal(lateResolveDatabaseItem.claimedAt, null);
  const deliveryCount = await client.query<{ count: string }>(
    `
      SELECT count(*)::text AS "count"
      FROM "NotificationDelivery"
      WHERE "itemId" = $1::uuid
    `,
    [lateResolveItemId],
  );
  assert.equal(deliveryCount.rows[0].count, "0");

  await setClaim(
    coreFixture.workspaceId,
    reclaimItemId,
    users.Carol,
    "31 minutes",
  );
  const reclaimResults = await Promise.all([
    postItemAction(
      aliceCookie,
      coreFixture.workspaceId,
      reclaimItemId,
      "claim",
    ).then((result) => ({ name: "Alice" as const, ...result })),
    postItemAction(
      bobCookie,
      coreFixture.workspaceId,
      reclaimItemId,
      "claim",
    ).then((result) => ({ name: "Bob" as const, ...result })),
  ]);
  assert.deepEqual(
    reclaimResults
      .map((result) => result.status)
      .sort((left, right) => left - right),
    [200, 409],
  );
  const reclaimWinner = reclaimResults.find((result) => result.status === 200);
  const reclaimLoser = reclaimResults.find((result) => result.status === 409);
  assert.ok(reclaimWinner);
  assert.ok(reclaimLoser);
  assert.ok(reclaimWinner.body.item);
  assert.ok(reclaimLoser.body.item);
  assert.equal(
    reclaimWinner.body.item.claimedById,
    users[reclaimWinner.name],
  );
  assert.deepEqual(reclaimLoser.body.item.claimedBy, {
    id: users[reclaimWinner.name],
    name: reclaimWinner.name,
  });
  const reclaimDatabaseItem = await readDatabaseItem(
    coreFixture.workspaceId,
    reclaimItemId,
  );
  assert.equal(reclaimDatabaseItem.claimedById, users[reclaimWinner.name]);
  assert.ok(reclaimDatabaseItem.claimedAt instanceof Date);

  const isolationFixture = await createFixtureWorkspace("isolation", 1);
  const isolationItemId = isolationFixture.itemIds[0];
  await setClaim(
    isolationFixture.workspaceId,
    isolationItemId,
    users.Alice,
    "31 minutes",
  );

  const outsiderQueueResponse = await request(
    `/api/workspaces/${isolationFixture.workspaceId}/items`,
    { headers: { cookie: danaCookie } },
  );
  assert.equal(outsiderQueueResponse.status, 404);
  await readJson<{ error: string }>(outsiderQueueResponse);
  let isolatedDatabaseItem = await readDatabaseItem(
    isolationFixture.workspaceId,
    isolationItemId,
  );
  assert.equal(isolatedDatabaseItem.claimedById, users.Alice);
  assert.ok(isolatedDatabaseItem.claimedAt instanceof Date);

  const outsiderClaim = await postItemAction(
    danaCookie,
    isolationFixture.workspaceId,
    isolationItemId,
    "claim",
  );
  assert.equal(outsiderClaim.status, 404);
  assert.equal(outsiderClaim.body.item, undefined);
  isolatedDatabaseItem = await readDatabaseItem(
    isolationFixture.workspaceId,
    isolationItemId,
  );
  assert.equal(isolatedDatabaseItem.claimedById, users.Alice);
  assert.ok(isolatedDatabaseItem.claimedAt instanceof Date);

  console.log(
    "R5 verification passed for stale/fresh cutoff, physical lazy cleanup, late resolve without notification, concurrent reclaim, and read/mutation authorization isolation.",
  );
} finally {
  if (clientConnected && fixtureWorkspaceIds.length > 0) {
    try {
      await client.query(
        `DELETE FROM "Workspace" WHERE "id" = ANY($1::uuid[])`,
        [fixtureWorkspaceIds],
      );
    } catch (error) {
      console.error("Failed to remove R5 verification fixtures.", error);
      process.exitCode = 1;
    }
  }

  if (clientConnected) {
    await client.end();
  }
}
