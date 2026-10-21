import {
  createTraceWriter,
} from "./observability/trace-writer.js";
import {
  Agent,
  type AgentEvent,
} from "./agent/agent.js";
import {
  OpenAICompatibleProvider,
} from "./model/http-provider.js";
import type { ToolDefinition } from "./model/types.js";
import { ToolRegistry } from "./tools/registry.js";
import {
  registerFileSystemTools,
} from "./tools/filesystem.js";
import { registerCheckTool } from "./tools/check.js";

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

  const traceWriter = createTraceWriter(workspaceRoot);

  console.log(`[trace file] ${traceWriter.filePath}`);

  const registry = new ToolRegistry();

  // Register our own read-only filesystem tools.
  await registerFileSystemTools(
    registry,
    workspaceRoot,
  );

  await registerCheckTool(
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
      "Only modify files when the user explicitly requests changes. " +
      "Before editing, read the target file and use edit_file with exact text. " +
      "Never modify files for read-only questions. " +
      "You may use run_check to validate code changes. " +
      "Use typecheck for TypeScript errors and test for automated tests. " +
      "Never claim a check passed unless its actual output confirms success. " +
      "Do not attempt arbitrary shell commands.",
      "Give a concise, evidence-based answer based on actual tool results.",
      "When a validation check fails, inspect the actual output " +
      "and identify the cause before editing. " +
      "Make a targeted fix, then rerun the relevant check. " +
      "Continue fixing failures until the check passes or " +
      "the maximum step limit is reached. " +
      "Do not modify test files unless the user explicitly asks. " +
      "Report validation results based on actual tool output."
    ].join(" "),
    
    onEvent: (event: AgentEvent) => {
      try {
        traceWriter.write(event);
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message
            : String(error);

        console.error(`[trace persistence error] ${reason}`);
      }
      
      switch (event.type) {
        case "run_started":
          console.log(
            `\n[trace] run_started task_chars=${event.taskLength}`,
          );
          break;

        case "model_request":
          console.log(
            `[trace] model_request step=${event.step} ` +
            `messages=${event.messageCount} ` +
            `tools=${event.toolCount}`,
          );
          break;

        case "model_response": {
          const names = event.toolCalls
            .map((call) => call.name)
            .join(", ");

          console.log(
            `[trace] model_response step=${event.step} ` +
            `tool_calls=${names || "none"} ` +
            `has_text=${event.hasText}`,
          );
          break;
        }

        case "model_error":
          console.error(
            `[trace] model_error step=${event.step}: ${event.message}`,
          );
          break;

        case "tool_started":
          console.log(
            `[trace] tool_started step=${event.step} ` +
            `name=${event.toolName} call=${event.callId}`,
          );
          break;

        case "tool_finished":
          console.log(
            `[trace] tool_finished name=${event.toolName} ` +
            `ok=${event.ok} duration_ms=${event.durationMs} ` +
            `result_chars=${event.resultLength}`,
          );
          break;

        case "run_finished":
          console.log(
            `[trace] run_finished status=${event.status} ` +
            `steps=${event.steps}`,
          );
          break;
      }
    },

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