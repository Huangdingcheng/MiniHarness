import type {
  ChatMessage,
  ModelProvider,
} from "../model/types.js";

import { ToolRegistry } from "../tools/registry.js";

export type AgentRunResult = {
  status: "completed" | "max_steps";
  finalMessage: string;
  steps: number;
  messages: ChatMessage[];
};

export type AgentOptions = {
  systemPrompt?: string;
  maxSteps?: number;
};

const DEFAULT_SYSTEM_PROMPT = `
You are MiniHarness, an AI agent that solves tasks.
Use available tools when necessary.
Observe tool results before deciding what to do next.
Provide a final answer when the task is complete.
`.trim();

export class Agent {
  private readonly maxSteps: number;
  private readonly systemPrompt: string;

  constructor(
    private readonly provider: ModelProvider,
    private readonly registry: ToolRegistry,
    options: AgentOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? 10;
    this.systemPrompt =
      options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    if (
      !Number.isInteger(this.maxSteps) ||
      this.maxSteps < 1
    ) {
      throw new Error(
        "maxSteps must be a positive integer.",
      );
    }
  }

  async run(task: string): Promise<AgentRunResult> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: this.systemPrompt,
      },
      {
        role: "user",
        content: task,
      },
    ];

    for (
      let step = 1;
      step <= this.maxSteps;
      step += 1
    ) {
      // 1. Ask the model to decide the next action.
      const assistant = await this.provider.complete(
        messages,
        this.registry.getDefinitions(),
      );

      // 2. Preserve the model's response in history.
      messages.push(assistant);

      const toolCalls = assistant.tool_calls ?? [];

      // 3. No tool calls means the model has finished.
      if (toolCalls.length === 0) {
        return {
          status: "completed",
          finalMessage: assistant.content ?? "",
          steps: step,
          messages,
        };
      }

      // 4. Execute requested tools and collect results.
      for (const call of toolCalls) {
        let content: string;

        try {
          content = await this.registry.execute(
            call.function.name,
            call.function.arguments,
          );
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message
              : String(error);

          content = `Tool execution failed: ${reason}`;
        }

        // 5. Link each result to its original tool call.
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content,
        });
      }
    }

    // 6. Stop instead of running indefinitely.
    return {
      status: "max_steps",
      finalMessage:
        `Stopped: reached the maximum of ${this.maxSteps} model steps.`,
      steps: this.maxSteps,
      messages,
    };
  }
}