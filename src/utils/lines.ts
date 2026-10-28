// src/utils/lines.ts
//
// Line counting for quota accounting (SYN-315). Counts lines the way `wc -l`
// does for a well-formed file, plus a final line that has no trailing
// newline: "a\nb\n" and "a\nb" are both 2 lines, "" is 0. The text is already
// in memory when we call this, so it is one pass over the string, no I/O.

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  let i = text.indexOf("\n");
  while (i !== -1) {
    n++;
    i = text.indexOf("\n", i + 1);
  }
  if (text[text.length - 1] !== "\n") n++;
  return n;
}
