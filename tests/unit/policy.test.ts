import { describe, expect, it } from "vitest";

import {
  getToolPolicyDecision,
} from "../../src/tools/policy.js";

describe("ToolPolicy", () => {
  it("automatically allows read-only tools", () => {
    expect(
      getToolPolicyDecision("read_file"),
    ).toBe("allow");

    expect(
      getToolPolicyDecision("search_files"),
    ).toBe("allow");

    expect(
      getToolPolicyDecision("list_directory"),
    ).toBe("allow");
  });

  it("requires approval for writes and checks", () => {
    expect(
      getToolPolicyDecision("edit_file"),
    ).toBe("ask");

    expect(
      getToolPolicyDecision("write_file"),
    ).toBe("ask");

    expect(
      getToolPolicyDecision("run_check"),
    ).toBe("ask");
  });

  it("denies unknown tools", () => {
    expect(
      getToolPolicyDecision("execute_arbitrary_command"),
    ).toBe("deny");
  });
});