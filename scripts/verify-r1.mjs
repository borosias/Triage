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
  throw new Error("DIRECT_URL must be configured before verifying R1.");
}

const baseUrl = process.env.R1_VERIFY_BASE_URL ?? "http://127.0.0.1:3000";
const workspaceId = "10000000-0000-4000-8000-000000000001";
const users = {
  Alice: "00000000-0000-4000-8000-000000000001",
  Bob: "00000000-0000-4000-8000-000000000002",
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

async function claim(cookie, itemId) {
  return request(`/api/workspaces/${workspaceId}/items/${itemId}/claim`, {
    method: "POST",
    headers: { cookie },
  });
}

async function readJson(response) {
  assert.equal(
    response.headers.get("content-type")?.startsWith("application/json"),
    true,
    "response must be JSON",
  );
  return response.json();
}

const client = new Client({ connectionString });
let testItemId;
let clientConnected = false;

try {
  const [aliceCookie, bobCookie] = await Promise.all([
    login("Alice"),
    login("Bob"),
  ]);
  const queueResponse = await request(`/api/workspaces/${workspaceId}/items`, {
    headers: { cookie: aliceCookie },
  });
  assert.equal(queueResponse.status, 200);
  const queueBody = await readJson(queueResponse);
  const testItem = queueBody.items.find((item) => item.claimedById === null);
  assert.ok(testItem, "Alpha queue must expose an unclaimed OPEN test item");
  testItemId = testItem.id;

  await client.connect();
  clientConnected = true;
  const resetResult = await client.query(
    `
      UPDATE "Item"
      SET "claimedById" = NULL, "claimedAt" = NULL
      WHERE "id" = $1::uuid
        AND "workspaceId" = $2::uuid
        AND "status" = 'OPEN'
      RETURNING "id"
    `,
    [testItemId, workspaceId],
  );
  assert.equal(resetResult.rowCount, 1);

  const [aliceResponse, bobResponse] = await Promise.all([
    claim(aliceCookie, testItemId),
    claim(bobCookie, testItemId),
  ]);
  const results = await Promise.all(
    [
      { name: "Alice", response: aliceResponse },
      { name: "Bob", response: bobResponse },
    ].map(async ({ name, response }) => ({
      name,
      status: response.status,
      body: await readJson(response),
    })),
  );

  assert.deepEqual(
    results.map((result) => result.status).sort((left, right) => left - right),
    [200, 409],
    "simultaneous claims must produce exactly one success and one conflict",
  );

  const winner = results.find((result) => result.status === 200);
  const loser = results.find((result) => result.status === 409);
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(winner.body.item.id, testItemId);
  assert.equal(winner.body.item.claimedById, users[winner.name]);
  assert.equal(winner.body.item.claimedBy.id, users[winner.name]);
  assert.equal(winner.body.item.claimedBy.name, winner.name);
  assert.equal(typeof winner.body.item.claimedAt, "string");
  assert.equal(loser.body.item.id, testItemId);
  assert.equal(loser.body.item.claimedById, users[winner.name]);
  assert.equal(loser.body.item.claimedBy.id, users[winner.name]);
  assert.equal(loser.body.item.claimedBy.name, winner.name);

  const { rows: [canonicalItem] } = await client.query(
    `
      SELECT
        item."id"::text AS "id",
        item."workspaceId"::text AS "workspaceId",
        item."status"::text AS "status",
        item."claimedById"::text AS "claimedById",
        item."claimedAt" AS "claimedAt",
        claimant."name" AS "claimantName"
      FROM "Item" AS item
      LEFT JOIN "User" AS claimant ON claimant."id" = item."claimedById"
      WHERE item."id" = $1::uuid
        AND item."workspaceId" = $2::uuid
    `,
    [testItemId, workspaceId],
  );
  assert.equal(canonicalItem.id, testItemId);
  assert.equal(canonicalItem.workspaceId, workspaceId);
  assert.equal(canonicalItem.status, "OPEN");
  assert.equal(canonicalItem.claimedById, users[winner.name]);
  assert.equal(canonicalItem.claimantName, winner.name);
  assert.ok(canonicalItem.claimedAt instanceof Date);

  const winnerCookie = winner.name === "Alice" ? aliceCookie : bobCookie;
  const repeatResponse = await claim(winnerCookie, testItemId);
  assert.equal(repeatResponse.status, 409);
  const repeatBody = await readJson(repeatResponse);
  assert.equal(repeatBody.item.claimedById, users[winner.name]);
  assert.equal(repeatBody.item.claimedBy.name, winner.name);

  console.log(
    `R1 concurrency verification passed: ${winner.name} won, ${loser.name} received 409, and PostgreSQL matched the winner.`,
  );
} finally {
  if (testItemId) {
    await client.query(
      `
        UPDATE "Item"
        SET "claimedById" = NULL, "claimedAt" = NULL
        WHERE "id" = $1::uuid
          AND "workspaceId" = $2::uuid
      `,
      [testItemId, workspaceId],
    );
  }

  if (clientConnected) {
    await client.end();
  }
}
