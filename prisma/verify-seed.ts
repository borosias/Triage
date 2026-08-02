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
  throw new Error("DIRECT_URL must be configured before verifying seed data.");
}

const expectedUsers = [
  { id: "00000000-0000-4000-8000-000000000001", name: "Alice" },
  { id: "00000000-0000-4000-8000-000000000002", name: "Bob" },
  { id: "00000000-0000-4000-8000-000000000003", name: "Carol" },
  { id: "00000000-0000-4000-8000-000000000004", name: "Dana" },
];

const expectedWorkspaces = [
  { id: "10000000-0000-4000-8000-000000000001", name: "Alpha" },
  { id: "10000000-0000-4000-8000-000000000002", name: "Beta" },
];

const expectedMemberships = [
  { workspace: "Alpha", user_name: "Alice", role: "OWNER" },
  { workspace: "Alpha", user_name: "Bob", role: "MEMBER" },
  { workspace: "Alpha", user_name: "Carol", role: "VIEWER" },
  { workspace: "Beta", user_name: "Alice", role: "MEMBER" },
  { workspace: "Beta", user_name: "Bob", role: "OWNER" },
  { workspace: "Beta", user_name: "Dana", role: "VIEWER" },
];

const expectedDistribution = [
  {
    workspace: "Alpha",
    item_count: 7000,
    open_unclaimed: 4550,
    open_claimed: 1050,
    resolved: 1400,
  },
  {
    workspace: "Beta",
    item_count: 3000,
    open_unclaimed: 1950,
    open_claimed: 450,
    resolved: 600,
  },
];

const client = new Client({ connectionString });

