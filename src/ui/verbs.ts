/**
 * Verb pool — spinner personality (Claude Code principle, unique implementation).
 *
 * A curated pool of present-participle verbs picked randomly per stage to give
 * long-running operations personality. Rotates per stage transition, not per frame.
 */

const VERBS = [
  "Analyzing",
  "Composing",
  "Discovering",
  "Distilling",
  "Exploring",
  "Harmonizing",
  "Illuminating",
  "Investigating",
  "Mapping",
  "Reasoning",
  "Refining",
  "Scanning",
  "Sifting",
  "Surveying",
  "Synthesizing",
  "Threading",
  "Uncovering",
  "Weaving",
] as const;

let lastPicked: string | null = null;

/** Pick a verb (biased to avoid repeats within a session). */
export function pickVerb(): string {
  let choice: string;
  do {
    choice = VERBS[Math.floor(Math.random() * VERBS.length)];
  } while (choice === lastPicked && VERBS.length > 1);
  lastPicked = choice;
  return choice;
}

/** Same but with an ellipsis appended (`Exploring…`). */
export function verbing(): string {
  return `${pickVerb()}…`;
}
