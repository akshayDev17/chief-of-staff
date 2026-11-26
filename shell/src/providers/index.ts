// The registered provider plug-ins: one per "Connect <Provider>" button.
// Each is built from the Worker's configuration; one whose app-side values
// are not set yet (T10) is still listed, and its test call says so plainly.

import type { GoogleFederationEnv } from "../google-federation";
import type { PluginRegistry } from "../proxy/plugin";
import { bedrockPlugin, type BedrockEnv } from "./bedrock";
import { foundryPlugin, type FoundryEnv } from "./foundry";
import { vertexPlugin } from "./vertex";

export type ProvidersEnv = BedrockEnv & FoundryEnv & GoogleFederationEnv;

export const providerPlugins = (env: ProvidersEnv, fetcher: typeof fetch = fetch, now: () => Date = () => new Date()): PluginRegistry => ({
  bedrock: bedrockPlugin(env, fetcher, now),
  foundry: foundryPlugin(env, fetcher, now),
  vertex: vertexPlugin(env, fetcher, now),
});
