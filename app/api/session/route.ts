import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  clearedSessionCookieOptions,
  createSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/session";

const loginRequestSchema = z
  .object({
    userId: z.uuid(),
  })
  .strict();

export async function POST(request: Request) {
  let input: unknown;

  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsedInput = loginRequestSchema.safeParse(input);

  if (!parsedInput.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const user = await db.user.findUnique({
      where: { id: parsedInput.data.userId },
      select: { id: true, name: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const { token, expiresAt } = await createSessionToken(user.id);
    const response = NextResponse.json({ user });

    response.cookies.set(
      SESSION_COOKIE_NAME,
      token,
      sessionCookieOptions(expiresAt),
    );

    return response;
  } catch {
    return NextResponse.json(
      { error: "Session service unavailable." },
      { status: 503 },
    );
  }
}

export async function DELETE() {
  const response = new NextResponse(null, { status: 204 });

  response.cookies.set(
    SESSION_COOKIE_NAME,
    "",
    clearedSessionCookieOptions(),
  );

  return response;
}
