import assert from "node:assert/strict";

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
  const response = await request(
    `/api/workspaces/${workspaceId}/items`,
    { headers: { cookie } },
  );

  assert.equal(
    response.status,
    expectedStatus,
    `${workspaceName} queue must return ${expectedStatus}`,
  );

  if (expectedStatus !== 200) {
    await verifyErrorResponse(response);
    return;
  }

  const body = await readJson(response);
  assert.ok(Array.isArray(body.items), "queue response must contain items");
  assert.ok(body.items.length <= 50, "queue response must contain at most 50 items");

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
}

const unauthenticatedResponse = await request("/api/workspaces");
assert.equal(unauthenticatedResponse.status, 401);
await verifyErrorResponse(unauthenticatedResponse);

const aliceCookie = await verifyWorkspaceList("Alice", [
  { id: workspaces.Alpha, name: "Alpha", role: "OWNER" },
  { id: workspaces.Beta, name: "Beta", role: "MEMBER" },
]);
await verifyQueue(aliceCookie, "Alpha", 200);
await verifyQueue(aliceCookie, "Beta", 200);

await verifyWorkspaceList("Bob", [
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

console.log("Epic 2 R2 read verification passed.");
