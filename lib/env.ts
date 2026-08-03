import "server-only";

import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.url(),
  NOTIFICATION_WEBHOOK_SECRET: z.string().min(32),
  SESSION_SECRET: z.string().min(32),
});

const parsedServerEnv = serverEnvSchema.safeParse({
  DATABASE_URL: process.env.DATABASE_URL,
  NOTIFICATION_WEBHOOK_SECRET: process.env.NOTIFICATION_WEBHOOK_SECRET,
  SESSION_SECRET: process.env.SESSION_SECRET,
});

if (!parsedServerEnv.success) {
  const invalidVariables = parsedServerEnv.error.issues
    .map((issue) => issue.path.join("."))
    .filter(Boolean)
    .join(", ");

  throw new Error(
    `Invalid server environment variables: ${invalidVariables || "unknown"}`,
  );
}

export const env = parsedServerEnv.data;
