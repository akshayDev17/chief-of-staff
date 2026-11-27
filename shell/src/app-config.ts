// The app's own settings that the owner sets once, and the error that says
// one is missing.

// The app's own side of a provider (the vault key, the app's address) is not
// configured yet: the owner's one-time steps (README "Releasing the shell").
export class AppNotConfigured extends Error {
  constructor(readonly missing: string[]) {
    super(`not configured yet: ${missing.join(", ")}`);
    this.name = "AppNotConfigured";
  }
}

// The app's own address, `https://<host>` with no path: where a provider's
// consent page sends the user back to, and the address OpenRouter credits
// calls to. Undefined when not set or not https.
export function readAppOrigin(env: { APP_ORIGIN?: string }): string | undefined {
  const origin = env.APP_ORIGIN?.trim().replace(/\/+$/, "");
  if (!origin || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) return undefined;
  return origin;
}
