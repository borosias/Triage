import assert from "node:assert/strict";

const baseUrl = process.env.SESSION_VERIFY_BASE_URL ?? "http://127.0.0.1:3000";
const expectSecureCookie = process.env.SESSION_VERIFY_SECURE === "true";

const users = {
  Alice: "00000000-0000-4000-8000-000000000001",
  Bob: "00000000-0000-4000-8000-000000000002",
  Carol: "00000000-0000-4000-8000-000000000003",
  Dana: "00000000-0000-4000-8000-000000000004",
};

async function request(path, init) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    redirect: "manual",
  });
}

function readSessionCookie(response) {
  const setCookie = response.headers.get("set-cookie");

  assert.ok(setCookie, "response must set the session cookie");
  assert.ok(
    setCookie.toLowerCase().startsWith("flamingo_session="),
    "response must use the Flamingo session cookie name",
  );

  const attributes = setCookie.slice(setCookie.indexOf(";"));

  assert.match(attributes, /;\s*HttpOnly/i);
  assert.match(attributes, /;\s*Path=\//i);
  assert.match(attributes, /;\s*SameSite=Lax/i);
  assert.match(attributes, /;\s*Max-Age=28800/i);
  assert.match(attributes, /;\s*Expires=/i);

  if (expectSecureCookie) {
    assert.match(attributes, /;\s*Secure/i);
  } else {
    assert.doesNotMatch(attributes, /;\s*Secure/i);
  }

  return setCookie.split(";", 1)[0];
}

function readTokenPayload(cookie) {
  const token = cookie.slice(cookie.indexOf("=") + 1);
  const segments = token.split(".");

  assert.equal(segments.length, 3, "session must be a signed compact JWT");

  return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
}

async function postSession(body, cookie) {
  return request("/api/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function assertCurrentUserPage(html, name) {
  assert.match(
    html,
    new RegExp(
      `Current user:\\s*</span>\\s*<strong[^>]*>${name}</strong>`,
    ),
  );
}

const initialPage = await request("/");
assert.equal(initialPage.status, 200);

const initialHtml = await initialPage.text();
for (const name of Object.keys(users)) {
  assert.match(initialHtml, new RegExp(`>${name}</option>`));
}
assertCurrentUserPage(initialHtml, "Not signed in");

const malformedResponse = await postSession({ userId: "not-a-uuid" });
assert.equal(malformedResponse.status, 400);
assert.equal(malformedResponse.headers.get("set-cookie"), null);

const extraInputResponse = await postSession({
  userId: users.Alice,
  role: "OWNER",
});
assert.equal(extraInputResponse.status, 400);
assert.equal(extraInputResponse.headers.get("set-cookie"), null);

const unknownResponse = await postSession({
  userId: "99999999-9999-4999-8999-999999999999",
});
assert.equal(unknownResponse.status, 404);
assert.equal(unknownResponse.headers.get("set-cookie"), null);

const aliceResponse = await postSession({ userId: users.Alice });
assert.equal(aliceResponse.status, 200);
assert.deepEqual(await aliceResponse.json(), {
  user: { id: users.Alice, name: "Alice" },
});

const aliceCookie = readSessionCookie(aliceResponse);
const alicePayload = readTokenPayload(aliceCookie);
assert.deepEqual(Object.keys(alicePayload).sort(), ["exp", "iat", "sub"]);
assert.equal(alicePayload.sub, users.Alice);
assert.equal(alicePayload.exp - alicePayload.iat, 28_800);

const alicePage = await request("/", {
  headers: { cookie: aliceCookie },
});
assert.equal(alicePage.status, 200);
assertCurrentUserPage(await alicePage.text(), "Alice");

const bobResponse = await postSession({ userId: users.Bob }, aliceCookie);
assert.equal(bobResponse.status, 200);
assert.deepEqual(await bobResponse.json(), {
  user: { id: users.Bob, name: "Bob" },
});

const bobCookie = readSessionCookie(bobResponse);
const bobPage = await request("/", { headers: { cookie: bobCookie } });
assert.equal(bobPage.status, 200);
assertCurrentUserPage(await bobPage.text(), "Bob");

const [cookieName, bobToken] = bobCookie.split("=", 2);
const tokenSegments = bobToken.split(".");
const signature = tokenSegments[2];
const tamperedSignature = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
const tamperedToken = `${tokenSegments[0]}.${tokenSegments[1]}.${tamperedSignature}`;
const tamperedPage = await request("/", {
  headers: { cookie: `${cookieName}=${tamperedToken}` },
});
assert.equal(tamperedPage.status, 200);
assertCurrentUserPage(await tamperedPage.text(), "Not signed in");

const logoutResponse = await request("/api/session", {
  method: "DELETE",
  headers: { cookie: bobCookie },
});
assert.equal(logoutResponse.status, 204);

const clearedCookie = logoutResponse.headers.get("set-cookie");
assert.ok(clearedCookie, "logout must clear the session cookie");
assert.ok(
  clearedCookie.toLowerCase().startsWith("flamingo_session="),
  "logout must clear the Flamingo session cookie",
);

const clearedAttributes = clearedCookie.slice(clearedCookie.indexOf(";"));
assert.match(clearedAttributes, /;\s*Max-Age=0/i);
assert.match(
  clearedAttributes,
  /;\s*Expires=Thu, 01 Jan 1970 00:00:00 GMT/i,
);
assert.match(clearedAttributes, /;\s*HttpOnly/i);

console.log("Epic 1C session verification passed.");
