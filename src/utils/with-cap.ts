/**
 * Wait for `p`, but no longer than `ms`. Resolves either way and never
 * rejects; the timer is unref'd so it never holds the process open.
 */
export async function withCap(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([p.then(() => {}, () => {}), cap]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How long a finished build waits for its telemetry event. trackEvent itself
 * aborts after 3 s; this cap keeps a slow API from delaying the exit longer,
 * and is short enough that an error rethrown to the top-level handlers in
 * index.ts (which call process.exit) still lets the event out first.
 */
export const TELEMETRY_FLUSH_MS = 2500;
/** Shorter cap for Ctrl-C: the user asked to stop. */
export const SIGINT_FLUSH_MS = 1500;
