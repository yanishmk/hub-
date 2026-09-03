import { z } from "zod";

// Format que je contrôle moi-même pour les commandes venant de mon site web.
export const websiteOrderModifierSchema = z.object({
  name: z.string().min(1),
  price: z.number().finite(),
});

export const websiteOrderItemSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().finite().nonnegative(),
  modifiers: z.array(websiteOrderModifierSchema).optional().default([]),
  notes: z.string().optional(),
  // ID catalogue Cluster POS (Item_uid), une fois le mapping menu -> Cluster fait.
  clusterItemUid: z.number().int().optional(),
});

export const websiteOrderSchema = z.object({
  externalId: z.string().min(1),
  orderType: z.enum(["delivery", "pickup", "dine_in"]),
  requestedFor: z.string().datetime().optional(),
  customer: z.object({
    name: z.string().min(1),
    phone: z.string().optional(),
  }),
  items: z.array(websiteOrderItemSchema).min(1),
  subtotal: z.number().finite().nonnegative(),
  tax: z.number().finite().nonnegative(),
  deliveryFee: z.number().finite().nonnegative().optional(),
  tip: z.number().finite().nonnegative().optional(),
  total: z.number().finite().nonnegative(),
  paymentStatus: z.enum(["paid_externally", "pay_at_pos"]),
});

export type WebsiteOrderPayload = z.infer<typeof websiteOrderSchema>;

export function parseWebsiteOrder(body: unknown): WebsiteOrderPayload {
  return websiteOrderSchema.parse(body);
}
