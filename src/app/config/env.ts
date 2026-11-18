import { z } from "zod";
import { logger } from "../shared/logger/logger";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  DATABASE_URL: z.string().url(),   

  REDIS_URL: z
    .string()
    .url("Invalid Redis URL")
    .refine(
      (url) => url.startsWith("redis://") || url.startsWith("rediss://"),
      "REDIS_URL must use redis:// or rediss:// protocol",
    ),
});

export type Env = z.infer<typeof envSchema>;

function createEnv(env: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    logger.error("Environment variable validation failed", {
      errors: result.error.format(),
    });
    process.exit(1);
  }

  return result.data;
}

export const env = createEnv(process.env);
