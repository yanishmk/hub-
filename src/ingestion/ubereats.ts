import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../lib/env.js";

interface UberToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: UberToken | null = null;

export function isUberEatsEnabled(): boolean {
  return env.UBEREATS_ENABLED;
}

export function verifyUberEatsSignature(
  rawBody: string,
  signatureHeader: string | string[] | undefined
): boolean {
  const signature = Array.isArray(signatureHeader)
    ? signatureHeader[0]
    : signatureHeader;
  const secret = env.UBEREATS_WEBHOOK_SIGNING_SECRET || env.UBEREATS_CLIENT_SECRET;

  if (!secret || !signature) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")
    .toLowerCase();
  const received = signature.trim().toLowerCase().replace(/^sha256=/, "");

  if (!/^[a-f0-9]{64}$/.test(received)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
}

export function getUberEatsOrderId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  const meta = data.meta && typeof data.meta === "object"
    ? data.meta as Record<string, unknown>
    : {};
  return stringValue(meta.resource_id)
    ?? stringValue(data.resource_id)
    ?? stringValue(data.order_id)
    ?? stringValue(data.id);
}

export function getUberEatsOrderHref(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  return stringValue((payload as Record<string, unknown>).resource_href);
}

export function isUberEatsOrderAccepted(payload: unknown, eventType = ""): boolean {
  if (eventType === "orders.release") return true;
  if (!payload || typeof payload !== "object") return false;

  const data = payload as Record<string, unknown>;
  const status = [
    data.status,
    data.state,
    data.order_status,
    data.order_state,
    data.current_state,
    valueAt(data, ["status", "state"]),
    valueAt(data, ["order", "status"]),
    valueAt(data, ["order", "state"]),
  ]
    .map((value) => stringValue(value)?.toLowerCase())
    .find(Boolean);

  if (!status) return false;

  return [
    "accept",
    "accepted",
    "release",
    "released",
    "prepar",
    "ready",
    "pickup",
    "deliver",
  ].some((acceptedState) => status.includes(acceptedState));
}

export async function fetchUberEatsOrder(payload: unknown): Promise<unknown> {
  const href = getUberEatsOrderHref(payload);
  const orderId = getUberEatsOrderId(payload);
  const url = href || (orderId ? `${env.UBEREATS_API_BASE_URL}/v1/eats/orders/${orderId}` : null);

  if (!url) {
    throw new Error("Uber Eats webhook does not include resource_href or order id");
  }

  const token = await getUberEatsAccessToken();
  const response = await fetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Uber Eats order fetch failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

export async function acceptUberEatsOrder(orderId: string): Promise<void> {
  const token = await getUberEatsAccessToken();
  const response = await fetch(
    `${env.UBEREATS_API_BASE_URL}/v1/eats/orders/${orderId}/accept_pos_order`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "Accepted by Cluster POS Hub" }),
    }
  );

  if (!response.ok) {
    throw new Error(`Uber Eats accept_pos_order failed: ${response.status} ${await response.text()}`);
  }
}

async function getUberEatsAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.accessToken;
  }

  if (!env.UBEREATS_CLIENT_ID || !env.UBEREATS_CLIENT_SECRET) {
    throw new Error("Uber Eats credentials are missing");
  }

  const body = new URLSearchParams({
    client_id: env.UBEREATS_CLIENT_ID,
    client_secret: env.UBEREATS_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: env.UBEREATS_OAUTH_SCOPE,
  });
  const response = await fetch(env.UBEREATS_AUTH_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Uber Eats OAuth failed: ${response.status} ${await response.text()}`);
  }

  const token = await response.json() as { access_token?: string; expires_in?: number };
  if (!token.access_token) {
    throw new Error("Uber Eats OAuth response did not include access_token");
  }

  cachedToken = {
    accessToken: token.access_token,
    expiresAt: now + Math.max(60, token.expires_in ?? 3600) * 1000,
  };
  return cachedToken.accessToken;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function valueAt(source: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = source;
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
