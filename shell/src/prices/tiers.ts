// A model's tier is worked out from its input list price per 1M tokens, never
// set by hand (the owner, 2026-11-24; bands from the price report of that day).

export type Tier = "Smallest" | "Middle" | "Strongest";

export const tierFromInputPrice = (usdPerMTok: number): Tier =>
  usdPerMTok < 0.5 ? "Smallest" : usdPerMTok < 2.5 ? "Middle" : "Strongest";
