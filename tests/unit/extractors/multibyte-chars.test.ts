// tests/unit/extractors/multibyte-chars.test.ts
//
// Regression test for the UTF-8/UTF-16 offset mismatch that corrupted every
// identifier extracted after a multi-byte character.
//
// tree-sitter reports startIndex/endIndex in UTF-16 code units (JS string
// indexes). If any consumer slices a UTF-8 Buffer with those indexes, an
// em-dash (3 UTF-8 bytes, 1 UTF-16 unit) earlier in the file shifts every
// downstream identifier LEFT by 2 characters — enough to turn
// `get_user_by_id` into `f get_user_by_`.
//
// This test parses a file with several multi-byte chars in docstrings and
// asserts that function names come out intact.

import { describe, expect, it } from "vitest";
import { parsePythonFile } from "../../../src/extractors/languages/python-parse.js";

describe("python extractor — multi-byte character handling", () => {
  it("extracts function names correctly when docstrings contain em-dashes", () => {
    const src = [
      '"""Header — with an em-dash."""',
      "",
      "def get_user_by_id(user_id: str) -> dict:",
      '    """Retrieve a user by id — one em-dash here too."""',
      "    return {}",
      "",
      "def list_users(limit: int = 10) -> list:",
      '    """List users."""',
      "    return []",
      "",
    ].join("\n");

    const result = parsePythonFile({
      source: src,
      relPath: "app/users.py",
      module: "app.users",
    });

    expect(result.parseOk).toBe(true);
    const names = result.functions.map((f) => f.qualname);
    expect(names).toEqual(["get_user_by_id", "list_users"]);
  });

  it("extracts names correctly with a variety of multi-byte chars", () => {
    const src = [
      '"""Docs with em-dash — en-dash – curly quotes “hi” and emoji 🙂."""',
      "",
      "def alpha_beta_gamma(x: str) -> str:",
      '    """One line."""',
      "    return x",
      "",
      "def another_function(y: int) -> int:",
      "    return y",
      "",
    ].join("\n");

    const result = parsePythonFile({
      source: src,
      relPath: "app/mixed.py",
      module: "app.mixed",
    });

    expect(result.parseOk).toBe(true);
    const names = result.functions.map((f) => f.qualname);
    expect(names).toEqual(["alpha_beta_gamma", "another_function"]);
  });

  it("preserves pure-ASCII behavior unchanged", () => {
    const src = [
      '"""Plain ASCII docs."""',
      "",
      "def send_notification(recipient: str, message: str) -> dict:",
      '    """Send a notification to a recipient."""',
      "    return {}",
      "",
    ].join("\n");

    const result = parsePythonFile({
      source: src,
      relPath: "app/notifications.py",
      module: "app.notifications",
    });

    expect(result.parseOk).toBe(true);
    expect(result.functions.map((f) => f.qualname)).toEqual(["send_notification"]);
  });
});
