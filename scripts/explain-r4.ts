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
  throw new Error("DIRECT_URL must be configured before explaining R4.");
}

const workspaceId = "10000000-0000-4000-8000-000000000001";
const pageSize = 50;
const client = new Client({ connectionString });

type CountRow = { count: string };
type BoundaryRow = { id: string; createdAtExact: string };
type ExplainRow = { "QUERY PLAN": string };

try {
  await client.connect();

  const { rows: countRows } = await client.query<CountRow>(
    `
      SELECT count(*)::text AS "count"
      FROM "Item"
      WHERE "workspaceId" = $1::uuid
        AND "status" = 'OPEN'::"ItemStatus"
    `,
    [workspaceId],
  );
  const openItemCount = Number(countRows[0]?.count);
  assert.ok(openItemCount > pageSize * 2);

  const deepOffset = Math.min(
    Math.floor(openItemCount * 0.75),
    openItemCount - pageSize,
  );
  assert.ok(deepOffset > 0);

  const { rows: boundaryRows } = await client.query<BoundaryRow>(
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
      OFFSET $2::int
      LIMIT 1
    `,
    [workspaceId, deepOffset - 1],
  );
  const boundary = boundaryRows[0];
  assert.ok(boundary);

    const { rows: naivePlan } = await client.query<ExplainRow>(
        `
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT
      item."id",
      item."workspaceId",
      item."title",
      item."status"::text,
      item."claimedById",
      item."claimedAt",
      item."createdAt",
      claimant."id" AS "claimantId",
      claimant."name" AS "claimantName",
      to_char(
        item."createdAt" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS "cursorCreatedAt"
    FROM "Item" AS item
    LEFT JOIN "User" AS claimant
      ON claimant."id" = item."claimedById"
    WHERE item."workspaceId" = $1::uuid
      AND item."status" = 'OPEN'::"ItemStatus"
    ORDER BY item."createdAt" DESC, item."id" DESC
    LIMIT 50
    OFFSET $2::int
  `,
        [workspaceId, deepOffset],
    );

    const { rows: keysetPlan } = await client.query<ExplainRow>(
        `
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT
      item."id",
      item."workspaceId",
      item."title",
      item."status"::text,
      item."claimedById",
      item."claimedAt",
      item."createdAt",
      claimant."id" AS "claimantId",
      claimant."name" AS "claimantName",
      to_char(
        item."createdAt" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS "cursorCreatedAt"
    FROM "Item" AS item
    LEFT JOIN "User" AS claimant
      ON claimant."id" = item."claimedById"
    WHERE item."workspaceId" = $1::uuid
      AND item."status" = 'OPEN'::"ItemStatus"
      AND (item."createdAt", item."id") < (
        $2::timestamptz,
        $3::uuid
      )
    ORDER BY item."createdAt" DESC, item."id" DESC
    LIMIT 50
  `,
        [workspaceId, boundary.createdAtExact, boundary.id],
    );

  console.log(`Workspace: ${workspaceId}`);
  console.log(`Matching OPEN rows: ${openItemCount}`);
  console.log(`Deep offset: ${deepOffset}`);
  console.log(
    `Equivalent keyset boundary: (${boundary.createdAtExact}, ${boundary.id})`,
  );
  console.log("\nNaive OFFSET plan:\n");
  console.log(naivePlan.map((row) => row["QUERY PLAN"]).join("\n"));
  console.log("\nComposite keyset plan:\n");
  console.log(keysetPlan.map((row) => row["QUERY PLAN"]).join("\n"));
} finally {
  await client.end();
}
