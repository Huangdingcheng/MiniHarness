import { describe, expect, it } from "vitest";

import { buildLineDiff } from "../../src/runtime/diff-display.js";

describe("DiffDisplay", () => {
  it("shows unchanged, removed, and added lines", () => {
    const diff = buildLineDiff(
      ["function greet() {", '  return "Hello";', "}"].join("\n"),
      ["function greet() {", '  return "Hello, Agent!";', "}"].join("\n"),
    );

    expect(diff).toEqual([
      "  function greet() {",
      '-   return "Hello";',
      '+   return "Hello, Agent!";',
      "  }",
    ]);
  });

  it("returns an empty diff for identical text", () => {
    expect(
      buildLineDiff("line one\nline two\n", "line one\nline two\n"),
    ).toEqual([]);
  });

  it("handles a newly created file", () => {
    expect(buildLineDiff("", "first line\nsecond line\n")).toEqual([
      "+ first line",
      "+ second line",
    ]);
  });

  it("handles a deleted file", () => {
    expect(buildLineDiff("first line\nsecond line\n", "")).toEqual([
      "- first line",
      "- second line",
    ]);
  });

  it("normalizes Windows and Unix line endings", () => {
    expect(buildLineDiff("hello\r\nworld\r\n", "hello\nworld\n")).toEqual([]);
  });
});
