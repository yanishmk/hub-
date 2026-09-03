import { describe, expect, it } from "vitest";
import { clusterItemUidForName } from "../src/menu/clusterItemMapping.js";

describe("cluster item mapping", () => {
  it("maps Uber menu names to Cluster Item_uid with accent-insensitive matching", () => {
    expect(clusterItemUidForName("Crêpe classique Nutella")).toBe(6);
    expect(clusterItemUidForName("Crepe classique Nutella")).toBe(6);
    expect(clusterItemUidForName("  CRÊPE   NUTELLA  ")).toBe(6);
    expect(clusterItemUidForName("Crêpe croustillante Dubai")).toBe(18);
    expect(clusterItemUidForName("Gaufre Fraise 🍓")).toBe(71);
    expect(clusterItemUidForName("Croffle banana 🍌")).toBe(228);
    expect(clusterItemUidForName("Poffs Lotus")).toBe(219);
    expect(clusterItemUidForName("Milkshake Oreo")).toBe(33);
    expect(clusterItemUidForName("Smoothie Mangue Ananas")).toBe(87);
    expect(clusterItemUidForName("Eau")).toBe(97);
  });

  it("returns undefined for unmapped items", () => {
    expect(clusterItemUidForName("Poutine test Uber")).toBeUndefined();
  });
});
