import { describe, expect, it } from "vitest";

import {
  Agent,
  type AgentEvent,
} from "../../src/agent/agent.js";

import {
  ScriptedModelProvider,
} from "../../src/model/scripted-provider.js";

import type {
  AssistantMessage,
  ChatMessage,
  ModelProvider,
  ToolCall,
  ToolDefinition,
} from "../../src/model/types.js";

import { ToolRegistry } from "../../src/tools/registry.js";

const echoDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "echo",
    description: "Return the provided text.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

const echoCall: ToolCall = {
  id: "call_001",
  type: "function",
  function: {
    name: "echo",
    arguments: JSON.stringify({ text: "hello" }),
  },
};

function createEchoRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(echoDefinition, (args) => {
    const text = args.text;

    if (typeof text !== "string") {
      throw new Error("text must be a string.");
    }

    return text;
  });

  return registry;
}

describe("Agent", () => {
  it("returns a final answer without calling tools", async () => {
    const provider = new ScriptedModelProvider([
      {
        role: "assistant",
        content: "Hello!",
      },
    ]);

    const agent = new Agent(provider, new ToolRegistry());

    const result = await agent.run("Say hello.");

    expect(result.status).toBe("completed");
    expect(result.finalMessage).toBe("Hello!");
    expect(result.steps).toBe(1);
  });

  it("executes a tool and feeds its result back to the model", async () => {
    const observedMessages: ChatMessage[][] = [];

    const provider: ModelProvider = {
      async complete(
        messages: ChatMessage[],
      ): Promise<AssistantMessage> {
        observedMessages.push([...messages]);

        if (observedMessages.length === 1) {
          return {
            role: "assistant",
            content: null,
            tool_calls: [echoCall],
          };
        }

        return {
          role: "assistant",
          content: "The tool returned: hello",
        };
      },
    };

    const agent = new Agent(
      provider,
      createEchoRegistry(),
    );

    const result = await agent.run(
      "Use the echo tool and report its result.",
    );

    expect(result.status).toBe("completed");
    expect(result.finalMessage).toBe(
      "The tool returned: hello",
    );

    const toolMessage = observedMessages[1]?.find(
      (message) => message.role === "tool",
    );

    expect(toolMessage?.content).toBe("hello");
    expect(result.steps).toBe(2);
  });

  it("returns tool errors to the model", async () => {
    const provider = new ScriptedModelProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_missing",
            type: "function",
            function: {
              name: "missing_tool",
              arguments: "{}",
            },
          },
        ],
      },
      {
        role: "assistant",
        content: "The tool was unavailable.",
      },
    ]);

    const agent = new Agent(provider, new ToolRegistry());

    const result = await agent.run(
      "Try the requested tool.",
    );

    const toolMessage = result.messages.find(
      (message) => message.role === "tool",
    );

    expect(toolMessage?.content).toContain(
      "Unknown tool: missing_tool",
    );

    expect(result.finalMessage).toBe(
      "The tool was unavailable.",
    );
  });

  it("stops when maxSteps is reached", async () => {
    const provider = new ScriptedModelProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [echoCall],
      },
    ]);

    const agent = new Agent(
      provider,
      createEchoRegistry(),
      { maxSteps: 1 },
    );

    const result = await agent.run("Echo hello.");

    expect(result.status).toBe("max_steps");
    expect(result.steps).toBe(1);
    expect(result.messages.some(
      (message) => message.role === "tool",
    )).toBe(true);
  });
  
  it("emits lifecycle events in execution order", async () => {
    const events: AgentEvent[] = [];

    const provider = new ScriptedModelProvider([
      {
        role: "assistant",
        content: null,
        tool_calls: [echoCall],
      },
      {
        role: "assistant",
        content: "The tool returned hello.",
      },
    ]);

    const agent = new Agent(
      provider,
      createEchoRegistry(),
      {
        maxSteps: 5,
        onEvent: (event) => events.push(event),
      },
    );

    const result = await agent.run(
      "Call echo and report its result.",
    );

    expect(result.status).toBe("completed");

    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "model_request",
      "model_response",
      "tool_started",
      "tool_finished",
      "model_request",
      "model_response",
      "run_finished",
    ]);

    const toolFinished = events.find(
      (event) => event.type === "tool_finished",
    );

    expect(toolFinished?.type).toBe("tool_finished");

    if (toolFinished?.type === "tool_finished") {
      expect(toolFinished.ok).toBe(true);
      expect(toolFinished.resultLength).toBe(5);
    }
  });
  
  it("emits run_finished when the model request fails", async () => {
    const events: AgentEvent[] = [];

    const failingProvider: ModelProvider = {
      async complete() {
        throw new Error("simulated model failure");
      },
    };

    const agent = new Agent(
      failingProvider,
      new ToolRegistry(),
      {
        maxSteps: 3,
        onEvent: (event) => events.push(event),
      },
    );

    await expect(
      agent.run("Test a failing model request."),
    ).rejects.toThrow("simulated model failure");

    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "model_request",
      "model_error",
      "run_finished",
    ]);

    const finalEvent = events[events.length - 1];

    expect(finalEvent?.type).toBe("run_finished");

    if (finalEvent?.type === "run_finished") {
      expect(finalEvent.status).toBe("failed");
      expect(finalEvent.steps).toBe(1);
    }
  });

});