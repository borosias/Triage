import "server-only";

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { z } from "zod";
import type { User } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const SESSION_COOKIE_NAME = "flamingo_session";
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

const SESSION_ALGORITHM = "HS256";
const sessionKey = new TextEncoder().encode(env.SESSION_SECRET);
const sessionPayloadSchema = z
  .object({
    sub: z.uuid(),
    iat: z.number().int(),
    exp: z.number().int(),
  })
  .strict();

export async function createSessionToken(userId: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + SESSION_MAX_AGE_SECONDS;
  const token = await new SignJWT()
    .setProtectedHeader({ alg: SESSION_ALGORITHM, typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(sessionKey);

  return { token, expiresAt };
}

export function sessionCookieOptions(expiresAt: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    expires: new Date(expiresAt * 1000),
  };
}

export function clearedSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  };
}

async function readSessionUserId(token: string) {
  try {
    const { payload } = await jwtVerify(token, sessionKey, {
      algorithms: [SESSION_ALGORITHM],
    });

    return sessionPayloadSchema.parse(payload).sub;
  } catch {
    return null;
  }
}

export async function getCurrentUser(): Promise<User | null> {
  const sessionToken = (await cookies()).get(SESSION_COOKIE_NAME)?.value;

  if (!sessionToken) {
    return null;
  }

  const userId = await readSessionUserId(sessionToken);

  if (!userId) {
    return null;
  }

  return db.user.findUnique({ where: { id: userId } });
}
