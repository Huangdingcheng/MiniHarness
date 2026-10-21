import type {
  AssistantMessage,
  ChatMessage,
  ModelProvider,
  ToolCall,
  ToolDefinition,
} from "./types.js";

type HttpProviderOptions = {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * 只发送当前协议需要的字段。
 * 避免内部状态等字段意外进入 API 请求。
 */
function toWireMessage(
  message: ChatMessage,
): Record<string, unknown> {
  switch (message.role) {
    case "system":
    case "user":
      return {
        role: message.role,
        content: message.content,
      };

    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.reasoning_content !== undefined
          ? { reasoning_content: message.reasoning_content }
          : {}),
        ...(message.tool_calls
          ? { tool_calls: message.tool_calls }
          : {}),
      };

    case "tool":
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id,
      };
  }
}

export class OpenAICompatibleProvider
  implements ModelProvider
{
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly options: HttpProviderOptions,
  ) {
    if (!options.apiKey.trim()) {
      throw new Error("API key cannot be empty.");
    }

    if (!options.baseURL.trim()) {
      throw new Error("Base URL cannot be empty.");
    }

    if (!options.model.trim()) {
      throw new Error("Model name cannot be empty.");
    }

    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async complete(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): Promise<AssistantMessage> {
    const baseURL = this.options.baseURL.replace(
      /\/+$/,
      "",
    );

    const endpoint = `${baseURL}/chat/completions`;

    const requestBody = {
      model: this.options.model,
      messages: messages.map(toWireMessage),
      ...(tools && tools.length > 0
        ? {
            tools,
            tool_choice: "auto",
          }
        : {}),
    };

    let response: Response;

    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" ||
          error.name === "AbortError")
      ) {
        throw new Error(
          `Model API request timed out after ${this.timeoutMs} ms.`,
        );
      }

      const reason =
        error instanceof Error
          ? error.message
          : String(error);

      throw new Error(
        `Unable to reach model API: ${reason}`,
      );
    }

    const rawBody = await response.text();

    let payload: unknown;

    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      if (!response.ok) {
        throw new Error(
          `Model API request failed (${response.status}): ` +
            rawBody.slice(0, 500),
        );
      }

      throw new Error(
        `Model API returned invalid JSON (HTTP ${response.status}).`,
      );
    }

    if (!response.ok) {
      const errorValue = isRecord(payload)
        ? payload.error
        : undefined;

      const errorMessage =
        isRecord(errorValue) &&
        typeof errorValue.message === "string"
          ? errorValue.message
          : rawBody.slice(0, 500);

      throw new Error(
        `Model API request failed (${response.status}): ${errorMessage}`,
      );
    }

    if (!isRecord(payload)) {
      throw new Error(
        "Invalid model response: expected a JSON object.",
      );
    }

    const choices = payload.choices;

    if (
      !Array.isArray(choices) ||
      choices.length === 0 ||
      !isRecord(choices[0])
    ) {
      throw new Error(
        "Invalid model response: missing choices[0].",
      );
    }

    const rawMessage = choices[0].message;

    if (!isRecord(rawMessage)) {
      throw new Error(
        "Invalid model response: missing assistant message.",
      );
    }

    const rawContent = rawMessage.content;

    const rawReasoningContent =
      rawMessage.reasoning_content;

    let reasoningContent: string | null | undefined;

    if (
      rawReasoningContent === null ||
      typeof rawReasoningContent === "string"
    ) {
      reasoningContent = rawReasoningContent;
    } else if (rawReasoningContent !== undefined) {
      throw new Error(
        "Invalid model response: reasoning_content must be a string or null.",
      );
    }

    if (
      rawContent !== null &&
      rawContent !== undefined &&
      typeof rawContent !== "string"
    ) {
      throw new Error(
        "Invalid model response: content must be a string or null.",
      );
    }

    const content =
      typeof rawContent === "string"
        ? rawContent
        : null;

    const rawToolCalls = rawMessage.tool_calls;

    if (
      rawToolCalls !== undefined &&
      !Array.isArray(rawToolCalls)
    ) {
      throw new Error(
        "Invalid model response: tool_calls must be an array.",
      );
    }

    const toolCalls: ToolCall[] = [];
    const callItems: unknown[] = Array.isArray(
      rawToolCalls,
    )
      ? rawToolCalls
      : [];

    for (const [index, rawCall] of callItems.entries()) {
      if (!isRecord(rawCall)) {
        throw new Error(
          `Invalid tool call at index ${index}.`,
        );
      }

      const rawFunction = rawCall.function;

      if (!isRecord(rawFunction)) {
        throw new Error(
          `Missing function in tool call ${index}.`,
        );
      }

      if (
        typeof rawCall.id !== "string" ||
        typeof rawFunction.name !== "string" ||
        typeof rawFunction.arguments !== "string"
      ) {
        throw new Error(
          `Invalid fields in tool call ${index}.`,
        );
      }

      toolCalls.push({
        id: rawCall.id,
        type: "function",
        function: {
          name: rawFunction.name,
          arguments: rawFunction.arguments,
        },
      });
    }

    if (
      (content === null || content.trim() === "") &&
      toolCalls.length === 0
    ) {
      throw new Error(
        "Model response contained neither text nor tool calls.",
      );
    }

    return {
      role: "assistant",
      content,
      ...(toolCalls.length > 0
        ? { tool_calls: toolCalls }
        : {}),
      ...(reasoningContent !== undefined
        ? { reasoning_content: reasoningContent }
        : {}),
    };
  }
}