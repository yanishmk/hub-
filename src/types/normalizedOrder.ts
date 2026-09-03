export type OrderSource = "ubereats" | "doordash" | "skip" | "website";

export type OrderStatus =
  | "received"
  | "sent_to_pos"
  | "confirmed"
  | "preparing"
  | "ready"
  | "error"
  | "cancelled";

export type OrderType = "delivery" | "pickup" | "dine_in";

export type PaymentStatus = "paid_externally" | "pay_at_pos";

export interface NormalizedOrderModifier {
  name: string;
  price: number;
}

export interface NormalizedOrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  modifiers: NormalizedOrderModifier[];
  notes?: string;
  // ID du catalogue interne Cluster POS pour cet item (champ "Item_uid" de leur
  // API). Obtenu via un appel get-inventory sur le terminal réel — pas encore
  // renseigné tant que le mapping menu crepone -> catalogue Cluster n'existe pas.
  clusterItemUid?: number;
}

export interface NormalizedOrderCustomer {
  name: string;
  phone?: string;
  address?: string;
  city?: string;
  postalCode?: string;
}

// Schéma de commande interne unique. Toute source (webhook delivery ou site
// web) est convertie vers cette forme avant d'entrer dans la file d'attente.
export interface NormalizedOrder {
  id: string;
  externalId: string;
  source: OrderSource;
  status: OrderStatus;
  orderType: OrderType;
  createdAt: string;
  requestedFor: string | null;
  customer: NormalizedOrderCustomer;
  items: NormalizedOrderItem[];
  subtotal: number;
  tax: number;
  deliveryFee?: number;
  tip?: number;
  total: number;
  paymentStatus: PaymentStatus;
  rawSourcePayload: object;
}