try {
  await client.connect();

  const { rows: users } = await client.query<{ id: string; name: string }>(`
    SELECT "id"::text AS "id", "name"
    FROM "User"
    ORDER BY "id"
  `);

  const { rows: workspaces } = await client.query<{
    id: string;
    name: string;
  }>(`
    SELECT "id"::text AS "id", "name"
    FROM "Workspace"
    ORDER BY "id"
  `);

  const { rows: memberships } = await client.query<{
    workspace: string;
    user_name: string;
    role: string;
  }>(`
    SELECT
      workspace."name" AS "workspace",
      app_user."name" AS "user_name",
      membership."role"::text AS "role"
    FROM "WorkspaceMembership" AS membership
    JOIN "Workspace" AS workspace ON workspace."id" = membership."workspaceId"
    JOIN "User" AS app_user ON app_user."id" = membership."userId"
    ORDER BY workspace."name", app_user."name"
  `);

  const { rows: distribution } = await client.query<{
    workspace: string;
    item_count: number;
    open_unclaimed: number;
    open_claimed: number;
    resolved: number;
  }>(`
    SELECT
      workspace."name" AS "workspace",
      COUNT(*)::int AS "item_count",
      (COUNT(*) FILTER (
        WHERE item."status" = 'OPEN' AND item."claimedById" IS NULL
      ))::int AS "open_unclaimed",
      (COUNT(*) FILTER (
        WHERE item."status" = 'OPEN' AND item."claimedById" IS NOT NULL
      ))::int AS "open_claimed",
      (COUNT(*) FILTER (
        WHERE item."status" = 'RESOLVED'
      ))::int AS "resolved"
    FROM "Item" AS item
    JOIN "Workspace" AS workspace ON workspace."id" = item."workspaceId"
    GROUP BY workspace."name"
    ORDER BY workspace."name"
  `);

  const { rows: [invalidStates] } = await client.query<{
    claimed_missing_at: number;
    unclaimed_with_at: number;
    open_with_resolution: number;
    invalid_resolved: number;
    unauthorized_claimants: number;
    unauthorized_resolvers: number;
    viewer_actors: number;
  }>(`
    SELECT
      (COUNT(*) FILTER (
        WHERE item."claimedById" IS NOT NULL AND item."claimedAt" IS NULL
      ))::int AS "claimed_missing_at",
      (COUNT(*) FILTER (
        WHERE item."claimedById" IS NULL AND item."claimedAt" IS NOT NULL
      ))::int AS "unclaimed_with_at",
      (COUNT(*) FILTER (
        WHERE item."status" = 'OPEN'
          AND (item."resolvedById" IS NOT NULL OR item."resolvedAt" IS NOT NULL)
      ))::int AS "open_with_resolution",
      (COUNT(*) FILTER (
        WHERE item."status" = 'RESOLVED'
          AND (
            item."resolvedById" IS NULL
            OR item."resolvedAt" IS NULL
            OR item."claimedById" IS NOT NULL
            OR item."claimedAt" IS NOT NULL
          )
      ))::int AS "invalid_resolved",
      (COUNT(*) FILTER (
        WHERE item."claimedById" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "WorkspaceMembership" AS claimant_membership
            WHERE claimant_membership."workspaceId" = item."workspaceId"
              AND claimant_membership."userId" = item."claimedById"
              AND claimant_membership."role" IN ('OWNER', 'MEMBER')
          )
      ))::int AS "unauthorized_claimants",
      (COUNT(*) FILTER (
        WHERE item."resolvedById" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "WorkspaceMembership" AS resolver_membership
            WHERE resolver_membership."workspaceId" = item."workspaceId"
              AND resolver_membership."userId" = item."resolvedById"
              AND resolver_membership."role" IN ('OWNER', 'MEMBER')
          )
      ))::int AS "unauthorized_resolvers",
      (COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1
          FROM "WorkspaceMembership" AS viewer_membership
          WHERE viewer_membership."workspaceId" = item."workspaceId"
            AND viewer_membership."role" = 'VIEWER'
            AND viewer_membership."userId" IN (item."claimedById", item."resolvedById")
        )
      ))::int AS "viewer_actors"
    FROM "Item" AS item
  `);

  const { rows: [timestampVariety] } = await client.query<{
    created_timestamps: number;
    claimed_timestamps: number;
    resolved_timestamps: number;
  }>(`
    SELECT
      COUNT(DISTINCT "createdAt")::int AS "created_timestamps",
      COUNT(DISTINCT "claimedAt")::int AS "claimed_timestamps",
      COUNT(DISTINCT "resolvedAt")::int AS "resolved_timestamps"
    FROM "Item"
  `);

  assert.deepEqual(users, expectedUsers, "seeded users must match the four stable fixtures");
  assert.deepEqual(
    workspaces,
    expectedWorkspaces,
    "seeded workspaces must match the two stable fixtures",
  );
  assert.deepEqual(
    memberships,
    expectedMemberships,
    "workspace roles must match the assignment fixture matrix",
  );
  assert.deepEqual(
    distribution,
    expectedDistribution,
    "item distribution must remain 7000/3000 and 65/15/20 per workspace",
  );
  assert.deepEqual(
    invalidStates,
    {
      claimed_missing_at: 0,
      unclaimed_with_at: 0,
      open_with_resolution: 0,
      invalid_resolved: 0,
      unauthorized_claimants: 0,
      unauthorized_resolvers: 0,
      viewer_actors: 0,
    },
    "seeded item states and actors must satisfy every database invariant",
  );
  assert.ok(
    timestampVariety.created_timestamps > 100,
    "createdAt must contain varied historical timestamps",
  );
  assert.ok(
    timestampVariety.claimed_timestamps > 100,
    "claimedAt must contain varied historical timestamps",
  );
  assert.ok(
    timestampVariety.resolved_timestamps > 100,
    "resolvedAt must contain varied historical timestamps",
  );

  console.table([
    {
      users: users.length,
      workspaces: workspaces.length,
      memberships: memberships.length,
      items: distribution.reduce((total, row) => total + row.item_count, 0),
    },
  ]);
  console.table(distribution);
  console.table([invalidStates]);
  console.log("Seed verification passed: identities, roles, states, actors, and timestamps are valid.");
} finally {
  await client.end();
}
