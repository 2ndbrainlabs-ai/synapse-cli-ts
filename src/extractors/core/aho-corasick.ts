// src/extractors/core/aho-corasick.ts
//
// Minimal, dependency-free Aho-Corasick multi-pattern search over a Buffer.
// We only need "does any needle occur?" — not the positions, not the counts.
// That lets us shave the implementation down to a compact goto+fail table
// with an O(n + total_matches) scan.
//
// The prefilter builds the automaton once at startup with ~30 needles; the
// automaton is then reused for every file. Peak memory is a few KB.

// Byte code for '\0' — used as the root state marker.
const ROOT = 0;

interface Node {
  /** Byte → next state. Sparse Map to keep memory low for small alphabets. */
  next: Map<number, number>;
  /** Failure link (BFS-computed). */
  fail: number;
  /** True if any needle terminates at this state (directly or via failure). */
  match: boolean;
}

export class AhoCorasick {
  private readonly nodes: Node[] = [{ next: new Map(), fail: ROOT, match: false }];

  constructor(needles: readonly string[]) {
    for (const needle of needles) {
      if (!needle) continue;
      this.addPattern(needle);
    }
    this.buildFailureLinks();
  }

  private addPattern(pattern: string): void {
    const bytes = Buffer.from(pattern, "utf-8");
    let state = ROOT;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const next = this.nodes[state].next.get(b);
      if (next !== undefined) {
        state = next;
      } else {
        const newState = this.nodes.length;
        this.nodes.push({ next: new Map(), fail: ROOT, match: false });
        this.nodes[state].next.set(b, newState);
        state = newState;
      }
    }
    this.nodes[state].match = true;
  }

  private buildFailureLinks(): void {
    // BFS over depth-1 first.
    const queue: number[] = [];
    for (const child of this.nodes[ROOT].next.values()) {
      this.nodes[child].fail = ROOT;
      queue.push(child);
    }
    while (queue.length > 0) {
      const state = queue.shift()!;
      for (const [b, next] of this.nodes[state].next) {
        queue.push(next);
        let failState = this.nodes[state].fail;
        while (failState !== ROOT && !this.nodes[failState].next.has(b)) {
          failState = this.nodes[failState].fail;
        }
        const failNext = this.nodes[failState].next.get(b);
        this.nodes[next].fail =
          failNext !== undefined && failNext !== next ? failNext : ROOT;
        // Propagate match through the failure chain.
        if (this.nodes[this.nodes[next].fail].match) {
          this.nodes[next].match = true;
        }
      }
    }
  }

  /**
   * Return true as soon as ANY needle is seen in `buffer[0..length]`.
   * Short-circuits on first match — that's all the prefilter needs.
   */
  hasMatch(buffer: Buffer, length?: number): boolean {
    const end = length ?? buffer.length;
    let state = ROOT;
    for (let i = 0; i < end; i++) {
      const b = buffer[i];
      while (state !== ROOT && !this.nodes[state].next.has(b)) {
        state = this.nodes[state].fail;
      }
      const nxt = this.nodes[state].next.get(b);
      if (nxt !== undefined) state = nxt;
      if (this.nodes[state].match) return true;
    }
    return false;
  }
}
