import { Agent } from "./agent/agent.js";
import {
  OpenAICompatibleProvider,
} from "./model/http-provider.js";
import type { ToolDefinition } from "./model/types.js";
import { ToolRegistry } from "./tools/registry.js";
import {
  registerFileSystemTools,
} from "./tools/filesystem.js";

async function main(): Promise<void> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseURL = process.env.LLM_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim();

  if (!apiKey || !baseURL || !model) {
    throw new Error(
      "Missing LLM_API_KEY, LLM_BASE_URL, or LLM_MODEL.",
    );
  }

  // The current working directory is the workspace boundary.
  const workspaceRoot = process.cwd();

  const registry = new ToolRegistry();

  // Register our own read-only filesystem tools.
  await registerFileSystemTools(
    registry,
    workspaceRoot,
  );

  // Keep echo as a small diagnostic tool.
  const echoDefinition: ToolDefinition = {
    type: "function",
    function: {
      name: "echo",
      description: "Return the exact text provided.",
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

  registry.register(echoDefinition, (args) => {
    if (typeof args.text !== "string") {
      throw new Error("text must be a string.");
    }

    return args.text;
  });

  const provider = new OpenAICompatibleProvider({
    apiKey,
    baseURL,
    model,
  });

  const agent = new Agent(provider, registry, {
    maxSteps: 6,
    systemPrompt: [
      "You are MiniHarness, a coding agent.",
      "You can inspect the workspace using the available tools.",
      "Use list_directory to discover files when necessary.",
      "Use read_file to inspect source code before explaining it.",
      "Use workspace-relative paths only.",
      "Never claim to have read a file unless a tool returned its contents.",
      "Do not modify files or execute shell commands.",
      "Give a concise, evidence-based answer based on actual tool results.",
    ].join(" "),
  });

  const task =
    process.argv.slice(2).join(" ").trim() ||
    "Inspect src/agent/agent.ts using read_file. " +
      "Explain how the Agent Loop works, including model calls, " +
      "tool execution, message history, and stopping conditions.";

  console.log(`\n[workspace] ${workspaceRoot}`);
  console.log(`[task] ${task}`);

  console.log(
    "\n[available tools]",
    registry.getDefinitions().map(
      (tool) => tool.function.name,
    ).join(", "),
  );

  const result = await agent.run(task);

  for (const message of result.messages) {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        console.log(
          `\n[tool call] ${call.function.name}`,
          call.function.arguments,
        );
      }

      if (message.content) {
        console.log(`\n[assistant] ${message.content}`);
      }
    }

    if (message.role === "tool") {
      console.log(
        `\n[tool result: ${message.tool_call_id}]`,
        message.content,
      );
    }
  }

  console.log(
    `\n[status] ${result.status}; model steps: ${result.steps}`,
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error);

  console.error("\n[agent error]", message);
  process.exitCode = 1;
});