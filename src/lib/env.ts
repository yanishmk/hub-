import "dotenv/config";
import { z } from "zod";

const boolFromString = z
  .string()
  .optional()
  .default("false")
  .transform((v) => v.toLowerCase() === "true");

const boolFromStringDefaultTrue = z
  .string()
  .optional()
  .default("true")
  .transform((v) => v.toLowerCase() === "true");

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  START_WORKER_IN_PROCESS: boolFromStringDefaultTrue,

  DATABASE_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/cluster_pos_hub?schema=public"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  CLUSTER_API_KEY: z.string().default(""),
  CLUSTER_SERIAL: z.string().default(""),
  CLUSTER_TOKEN: z.string().default(""),
  CLUSTER_API_BASE_URL: z.string().default(""),
  CLUSTER_MAX_RETRIES: z.coerce.number().default(3),

  WEBSITE_API_KEY: z.string().default(""),
  // Protège le dashboard admin et les endpoints de gestion des commandes
  // (liste, détail, retry). Vide = pas d'auth (pratique en dev local).
  ADMIN_API_KEY: z.string().default(""),

  UBEREATS_ENABLED: boolFromString,
  UBEREATS_APP_NAME: z.string().optional().default(""),
  UBEREATS_CLIENT_ID: z.string().optional().default(""),
  UBEREATS_CLIENT_SECRET: z.string().optional().default(""),
  UBEREATS_WEBHOOK_SIGNING_SECRET: z.string().optional().default(""),
  UBEREATS_API_BASE_URL: z.string().optional().default("https://api.uber.com"),
  UBEREATS_AUTH_URL: z.string().optional().default("https://auth.uber.com/oauth/v2/token"),
  UBEREATS_OAUTH_SCOPE: z.string().optional().default("eats.order"),
  UBEREATS_AUTO_ACCEPT: boolFromString,
  UBEREATS_MANUAL_ACCEPT_POLL_ENABLED: boolFromStringDefaultTrue,
  UBEREATS_MANUAL_ACCEPT_POLL_ATTEMPTS: z.coerce.number().int().positive().default(60),
  UBEREATS_MANUAL_ACCEPT_POLL_DELAY_MS: z.coerce.number().int().positive().default(10_000),

  DOORDASH_ENABLED: boolFromString,
  DOORDASH_DEVELOPER_ID: z.string().optional().default(""),
  DOORDASH_KEY_ID: z.string().optional().default(""),
  DOORDASH_SIGNING_SECRET: z.string().optional().default(""),

  SKIP_ENABLED: boolFromString,
  SKIP_API_KEY: z.string().optional().default(""),
  SKIP_WEBHOOK_SIGNING_SECRET: z.string().optional().default(""),
}).superRefine((value, ctx) => {
  if (process.env.NODE_ENV !== "production") return;

  const requiredInProduction = [
    "DATABASE_URL",
    "REDIS_URL",
    "CLUSTER_API_KEY",
    "CLUSTER_SERIAL",
    "CLUSTER_TOKEN",
    "CLUSTER_API_BASE_URL",
    "WEBSITE_API_KEY",
    "ADMIN_API_KEY",
  ] as const;

  for (const key of requiredInProduction) {
    if (!value[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required in production`,
      });
    }
  }

  if (value.UBEREATS_ENABLED) {
    for (const key of ["UBEREATS_CLIENT_ID", "UBEREATS_CLIENT_SECRET"] as const) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when UBEREATS_ENABLED=true`,
        });
      }
    }
  }
});

export const env = envSchema.parse(process.env);
