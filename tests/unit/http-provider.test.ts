import { describe, expect, it } from "vitest";

import {
  OpenAICompatibleProvider,
} from "../../src/model/http-provider.js";

import type {
  ToolDefinition,
} from "../../src/model/types.js";

describe("OpenAICompatibleProvider", () => {
  it("builds requests and parses tool calls", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    const fakeFetch: typeof fetch = async (
      input,
      init,
    ) => {
      capturedUrl = String(input);
      capturedInit = init;

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_001",
                    type: "function",
                    function: {
                      name: "echo",
                      arguments: '{"text":"hello"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    };

    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseURL: "https://example.test/v1/",
      model: "test-model",
      fetchImpl: fakeFetch,
    });

    const tool: ToolDefinition = {
      type: "function",
      function: {
        name: "echo",
        description: "Return text.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
      },
    };

    const result = await provider.complete(
      [{ role: "user", content: "Say hello." }],
      [tool],
    );

    expect(capturedUrl).toBe(
      "https://example.test/v1/chat/completions",
    );

    expect(capturedInit?.method).toBe("POST");

    expect(capturedInit?.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });

    const requestBody = JSON.parse(
      String(capturedInit?.body),
    ) as {
      model: string;
      messages: unknown[];
      tools: ToolDefinition[];
      tool_choice: string;
    };

    expect(requestBody.model).toBe("test-model");
    expect(requestBody.tools).toEqual([tool]);
    expect(requestBody.tool_choice).toBe("auto");

    expect(result.role).toBe("assistant");
    expect(result.tool_calls?.[0]?.id).toBe("call_001");
    expect(result.tool_calls?.[0]?.function.name).toBe(
      "echo",
    );
    expect(
      result.tool_calls?.[0]?.function.arguments,
    ).toBe('{"text":"hello"}');
  });

  it("reports HTTP errors without hiding the status", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Invalid API key",
          },
        }),
        { status: 401 },
      );

    const provider = new OpenAICompatibleProvider({
      apiKey: "invalid-test-key",
      baseURL: "https://example.test/v1",
      model: "test-model",
      fetchImpl: fakeFetch,
    });

    await expect(
      provider.complete([
        { role: "user", content: "Hello" },
      ]),
    ).rejects.toThrow(
      "Model API request failed (401): Invalid API key",
    );
  });
});