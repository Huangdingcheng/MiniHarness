import type {
  AssistantMessage,
  ChatMessage,
  ModelProvider,
  ToolDefinition,
} from "./types.js";

/**
 * 用预设的模型响应模拟真实模型。
 * 主要用于测试 Agent Loop 和工具调度。
 */
export class ScriptedModelProvider implements ModelProvider {
  private cursor = 0;

  constructor(
    private readonly responses: AssistantMessage[],
  ) {}

  async complete(
    _messages: ChatMessage[],
    _tools?: ToolDefinition[],
  ): Promise<AssistantMessage> {
    const response = this.responses[this.cursor];

    if (response === undefined) {
      throw new Error(
        `No scripted model response configured for call ${this.cursor + 1}.`,
      );
    }

    this.cursor += 1;
    return response;
  }
}