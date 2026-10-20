
import { describe, expect, it } from "vitest";
import { ScriptedModelProvider } from "../../src/model/scripted-provider.js";

describe("ScriptedModelProvider", () => {
  it("returns responses in order", async () => {
    const provider = new ScriptedModelProvider([
      { role: "assistant", content: "First response" },
      { role: "assistant", content: "Second response" },
    ]);

    const first = await provider.complete([
      { role: "user", content: "Hello" },
    ]);

    const second = await provider.complete([
      { role: "user", content: "Continue" },
    ]);

    expect(first.content).toBe("First response");
    expect(second.content).toBe("Second response");
  });

  it("throws when responses are exhausted", async () => {
    const provider = new ScriptedModelProvider([]);

    await expect(
      provider.complete([
        { role: "user", content: "Hello" },
      ]),
    ).rejects.toThrow(
      "No scripted model response configured for call 1.",
    );
  });
});