CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventType" TEXT,
    "externalOrderId" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "httpStatus" INTEGER,
    "hasSignature" BOOLEAN NOT NULL DEFAULT false,
    "hasSecondarySignature" BOOLEAN NOT NULL DEFAULT false,
    "signatureValid" BOOLEAN,
    "rawBodyHash" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookDelivery_provider_createdAt_idx" ON "WebhookDelivery"("provider", "createdAt");
CREATE INDEX "WebhookDelivery_externalOrderId_idx" ON "WebhookDelivery"("externalOrderId");
