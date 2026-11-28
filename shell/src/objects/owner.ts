// The one small owner-level object (design-v3 2.4, 11.2, 11.5): it will add
// up every base user's meter against the base-tier monthly ceiling (T23) and
// hold the user cap's count (T53). Neither exists yet, so it holds nothing:
// each arrives as this object's next storage step, applied on its first wake
// after the release that carries it (storage.ts).

import { DurableObject } from "cloudflare:workers";
import { appliedSteps, wakeStorage, type AppliedStep, type StorageStep } from "./storage";

// The one instance's name.
export const OWNER_OBJECT_NAME = "owner";

export const OWNER_STEPS: readonly StorageStep[] = [];

export class Owner extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    void wakeStorage(ctx, "Owner", OWNER_STEPS);
  }

  storageSteps(): AppliedStep[] {
    return appliedSteps(this.ctx.storage.sql);
  }
}
