import type {
  AssistantMessage,
  ChatMessage,
  ModelProvider,
} from "../model/types.js";

import { ToolRegistry } from "../tools/registry.js";

export type AgentEvent =
  | {
      type: "run_started";
      timestamp: string;
      taskLength: number;
    }
  | {
      type: "model_request";
      timestamp: string;
      step: number;
      messageCount: number;
      toolCount: number;
    }
  | {
      type: "model_response";
      timestamp: string;
      step: number;
      hasText: boolean;
      toolCalls: Array<{
        id: string;
        name: string;
      }>;
    }
  | {
      type: "model_error";
      timestamp: string;
      step: number;
      message: string;
    }
  | {
      type: "tool_started";
      timestamp: string;
      step: number;
      callId: string;
      toolName: string;
    }
  | {
      type: "tool_finished";
      timestamp: string;
      step: number;
      callId: string;
      toolName: string;
      ok: boolean;
      resultLength: number;
      durationMs: number;
    }
  | {
      type: "run_finished";
      timestamp: string;
      status: "completed" | "max_steps" | "failed";
      steps: number;
    };

export type AgentRunResult = {
  status: "completed" | "max_steps";
  finalMessage: string;
  steps: number;
  messages: ChatMessage[];
};

export type AgentOptions = {
  systemPrompt?: string;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
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
  private readonly onEvent:
    | ((event: AgentEvent) => void)
    | undefined;

  constructor(
    private readonly provider: ModelProvider,
    private readonly registry: ToolRegistry,
    options: AgentOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? 10;

    this.systemPrompt =
      options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    this.onEvent = options.onEvent;

    if (
      !Number.isInteger(this.maxSteps) ||
      this.maxSteps < 1
    ) {
      throw new Error(
        "maxSteps must be a positive integer.",
      );
    }
  }

  private emit(event: AgentEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // Observability failures must not break task execution.
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

    this.emit({
      type: "run_started",
      timestamp: new Date().toISOString(),
      taskLength: task.length,
    });

    let currentStep = 0;

    try {
      for (
        let step = 1;
        step <= this.maxSteps;
        step += 1
      ) {

        // 必须在调用模型之前更新
        currentStep = step;

        const definitions = this.registry.getDefinitions();

        this.emit({
          type: "model_request",
          timestamp: new Date().toISOString(),
          step,
          messageCount: messages.length,
          toolCount: definitions.length,
        });

        let assistant: AssistantMessage;

        try {
          assistant = await this.provider.complete(
            messages,
            definitions,
          );
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message
              : String(error);

          this.emit({
            type: "model_error",
            timestamp: new Date().toISOString(),
            step,
            message: reason,
          });

          throw error;
        }

        messages.push(assistant);

        const toolCalls = assistant.tool_calls ?? [];

        this.emit({
          type: "model_response",
          timestamp: new Date().toISOString(),
          step,
          hasText: Boolean(assistant.content),
          toolCalls: toolCalls.map((call) => ({
            id: call.id,
            name: call.function.name,
          })),
        });

        // No tool calls means the model has finished.
        if (toolCalls.length === 0) {
          const result: AgentRunResult = {
            status: "completed",
            finalMessage: assistant.content ?? "",
            steps: step,
            messages,
          };

          this.emit({
            type: "run_finished",
            timestamp: new Date().toISOString(),
            status: result.status,
            steps: result.steps,
          });

          return result;
        }

        for (const call of toolCalls) {
          const startedAt = Date.now();

          this.emit({
            type: "tool_started",
            timestamp: new Date().toISOString(),
            step,
            callId: call.id,
            toolName: call.function.name,
          });

          let content: string;
          let ok = true;

          try {
            content = await this.registry.execute(
              call.function.name,
              call.function.arguments,
            );
          } catch (error) {
            ok = false;

            const reason =
              error instanceof Error
                ? error.message
                : String(error);

            content = `Tool execution failed: ${reason}`;
          }

          this.emit({
            type: "tool_finished",
            timestamp: new Date().toISOString(),
            step,
            callId: call.id,
            toolName: call.function.name,
            ok,
            resultLength: content.length,
            durationMs: Date.now() - startedAt,
          });

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content,
          });
        }
      }
    } catch (error) {
      this.emit({
        type: "run_finished",
        timestamp: new Date().toISOString(),
        status: "failed",
        steps: currentStep,
      });

      throw error;
    }


    const result: AgentRunResult = {
      status: "max_steps",
      finalMessage:
        `Stopped: reached the maximum of ${this.maxSteps} model steps.`,
      steps: this.maxSteps,
      messages,
    };

    this.emit({
      type: "run_finished",
      timestamp: new Date().toISOString(),
      status: result.status,
      steps: result.steps,
    });

    return result;
  }
}