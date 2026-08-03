import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { Client } from "pg";

const envFile = [".env.local", ".env"].find(existsSync);

if (envFile) {
  loadEnvFile(envFile);
}

const connectionString = process.env.DIRECT_URL;

if (!connectionString) {
  throw new Error("DIRECT_URL must be configured before verifying release.");
}

const baseUrl =
  process.env.RELEASE_VERIFY_BASE_URL ?? "http://127.0.0.1:3000";

const users = {
  Alice: "00000000-0000-4000-8000-000000000001",
  Bob: "00000000-0000-4000-8000-000000000002",
  Carol: "00000000-0000-4000-8000-000000000003",
  Dana: "00000000-0000-4000-8000-000000000004",
};

const workspaces = {
  Alpha: "10000000-0000-4000-8000-000000000001",
  Beta: "10000000-0000-4000-8000-000000000002",
};

async function request(path, init) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    redirect: "manual",
  });
}

async function login(name) {
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

async function readJson(response) {
  assert.equal(
    response.headers.get("content-type")?.startsWith("application/json"),
    true,
    "response must be JSON",
  );
  return response.json();
}

async function loadQueue(cookie, workspaceId) {
  const response = await request(`/api/workspaces/${workspaceId}/items`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.ok(Array.isArray(body.items));
  return body.items;
}

async function release(cookie, workspaceId, itemId) {
  return request(
    `/api/workspaces/${workspaceId}/items/${itemId}/release`,
    {
      method: "POST",
      headers: cookie ? { cookie } : undefined,
    },
  );
}

async function verifyError(response, expectedStatus) {
  assert.equal(response.status, expectedStatus);
  const body = await readJson(response);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
}

async function verifyReleased(response, expectedItemId) {
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.item.id, expectedItemId);
  assert.equal(body.item.status, "OPEN");
  assert.equal(body.item.claimedById, null);
  assert.equal(body.item.claimedAt, null);
  assert.equal(body.item.claimedBy, null);
}

const client = new Client({ connectionString });
let originalItemStates = [];
let fixtureItemStates = [];
let clientConnected = false;

try {
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

  assert.ok(alphaItems.length >= 6, "Alpha queue must expose six test items");
  assert.ok(betaItems.length >= 1, "Beta queue must expose one test item");

  const [
    ownerItem,
    memberItem,
    viewerItem,
    outsiderItem,
    otherUserItem,
    alphaForeignItem,
  ] = alphaItems;
  const [betaForeignItem] = betaItems;
  const testItemIds = [
    ownerItem.id,
    memberItem.id,
    viewerItem.id,
    outsiderItem.id,
    otherUserItem.id,
    alphaForeignItem.id,
    betaForeignItem.id,
  ];

  await verifyError(
    await release(undefined, "not-a-uuid", ownerItem.id),
    400,
  );
  await verifyError(
    await release(undefined, workspaces.Alpha, "not-a-uuid"),
    400,
  );
  await verifyError(
    await release(undefined, workspaces.Alpha, ownerItem.id),
    401,
  );

  await client.connect();
  clientConnected = true;

  const { rows: initialItemStates } = await client.query(
    `
      SELECT
        "id"::text AS "id",
        "claimedById"::text AS "claimedById",
        "claimedAt" AS "claimedAt"
      FROM "Item"
      WHERE "id" = ANY($1::uuid[])
    `,
    [testItemIds],
  );
  originalItemStates = initialItemStates;
  assert.equal(originalItemStates.length, testItemIds.length);

  const fixtureClaims = [
    [ownerItem.id, users.Alice],
    [memberItem.id, users.Bob],
    [viewerItem.id, users.Carol],
    [outsiderItem.id, users.Dana],
    [otherUserItem.id, users.Bob],
    [alphaForeignItem.id, users.Alice],
    [betaForeignItem.id, users.Alice],
  ];

  for (const [itemId, userId] of fixtureClaims) {
    const result = await client.query(
      `
        UPDATE "Item"
        SET "claimedById" = $2::uuid, "claimedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1::uuid
          AND "status" = 'OPEN'
      `,
      [itemId, userId],
    );
    assert.equal(result.rowCount, 1);
  }

  const { rows: preparedItemStates } = await client.query(
    `
      SELECT
        "id"::text AS "id",
        "workspaceId"::text AS "workspaceId",
        "claimedById"::text AS "claimedById",
        "claimedAt" AS "claimedAt"
      FROM "Item"
      WHERE "id" = ANY($1::uuid[])
    `,
    [testItemIds],
  );
  fixtureItemStates = preparedItemStates;

  await verifyReleased(
    await release(aliceCookie, workspaces.Alpha, ownerItem.id),
    ownerItem.id,
  );
  await verifyReleased(
    await release(bobCookie, workspaces.Alpha, memberItem.id),
    memberItem.id,
  );

  await verifyError(
    await release(carolCookie, workspaces.Alpha, viewerItem.id),
    403,
  );
  await verifyError(
    await release(danaCookie, workspaces.Alpha, outsiderItem.id),
    404,
  );

  const otherUserResponse = await release(
    aliceCookie,
    workspaces.Alpha,
    otherUserItem.id,
  );
  assert.equal(otherUserResponse.status, 409);
  const otherUserBody = await readJson(otherUserResponse);
  assert.equal(otherUserBody.item.id, otherUserItem.id);
  assert.equal(otherUserBody.item.claimedById, users.Bob);
  assert.equal(otherUserBody.item.claimedBy.id, users.Bob);
  assert.equal(otherUserBody.item.claimedBy.name, "Bob");

  await verifyError(
    await release(aliceCookie, workspaces.Beta, alphaForeignItem.id),
    404,
  );
  await verifyError(
    await release(aliceCookie, workspaces.Alpha, betaForeignItem.id),
    404,
  );

  const repeatedResponse = await release(
    aliceCookie,
    workspaces.Alpha,
    ownerItem.id,
  );
  assert.equal(repeatedResponse.status, 409);
  const repeatedBody = await readJson(repeatedResponse);
  assert.equal(repeatedBody.item.id, ownerItem.id);
  assert.equal(repeatedBody.item.claimedById, null);
  assert.equal(repeatedBody.item.claimedAt, null);
  assert.equal(repeatedBody.item.claimedBy, null);

  const { rows: finalItemStates } = await client.query(
    `
      SELECT
        "id"::text AS "id",
        "workspaceId"::text AS "workspaceId",
        "claimedById"::text AS "claimedById",
        "claimedAt" AS "claimedAt"
      FROM "Item"
      WHERE "id" = ANY($1::uuid[])
    `,
    [testItemIds],
  );
  const finalStatesById = new Map(
    finalItemStates.map((item) => [item.id, item]),
  );
  const fixtureStatesById = new Map(
    fixtureItemStates.map((item) => [item.id, item]),
  );

  for (const releasedItem of [ownerItem, memberItem]) {
    const state = finalStatesById.get(releasedItem.id);
    assert.equal(state?.claimedById, null);
    assert.equal(state?.claimedAt, null);
  }

  for (const unchangedItem of [
    viewerItem,
    outsiderItem,
    otherUserItem,
    alphaForeignItem,
    betaForeignItem,
  ]) {
    const finalState = finalStatesById.get(unchangedItem.id);
    const fixtureState = fixtureStatesById.get(unchangedItem.id);
    assert.equal(finalState?.workspaceId, fixtureState?.workspaceId);
    assert.equal(finalState?.claimedById, fixtureState?.claimedById);
    assert.equal(
      finalState?.claimedAt?.getTime(),
      fixtureState?.claimedAt?.getTime(),
    );
  }

  console.log(
    "Atomic release verification passed for authorization, ownership, isolation, repeated release, canonical state, and fixture restoration.",
  );
} finally {
  if (clientConnected && originalItemStates.length > 0) {
    await client.query("BEGIN");

    try {
      for (const item of originalItemStates) {
        await client.query(
          `
            UPDATE "Item"
            SET "claimedById" = $2::uuid, "claimedAt" = $3::timestamptz
            WHERE "id" = $1::uuid
          `,
          [item.id, item.claimedById, item.claimedAt],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error("Failed to restore release verification fixtures.", error);
      process.exitCode = 1;
    }
  }

  if (clientConnected) {
    await client.end();
  }
}
