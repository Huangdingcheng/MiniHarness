import type { ToolDefinition } from "../model/types.js";

export type ToolHandler = (
  args: Record<string, unknown>,
) => string | Promise<string>;

type RegisteredTool = {
  definition: ToolDefinition;
  handler: ToolHandler;
};

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(
    definition: ToolDefinition,
    handler: ToolHandler,
  ): void {
    const name = definition.function.name;

    if (!name.trim()) {
      throw new Error("Tool name cannot be empty.");
    }

    if (this.tools.has(name)) {
      throw new Error(`Tool already registered: ${name}`);
    }

    this.tools.set(name, { definition, handler });
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(
      this.tools.values(),
      (tool) => tool.definition,
    );
  }

  async execute(
    name: string,
    rawArguments: string,
  ): Promise<string> {
    const tool = this.tools.get(name);

    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    let args: unknown;

    try {
      args = JSON.parse(rawArguments) as unknown;
    } catch {
      throw new Error(
        `Invalid JSON arguments for tool "${name}".`,
      );
    }

    if (
      typeof args !== "object" ||
      args === null ||
      Array.isArray(args)
    ) {
      throw new Error(
        `Arguments for tool "${name}" must be a JSON object.`,
      );
    }

    return await tool.handler(
      args as Record<string, unknown>,
    );
  }
}