import { Redis } from "ioredis";
import { env } from "../lib/env.js";

// BullMQ exige maxRetriesPerRequest: null sur la connexion partagée.
export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
