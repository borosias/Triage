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
  throw new Error("DIRECT_URL must be configured before verifying R2.");
}

const baseUrl = process.env.R2_VERIFY_BASE_URL ?? "http://127.0.0.1:3000";

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
  const body = await response.json();
  assert.equal(
    response.headers.get("content-type")?.startsWith("application/json"),
    true,
    "response must be JSON",
  );
  return body;
}

async function verifyErrorResponse(response) {
  const body = await readJson(response);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
}

async function verifyWorkspaceList(name, expectedWorkspaces) {
  const cookie = await login(name);
  const response = await request("/api/workspaces", {
    headers: { cookie },
  });

  assert.equal(response.status, 200, `${name} workspace list must return 200`);
  assert.deepEqual(await readJson(response), {
    workspaces: expectedWorkspaces,
  });

  return cookie;
}

async function verifyQueue(cookie, workspaceName, expectedStatus) {
  const workspaceId = workspaces[workspaceName];
  const response = await request(`/api/workspaces/${workspaceId}/items`, {
    headers: { cookie },
  });

  assert.equal(
    response.status,
    expectedStatus,
    `${workspaceName} queue must return ${expectedStatus}`,
  );

  if (expectedStatus !== 200) {
    await verifyErrorResponse(response);
    return [];
  }

  const body = await readJson(response);
  assert.deepEqual(Object.keys(body).sort(), ["items", "nextCursor"]);
  assert.ok(Array.isArray(body.items), "queue response must contain items");
  assert.ok(
    body.nextCursor === null || typeof body.nextCursor === "string",
    "queue response must contain an opaque next cursor or null",
  );
  assert.ok(
    body.items.length <= 50,
    "queue response must contain at most 50 items",
  );

  for (const item of body.items) {
    assert.equal(item.workspaceId, workspaceId);
    assert.equal(item.status, "OPEN");
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.title, "string");
    assert.equal(typeof item.createdAt, "string");
    assert.ok(item.claimedById === null || typeof item.claimedById === "string");
    assert.ok(item.claimedAt === null || typeof item.claimedAt === "string");
    assert.ok(
      item.claimedBy === null ||
        (typeof item.claimedBy.id === "string" &&
          typeof item.claimedBy.name === "string"),
    );
  }

  return body.items;
}

async function claim(cookie, workspaceId, itemId) {
  return request(`/api/workspaces/${workspaceId}/items/${itemId}/claim`, {
    method: "POST",
    headers: { cookie },
  });
}

async function verifyClaimSuccess(response, expectedItemId, expectedUserName) {
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.item.id, expectedItemId);
  assert.equal(body.item.status, "OPEN");
  assert.equal(body.item.claimedBy.id, users[expectedUserName]);
  assert.equal(body.item.claimedBy.name, expectedUserName);
  assert.equal(body.item.claimedById, users[expectedUserName]);
  assert.equal(typeof body.item.claimedAt, "string");
}

async function verifyClaimError(response, expectedStatus) {
  assert.equal(response.status, expectedStatus);
  await verifyErrorResponse(response);
}

const client = new Client({ connectionString });
let originalItemStates = [];
let clientConnected = false;

