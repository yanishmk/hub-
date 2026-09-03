import { normalizeText } from "./normalizeText.js";

export interface ClusterItemMapping {
  clusterItemUid: number;
  clusterName: string;
  aliases: string[];
}

export const CLUSTER_ITEM_MAPPINGS: ClusterItemMapping[] = [
  item(6, "Crêpe Nutella", ["Crêpe classique Nutella"]),
  item(7, "Crêpe Banane", ["Crêpe classique Banane"]),
  item(9, "Crêpe Oreo", ["Crêpe classique Oreo"]),
  item(10, "Crêpe Lotus", ["Crêpe classique Lotus"]),
  item(15, "Crêpe Bueno", ["Crêpe classique Bueno", "Crêpe croustillante Bueno"]),
  item(11, "Crêpe Pistache", ["Crêpe classique Pistache", "Crêpe croustillante Pistache"]),
  item(18, "Crêpe Dubai", ["Crêpe classique Dubai", "Crêpe croustillante Dubai"]),
  item(14, "Crêpe fruité", ["Crêpe fruite", "Crêpe fruitée"]),
  item(17, "Crêpe Mordjene"),
  item(12, "Crêpe Gourmande", ["Crêpe croustillante Gourmandes", "Crêpe croustillante Gourmande"]),
  item(69, "Gaufre Nutella"),
  item(70, "Gaufre Banane"),
  item(71, "Gaufre Fraise", ["Gaufre Fraise 🍓"]),
  item(73, "Gaufre Lotus"),
  item(72, "Gaufre Oreo"),
  item(78, "Gaufre Bueno"),
  item(74, "Gaufre Pistache"),
  item(75, "Gaufre Gourmande"),
  item(81, "Gaufre Dubai"),
  item(227, "Croffle lotus biscoff", ["Croffle Lotus Biscoff"]),
  item(229, "Croffle fraise", ["Croffle fraise 🍓", "Croffle Fraise"]),
  item(226, "Croffle Oreo"),
  item(228, "Croffle banana", ["Croffle banana 🍌", "Croffle Banane"]),
  item(199, "Poff's Nutella", ["Poffs Nutella"]),
  item(217, "Poff's fraise", ["Poff's fraise 🍓", "Poffs fraise", "Poffs fraise 🍓"]),
  item(218, "Poff's Oreo", ["Poffs Oreo"]),
  item(219, "Poff's Lotus", ["Poffs Lotus"]),
  item(220, "Poff's Pistache", ["Poffs Pistache"]),
  item(238, "Poff's Bueno", ["Poffs Bueno"]),
  item(200, "Poff's Banane", ["Poffs Banane"]),
  item(30, "Shake Fraise", ["Milkshake Fraise"]),
  item(28, "Shake Banane", ["Milkshake Banane"]),
  item(33, "Shake Oreo", ["Milkshake Oreo"]),
  item(35, "Shake Lotus", ["Milkshake Lotus"]),
  item(32, "Shake KitKat", ["Milkshake KitKat"]),
  item(29, "Shake Bueno", ["Milkshake Bueno"]),
  item(36, "Shake Ferrero", ["Milkshake Ferrero"]),
  item(86, "Smoothie Fraise & Banane", ["Smoothie Fraise Banane"]),
  item(87, "Smoothie Mangue & Ananas", ["Smoothie Mangue Ananas"]),
  item(89, "Smoothie Fruits Rouges"),
  item(235, "Strawberry Dubai"),
  item(236, "Strawberry Bueno"),
  item(97, "Bouteille d'eau", ["Bouteille eau", "Eau"]),
];

const mappingByAlias = new Map(
  CLUSTER_ITEM_MAPPINGS.flatMap((mapping) => [
    [normalizeText(mapping.clusterName), mapping] as const,
    ...mapping.aliases.map((alias) => [normalizeText(alias), mapping] as const),
  ])
);

export function findClusterItemMapping(name: string): ClusterItemMapping | null {
  return mappingByAlias.get(normalizeText(name)) ?? null;
}

export function clusterItemUidForName(name: string): number | undefined {
  return findClusterItemMapping(name)?.clusterItemUid;
}

function item(
  clusterItemUid: number,
  clusterName: string,
  aliases: string[] = []
): ClusterItemMapping {
  return { clusterItemUid, clusterName, aliases };
}
