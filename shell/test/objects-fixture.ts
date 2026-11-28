// Helpers for tests of the Durable Objects (src/objects/).

// A Durable Object stub's call returns an RPC promise, a proxy whose every
// property is itself a pipelined call; expect() reads properties, and each
// one read off a refused call is a second, unhandled refusal. So a refusal
// is settled here, through `then` alone, into its message.
export async function refusal(call: PromiseLike<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to be refused");
}

// Times in the past, so a time the code takes from the clock is later.
export const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 1, 10, minute));
