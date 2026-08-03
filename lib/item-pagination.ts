import "server-only";

import { z } from "zod";

const MAX_CURSOR_LENGTH = 1024;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const exactTimestampPattern = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)\.(\d{6})Z$/;

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isExactTimestamp(value: string) {
  const match = exactTimestampPattern.exec(value);

  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return year > 0 && day <= daysInMonth[month - 1];
}

const itemCursorSchema = z
  .object({
    v: z.literal(1),
    workspaceId: z.uuid(),
    createdAt: z.string().refine(isExactTimestamp),
    id: z.uuid(),
  })
  .strict();

export type ItemCursor = z.infer<typeof itemCursorSchema>;

export function encodeItemCursor(cursor: ItemCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeItemCursor(value: string) {
  if (
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH ||
    !base64UrlPattern.test(value)
  ) {
    return null;
  }

  try {
    const decoded = Buffer.from(value, "base64url");

    if (decoded.toString("base64url") !== value) {
      return null;
    }

    return itemCursorSchema.safeParse(
      JSON.parse(decoded.toString("utf8")),
    ).data ?? null;
  } catch {
    return null;
  }
}
