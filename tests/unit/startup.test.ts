import { describe, expect, it } from "vitest";
import { getStartupMessage } from "../../src/index.js";

describe("getStartupMessage", () => {
  it("returns the startup message", () => {
    expect(getStartupMessage()).toBe(
      "MiniHarness is ready."
    );
  });
});