/**
 * 模型请求执行的工具。
 * 注意：这只是模型提出的请求，还没有真正执行。
 */
export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

/**
 * 一轮对话中的不同消息类型。
 */
export type SystemMessage = {
  role: "system";
  content: string;
};

export type UserMessage = {
  role: "user";
  content: string;
};

export type AssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
};

export type ToolMessage = {
  role: "tool";
  content: string;
  tool_call_id: string;
};

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

/**
 * 告诉模型有哪些工具可供调用。
 * parameters 使用 JSON Schema 描述参数结构。
 */
export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * 所有模型适配器必须遵守的统一接口。
 */
export interface ModelProvider {
  complete(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
  ): Promise<AssistantMessage>;
}
