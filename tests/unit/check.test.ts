import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  registerCheckTool,
} from "../../src/tools/check.js";

describe("CheckTool", () => {
  async function createRegistry(): Promise<ToolRegistry> {
    const registry = new ToolRegistry();

    await registerCheckTool(
      registry,
      process.cwd(),
    );

    return registry;
  }

  it("rejects unsupported commands", async () => {
    const registry = await createRegistry();

    await expect(
      registry.execute(
        "run_check",
        JSON.stringify({
          check: "powershell",
        }),
      ),
    ).rejects.toThrow(
      "Unsupported check. Allowed values: typecheck, test.",
    );
  });

  it("rejects shell injection attempts", async () => {
    const registry = await createRegistry();

    await expect(
      registry.execute(
        "run_check",
        JSON.stringify({
          check: "test && del .env",
        }),
      ),
    ).rejects.toThrow(
      "Unsupported check. Allowed values: typecheck, test.",
    );
  });
});