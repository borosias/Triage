import "server-only";

import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.url(),
});

const parsedServerEnv = serverEnvSchema.safeParse({
  DATABASE_URL: process.env.DATABASE_URL,
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
