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
  throw new Error("DIRECT_URL must be configured before verifying R4.");
}

const baseUrl = process.env.R4_VERIFY_BASE_URL ?? "http://127.0.0.1:3000";
const users = {
  Alice: "00000000-0000-4000-8000-000000000001",
  Bob: "00000000-0000-4000-8000-000000000002",
  Carol: "00000000-0000-4000-8000-000000000003",
  Dana: "00000000-0000-4000-8000-000000000004",
} as const;
const exactTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

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
type QueuePage = {
  items: QueueItem[];
  nextCursor: string | null;
};
type ExpectedItem = {
  id: string;
  createdAtExact: string;
};

const client = new Client({ connectionString });
const fixtureWorkspaceIds: string[] = [];
let clientConnected = false;

function request(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, { ...init, redirect: "manual" });
}

async function readJson(response: Response) {
  assert.equal(
    response.headers.get("content-type")?.startsWith("application/json"),
    true,
  );

  return response.json();
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

function timestampForPosition(position: number) {
  if (position === 49) {
    return "2030-01-01T00:09:00.123789Z";
  }

  if (position === 50) {
    return "2030-01-01T00:09:00.123456Z";
  }

  const milliseconds =
    position < 49
      ? Date.UTC(2030, 0, 1, 0, 10, 0) - position * 1000
      : Date.UTC(2030, 0, 1, 0, 8, 59) - (position - 51) * 1000;

  return new Date(milliseconds).toISOString().replace(".000Z", ".000000Z");
}

async function createFixture(label: string) {
  const workspaceId = randomUUID();
  const itemPrefix = randomUUID().slice(0, 8);
  const itemIds = Array.from(
    { length: 120 },
    (_, position) =>
      `${itemPrefix}-0000-4000-8000-${position.toString(16).padStart(12, "0")}`,
  );
  const titles = itemIds.map(
    (_, position) => `R4 ${label} item ${position.toString().padStart(3, "0")}`,
  );
  const timestamps = itemIds.map((_, position) =>
    timestampForPosition(position),
  );

  await client.query("BEGIN");

  try {
    await client.query(
      `
        INSERT INTO "Workspace" ("id", "name")
        VALUES ($1::uuid, $2)
      `,
      [workspaceId, `R4 ${label}`],
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
        SELECT fixture."id", $1::uuid, fixture."title", fixture."createdAt"
        FROM unnest($2::uuid[], $3::text[], $4::timestamptz[])
          AS fixture("id", "title", "createdAt")
      `,
      [workspaceId, itemIds, titles, timestamps],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  fixtureWorkspaceIds.push(workspaceId);
  return workspaceId;
}

async function readExpectedItems(workspaceId: string) {
  const { rows } = await client.query<ExpectedItem>(
    `
      SELECT
        "id"::text AS "id",
        to_char(
          "createdAt" AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ) AS "createdAtExact"
      FROM "Item"
      WHERE "workspaceId" = $1::uuid
        AND "status" = 'OPEN'::"ItemStatus"
      ORDER BY "createdAt" DESC, "id" DESC
    `,
    [workspaceId],
  );

  return rows;
}

function assertQueueItem(item: QueueItem, workspaceId: string) {
  assert.deepEqual(Object.keys(item).sort(), [
    "claimedAt",
    "claimedBy",
    "claimedById",
    "createdAt",
    "id",
    "status",
    "title",
    "workspaceId",
  ]);
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

async function readPage(
  cookie: string,
  workspaceId: string,
  cursor?: string,
) {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  const response = await request(
    `/api/workspaces/${workspaceId}/items${query}`,
    { headers: { cookie } },
  );

  assert.equal(response.status, 200);

  const body = (await readJson(response)) as QueuePage;
  assert.deepEqual(Object.keys(body).sort(), ["items", "nextCursor"]);
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.length <= 50);
  assert.ok(body.nextCursor === null || typeof body.nextCursor === "string");

  for (const item of body.items) {
    assertQueueItem(item, workspaceId);
  }

  return body;
}

function decodeCursor(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    v: number;
    workspaceId: string;
    createdAt: string;
    id: string;
  };
}

function encodeCursor(payload: unknown) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

async function expectError(
  path: string,
  expectedStatus: number,
  cookie?: string,
) {
  const response = await request(path, {
    headers: cookie ? { cookie } : undefined,
  });
  assert.equal(response.status, expectedStatus, path);
  const body = (await readJson(response)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
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
  const body = (await readJson(response)) as {
    item?: QueueItem;
    error?: string;
  };

  assert.equal(response.status, 200, body.error);
  assert.ok(body.item);
  return body.item;
}

async function verifyFullTraversal(cookie: string, workspaceId: string) {
  const expected = await readExpectedItems(workspaceId);
  const seen = new Set<string>();
  let cursor: string | undefined;
  let expectedPosition = 0;
  let pageCount = 0;
  let firstPage: QueuePage | undefined;
  let secondPage: QueuePage | undefined;

  do {
    const page = await readPage(cookie, workspaceId, cursor);
    pageCount += 1;
    assert.ok(pageCount <= 10, "pagination must terminate");

    if (pageCount === 1) {
      firstPage = page;
    } else if (pageCount === 2) {
      secondPage = page;
    }

    for (const item of page.items) {
      assert.equal(seen.has(item.id), false, `repeated item ${item.id}`);
      seen.add(item.id);
      assert.equal(item.id, expected[expectedPosition]?.id);
      expectedPosition += 1;
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  assert.equal(expectedPosition, expected.length);
  assert.equal(seen.size, expected.length);
  assert.equal(firstPage?.items.length, 50);
  assert.equal(secondPage?.items.length, 50);
  assert.equal(firstPage?.items.at(-1)?.id, expected[49].id);
  assert.equal(secondPage?.items[0]?.id, expected[50].id);
  assert.equal(expected[49].createdAtExact, "2030-01-01T00:09:00.123789Z");
  assert.equal(expected[50].createdAtExact, "2030-01-01T00:09:00.123456Z");
  assert.ok(firstPage?.nextCursor);

  const cursorPayload = decodeCursor(firstPage.nextCursor);
  assert.deepEqual(cursorPayload, {
    v: 1,
    workspaceId,
    createdAt: expected[49].createdAtExact,
    id: expected[49].id,
  });
  assert.match(cursorPayload.createdAt, exactTimestampPattern);

  return { expected, firstPage };
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

  const traversalWorkspaceId = await createFixture("traversal");
  const { firstPage: traversalFirstPage } = await verifyFullTraversal(
    aliceCookie,
    traversalWorkspaceId,
  );

  assert.ok(traversalFirstPage.nextCursor);

  for (const cookie of [bobCookie, carolCookie]) {
    const firstPage = await readPage(cookie, traversalWorkspaceId);
    assert.ok(firstPage.nextCursor);
    const continuation = await readPage(
      cookie,
      traversalWorkspaceId,
      firstPage.nextCursor,
    );
    assert.equal(continuation.items.length, 50);
  }

  await expectError(
    `/api/workspaces/${traversalWorkspaceId}/items`,
    404,
    danaCookie,
  );
  await expectError("/api/workspaces/not-a-uuid/items", 400, aliceCookie);

  const validPayload = decodeCursor(traversalFirstPage.nextCursor);
  const malformedCursors = [
    "!!!",
    Buffer.from("not-json", "utf8").toString("base64url"),
    encodeCursor({ ...validPayload, v: 2 }),
    encodeCursor({
      ...validPayload,
      createdAt: "2030-13-01T00:00:00.000000Z",
    }),
    encodeCursor({ ...validPayload, id: "not-a-uuid" }),
    encodeCursor({ ...validPayload, workspaceId: "not-a-uuid" }),
    "a".repeat(1025),
  ];

  for (const malformedCursor of malformedCursors) {
    await expectError(
      `/api/workspaces/${traversalWorkspaceId}/items?cursor=${encodeURIComponent(malformedCursor)}`,
      400,
      aliceCookie,
    );
  }

  await expectError(
    `/api/workspaces/${traversalWorkspaceId}/items?cursor=${encodeURIComponent(traversalFirstPage.nextCursor)}&cursor=${encodeURIComponent(traversalFirstPage.nextCursor)}`,
    400,
    aliceCookie,
  );
  await expectError(
    `/api/workspaces/${traversalWorkspaceId}/items?cursor=!!!`,
    401,
  );
  await expectError(
    `/api/workspaces/${traversalWorkspaceId}/items?cursor=!!!`,
    404,
    danaCookie,
  );

  const otherWorkspaceId = await createFixture("cross-workspace");
  await expectError(
    `/api/workspaces/${otherWorkspaceId}/items?cursor=${encodeURIComponent(traversalFirstPage.nextCursor)}`,
    400,
    aliceCookie,
  );

  const offsetWorkspaceId = await createFixture("offset-mutation");
  const offsetExpected = await readExpectedItems(offsetWorkspaceId);
  const offsetFirstPage = await readPage(aliceCookie, offsetWorkspaceId);
  assert.ok(offsetFirstPage.nextCursor);
  await postItemAction(
    aliceCookie,
    offsetWorkspaceId,
    offsetExpected[10].id,
    "claim",
  );
  await postItemAction(
    aliceCookie,
    offsetWorkspaceId,
    offsetExpected[10].id,
    "resolve",
  );
  const { rows: naiveOffsetRows } = await client.query<{ id: string }>(
    `
      SELECT "id"::text AS "id"
      FROM "Item"
      WHERE "workspaceId" = $1::uuid
        AND "status" = 'OPEN'::"ItemStatus"
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 50 OFFSET 50
    `,
    [offsetWorkspaceId],
  );
  assert.equal(naiveOffsetRows[0].id, offsetExpected[51].id);
  assert.notEqual(naiveOffsetRows[0].id, offsetExpected[50].id);
  const offsetSecondPage = await readPage(
    aliceCookie,
    offsetWorkspaceId,
    offsetFirstPage.nextCursor,
  );
  assert.equal(offsetSecondPage.items[0].id, offsetExpected[50].id);
  for (const item of offsetSecondPage.items) {
    assert.equal(
      offsetFirstPage.items.some((firstPageItem) => firstPageItem.id === item.id),
      false,
    );
  }

  const claimWorkspaceId = await createFixture("concurrent-claim");
  const claimExpected = await readExpectedItems(claimWorkspaceId);
  const claimFirstPage = await readPage(aliceCookie, claimWorkspaceId);
  assert.ok(claimFirstPage.nextCursor);
  const claimedItem = await postItemAction(
    bobCookie,
    claimWorkspaceId,
    claimExpected[75].id,
    "claim",
  );
  assert.equal(claimedItem.claimedById, users.Bob);
  const claimSecondPage = await readPage(
    aliceCookie,
    claimWorkspaceId,
    claimFirstPage.nextCursor,
  );
  const claimedRows = claimSecondPage.items.filter(
    (item) => item.id === claimExpected[75].id,
  );
  assert.equal(claimedRows.length, 1);
  assert.deepEqual(claimedRows[0].claimedBy, {
    id: users.Bob,
    name: "Bob",
  });
  assert.equal(claimedRows[0].claimedById, users.Bob);

  const missingBoundaryWorkspaceId = await createFixture("missing-boundary");
  const missingBoundaryExpected = await readExpectedItems(
    missingBoundaryWorkspaceId,
  );
  const missingBoundaryFirstPage = await readPage(
    aliceCookie,
    missingBoundaryWorkspaceId,
  );
  assert.ok(missingBoundaryFirstPage.nextCursor);
  assert.equal(
    missingBoundaryFirstPage.items.at(-1)?.id,
    missingBoundaryExpected[49].id,
  );
  await postItemAction(
    aliceCookie,
    missingBoundaryWorkspaceId,
    missingBoundaryExpected[49].id,
    "claim",
  );
  await postItemAction(
    aliceCookie,
    missingBoundaryWorkspaceId,
    missingBoundaryExpected[49].id,
    "resolve",
  );
  const missingBoundarySecondPage = await readPage(
    aliceCookie,
    missingBoundaryWorkspaceId,
    missingBoundaryFirstPage.nextCursor,
  );
  assert.equal(
    missingBoundarySecondPage.items[0].id,
    missingBoundaryExpected[50].id,
  );

  const newRowWorkspaceId = await createFixture("new-row");
  const newRowFirstPage = await readPage(aliceCookie, newRowWorkspaceId);
  assert.ok(newRowFirstPage.nextCursor);
  const newItemId = randomUUID();
  await client.query(
    `
      INSERT INTO "Item" ("id", "workspaceId", "title", "createdAt")
      VALUES ($1::uuid, $2::uuid, 'R4 inserted ahead', TIMESTAMPTZ '2031-01-01 00:00:00.000000+00')
    `,
    [newItemId, newRowWorkspaceId],
  );
  const newRowSecondPage = await readPage(
    aliceCookie,
    newRowWorkspaceId,
    newRowFirstPage.nextCursor,
  );
  assert.equal(
    newRowSecondPage.items.some((item) => item.id === newItemId),
    false,
  );
  const refreshedFirstPage = await readPage(aliceCookie, newRowWorkspaceId);
  assert.equal(refreshedFirstPage.items[0].id, newItemId);

  console.log(
    "R4 verification passed for bounded keyset traversal, cursor validation and binding, R2 roles and isolation, OFFSET-shift resistance, current claimant state, missing cursor rows, TIMESTAMPTZ(6) precision, and non-snapshot new-row behavior.",
  );
} finally {
  if (clientConnected && fixtureWorkspaceIds.length > 0) {
    try {
      await client.query(
        `DELETE FROM "Workspace" WHERE "id" = ANY($1::uuid[])`,
        [fixtureWorkspaceIds],
      );
    } catch (error) {
      console.error("Failed to restore R4 verification fixtures.", error);
      process.exitCode = 1;
    }
  }

  await client.end();
}