try {
  const unauthenticatedResponse = await request("/api/workspaces");
  assert.equal(unauthenticatedResponse.status, 401);
  await verifyErrorResponse(unauthenticatedResponse);

  const aliceCookie = await verifyWorkspaceList("Alice", [
    { id: workspaces.Alpha, name: "Alpha", role: "OWNER" },
    { id: workspaces.Beta, name: "Beta", role: "MEMBER" },
  ]);
  const alphaItems = await verifyQueue(aliceCookie, "Alpha", 200);
  const betaItems = await verifyQueue(aliceCookie, "Beta", 200);

  const bobCookie = await verifyWorkspaceList("Bob", [
    { id: workspaces.Alpha, name: "Alpha", role: "MEMBER" },
    { id: workspaces.Beta, name: "Beta", role: "OWNER" },
  ]);

  const carolCookie = await verifyWorkspaceList("Carol", [
    { id: workspaces.Alpha, name: "Alpha", role: "VIEWER" },
  ]);
  await verifyQueue(carolCookie, "Alpha", 200);
  await verifyQueue(carolCookie, "Beta", 404);

  const danaCookie = await verifyWorkspaceList("Dana", [
    { id: workspaces.Beta, name: "Beta", role: "VIEWER" },
  ]);
  await verifyQueue(danaCookie, "Beta", 200);
  await verifyQueue(danaCookie, "Alpha", 404);

  const malformedResponse = await request(
    "/api/workspaces/not-a-uuid/items",
    { headers: { cookie: aliceCookie } },
  );
  assert.equal(malformedResponse.status, 400);
  await verifyErrorResponse(malformedResponse);

  assert.ok(alphaItems.length >= 5, "Alpha queue must expose five test items");
  assert.ok(betaItems.length >= 1, "Beta queue must expose one test item");

  const [ownerItem, memberItem, viewerItem, outsiderItem, alphaForeignItem] =
    alphaItems;
  const [betaForeignItem] = betaItems;
  const testItemIds = [
    ownerItem.id,
    memberItem.id,
    viewerItem.id,
    outsiderItem.id,
    alphaForeignItem.id,
    betaForeignItem.id,
  ];

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

  const resetResult = await client.query(
    `
      UPDATE "Item"
      SET "claimedById" = NULL, "claimedAt" = NULL
      WHERE "id" = ANY($1::uuid[])
        AND "status" = 'OPEN'
    `,
    [testItemIds],
  );
  assert.equal(resetResult.rowCount, testItemIds.length);

  await verifyClaimSuccess(
    await claim(aliceCookie, workspaces.Alpha, ownerItem.id),
    ownerItem.id,
    "Alice",
  );
  await verifyClaimSuccess(
    await claim(bobCookie, workspaces.Alpha, memberItem.id),
    memberItem.id,
    "Bob",
  );
  await verifyClaimError(
    await claim(carolCookie, workspaces.Alpha, viewerItem.id),
    403,
  );
  await verifyClaimError(
    await claim(danaCookie, workspaces.Alpha, outsiderItem.id),
    404,
  );
  await verifyClaimError(
    await claim(aliceCookie, workspaces.Alpha, betaForeignItem.id),
    404,
  );
  await verifyClaimError(
    await claim(aliceCookie, workspaces.Beta, alphaForeignItem.id),
    404,
  );

  const malformedItemResponse = await claim(
    aliceCookie,
    workspaces.Alpha,
    "not-a-uuid",
  );
  await verifyClaimError(malformedItemResponse, 400);

  const malformedWorkspaceResponse = await claim(
    aliceCookie,
    "not-a-uuid",
    viewerItem.id,
  );
  await verifyClaimError(malformedWorkspaceResponse, 400);

  const unauthenticatedClaimResponse = await claim(
    undefined,
    workspaces.Alpha,
    viewerItem.id,
  );
  await verifyClaimError(unauthenticatedClaimResponse, 401);

  const { rows: itemStates } = await client.query(
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
  const statesById = new Map(itemStates.map((item) => [item.id, item]));

  assert.equal(statesById.get(ownerItem.id)?.claimedById, users.Alice);
  assert.ok(statesById.get(ownerItem.id)?.claimedAt instanceof Date);
  assert.equal(statesById.get(memberItem.id)?.claimedById, users.Bob);
  assert.ok(statesById.get(memberItem.id)?.claimedAt instanceof Date);

  for (const item of [
    viewerItem,
    outsiderItem,
    alphaForeignItem,
    betaForeignItem,
  ]) {
    assert.equal(statesById.get(item.id)?.claimedById, null);
    assert.equal(statesById.get(item.id)?.claimedAt, null);
  }

  assert.equal(
    statesById.get(alphaForeignItem.id)?.workspaceId,
    workspaces.Alpha,
  );
  assert.equal(
    statesById.get(betaForeignItem.id)?.workspaceId,
    workspaces.Beta,
  );

  console.log("R2 read and adversarial claim verification passed.");
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

      console.error("Failed to restore R2 verification fixtures.", error);
      process.exitCode = 1;
    }
  }

  await client.end();
}
