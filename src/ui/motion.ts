/**
 * Motion + timing tokens.
 *
 * Every animation timing lives here — spinner frame interval, tip typewriter
 * speed, tip rotation pause. Pulls all magic numbers out of individual UI
 * modules so we can tune the whole system in one place.
 */

/** Spinner frame interval in ms. 80ms = ~12fps, the Bun/Vercel standard. */
export const SPINNER_FRAME_MS = 80;

/** Milliseconds between each typewriter char in the code-gen tip box. */
export const TIP_TYPEWRITER_MS = 30;

/** Pause after a tip fully types before rotating to the next one. */
export const TIP_PAUSE_MS = 4000;

/** How often to refresh non-TTY log lines (mostly a rate limiter). */
export const NON_TTY_TICK_MS = 1000;
