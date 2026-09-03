import { PrismaClient } from "@prisma/client";

// Un seul client Prisma partagé par tout le process (server + worker).
export const prisma = new PrismaClient();
