// The registered provider plug-ins: one per "Connect <Provider>" button.
// Each is built from the Worker's configuration; one whose app-side values
// are not set yet (T10) is still listed, and its test call says so plainly.
// Bedrock's is also given Bedrock's own model list, matched to the price
// table (src/providers/bedrock-catalog.ts), which `readProviderPlugins`
// reads from D1 for each request.

import type { GoogleFederationEnv } from "../google-federation";
import type { PluginRegistry } from "../proxy/plugin";
import { bedrockPlugin, regionOf, type BedrockEnv } from "./bedrock";
import { readBedrockOffer, type BedrockOffer } from "./bedrock-catalog";
import { foundryPlugin, type FoundryEnv } from "./foundry";
import { vertexPlugin } from "./vertex";

export type ProvidersEnv = BedrockEnv & FoundryEnv & GoogleFederationEnv;

export const providerPlugins = (
  env: ProvidersEnv,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
  bedrockOffer?: BedrockOffer,
): PluginRegistry => ({
  bedrock: bedrockPlugin(env, fetcher, now, bedrockOffer),
  foundry: foundryPlugin(env, fetcher, now),
  vertex: vertexPlugin(env, fetcher, now),
});

export const readProviderPlugins = async (env: ProvidersEnv, db: D1Database): Promise<PluginRegistry> =>
  providerPlugins(env, fetch, () => new Date(), await readBedrockOffer(db, regionOf(env)));
