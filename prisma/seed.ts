import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { Client } from "pg";

const envFile = [".env.local", ".env"].find(existsSync);

if (envFile) {
  loadEnvFile(envFile);
}

const connectionString = process.env.DIRECT_URL;

if (!connectionString) {
  throw new Error("DIRECT_URL must be configured before seeding the database.");
}

const client = new Client({ connectionString });
let transactionStarted = false;

try {
  await client.connect();
  await client.query("BEGIN");
  transactionStarted = true;

  console.log(
    'Resetting Flamingo application tables: "Item", "WorkspaceMembership", "Workspace", and "User".',
  );

  await client.query(`
  TRUNCATE TABLE
    "NotificationDelivery",
    "Item",
    "WorkspaceMembership",
    "Workspace",
    "User"
`);

  await client.query(`
    INSERT INTO "User" ("id", "name", "createdAt")
    VALUES
      ('00000000-0000-4000-8000-000000000001', 'Alice', TIMESTAMPTZ '2024-01-01 00:00:00+00'),
      ('00000000-0000-4000-8000-000000000002', 'Bob',   TIMESTAMPTZ '2024-01-01 00:00:00+00'),
      ('00000000-0000-4000-8000-000000000003', 'Carol', TIMESTAMPTZ '2024-01-01 00:00:00+00'),
      ('00000000-0000-4000-8000-000000000004', 'Dana',  TIMESTAMPTZ '2024-01-01 00:00:00+00')
  `);

  await client.query(`
    INSERT INTO "Workspace" ("id", "name", "createdAt")
    VALUES
      ('10000000-0000-4000-8000-000000000001', 'Alpha', TIMESTAMPTZ '2024-01-01 00:00:00+00'),
      ('10000000-0000-4000-8000-000000000002', 'Beta',  TIMESTAMPTZ '2024-01-01 00:00:00+00')
  `);

  await client.query(`
    INSERT INTO "WorkspaceMembership" ("workspaceId", "userId", "role")
    VALUES
      ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'OWNER'),
      ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'MEMBER'),
      ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'VIEWER'),
      ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'OWNER'),
      ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'MEMBER'),
      ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000004', 'VIEWER')
  `);

  await client.query(`
    WITH generated AS (
      SELECT
        sequence_number,
        CASE
          WHEN sequence_number <= 7000
            THEN '10000000-0000-4000-8000-000000000001'::uuid
          ELSE '10000000-0000-4000-8000-000000000002'::uuid
        END AS workspace_id,
        CASE
          WHEN sequence_number <= 7000 THEN sequence_number
          ELSE sequence_number - 7000
        END AS workspace_position,
        TIMESTAMPTZ '2024-01-01 00:00:00+00'
          + ((sequence_number * 37) % 730) * INTERVAL '1 day'
          + ((sequence_number * 97) % 86400) * INTERVAL '1 second' AS created_at
      FROM generate_series(1, 10000) AS sequence_number
    ),
    classified AS (
      SELECT
        generated.*,
        CASE
          WHEN (
            workspace_id = '10000000-0000-4000-8000-000000000001'::uuid
            AND workspace_position <= 4550
          ) OR (
            workspace_id = '10000000-0000-4000-8000-000000000002'::uuid
            AND workspace_position <= 1950
          ) THEN 'OPEN_UNCLAIMED'
          WHEN (
            workspace_id = '10000000-0000-4000-8000-000000000001'::uuid
            AND workspace_position <= 5600
          ) OR (
            workspace_id = '10000000-0000-4000-8000-000000000002'::uuid
            AND workspace_position <= 2400
          ) THEN 'OPEN_CLAIMED'
          ELSE 'RESOLVED'
        END AS item_state
      FROM generated
    )
    INSERT INTO "Item" (
      "id",
      "workspaceId",
      "title",
      "status",
      "claimedById",
      "claimedAt",
      "resolvedById",
      "resolvedAt",
      "createdAt"
    )
    SELECT
      format(
        '20000000-0000-4000-8000-%s',
        lpad(to_hex(sequence_number), 12, '0')
      )::uuid,
      workspace_id,
      (ARRAY[
        'Review payment exception',
        'Verify customer details',
        'Investigate duplicate record',
        'Check compliance document',
        'Reconcile account balance',
        'Confirm delivery exception',
        'Review support escalation',
        'Validate refund request'
      ])[1 + ((sequence_number - 1) % 8)]
        || ' #'
        || lpad(sequence_number::text, 5, '0'),
      CASE
        WHEN item_state = 'RESOLVED' THEN 'RESOLVED'::"ItemStatus"
        ELSE 'OPEN'::"ItemStatus"
      END,
      CASE
        WHEN item_state = 'OPEN_CLAIMED' AND sequence_number % 2 = 0
          THEN '00000000-0000-4000-8000-000000000002'::uuid
        WHEN item_state = 'OPEN_CLAIMED'
          THEN '00000000-0000-4000-8000-000000000001'::uuid
        ELSE NULL
      END,
      CASE
        WHEN item_state = 'OPEN_CLAIMED'
          THEN created_at + (1 + sequence_number % 168) * INTERVAL '1 hour'
        ELSE NULL
      END,
      CASE
        WHEN item_state = 'RESOLVED' AND sequence_number % 2 = 0
          THEN '00000000-0000-4000-8000-000000000002'::uuid
        WHEN item_state = 'RESOLVED'
          THEN '00000000-0000-4000-8000-000000000001'::uuid
        ELSE NULL
      END,
      CASE
        WHEN item_state = 'RESOLVED'
          THEN created_at + (24 + sequence_number % 720) * INTERVAL '1 hour'
        ELSE NULL
      END,
      created_at
    FROM classified
  `);

  await client.query("COMMIT");
  transactionStarted = false;

  console.log(
    "Seeded 4 users, 2 workspaces, 6 memberships, and 10,000 deterministic items.",
  );
} catch (error) {
  if (transactionStarted) {
    await client.query("ROLLBACK");
  }

  throw error;
} finally {
  await client.end();
}
