import {
  inspectWorkspaceWriteback,
} from "./runtime/writeback-check.js";

import {
  applyWorkspaceChanges,
} from "./runtime/writeback.js";

import os from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";

import {
  getWorkspaceChanges,
} from "./runtime/diff.js";

import {
  renderWorkspaceChanges,
} from "./runtime/diff-display.js";

import {
  createSandboxWorkspace,
} from "./runtime/workspace.js";

import {
  runProcess,
} from "./runtime/process.js";

import { createInterface } from "node:readline/promises";

import {
  getToolPolicyDecision,
} from "./tools/policy.js";

import type {
  ToolAuthorizationRequest,
} from "./agent/agent.js";
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

async function prepareSandboxDependencies(
  workspaceRoot: string,
): Promise<void> {
  console.log(
    "[sandbox] Preparing dependencies...",
  );

  const isWindows = process.platform === "win32";

  const result = await runProcess({
    command: isWindows ? "cmd.exe" : "pnpm",

    args: isWindows
      ? [
          "/d",
          "/s",
          "/c",
          "pnpm install --frozen-lockfile --ignore-scripts",
        ]
      : [
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
        ],

    cwd: workspaceRoot,
    timeoutMs: 120_000,
    maxOutputChars: 8_000,
  });

  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(
      [
        "Sandbox dependency preparation failed.",
        `Exit code: ${result.exitCode ?? "null"}`,
        `Timed out: ${result.timedOut}`,
        "",
        "STDOUT:",
        result.stdout || "(empty)",
        "",
        "STDERR:",
        result.stderr || "(empty)",
      ].join("\n"),
    );
  }

  console.log("[sandbox] Dependencies ready.");
}

function previewValue(value: unknown): string {
  if (typeof value !== "string") {
    return String(value ?? "(missing)");
  }

  return value
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

async function authorizeToolCall(
  request: ToolAuthorizationRequest,
): Promise<boolean> {
  const { toolName, argumentsJson } = request;
  const decision = getToolPolicyDecision(toolName);

  if (decision === "allow") {
    console.log(`[policy] auto-allowed: ${toolName}`);
    return true;
  }

  if (decision === "deny") {
    console.error(`[policy] blocked unknown tool: ${toolName}`);
    return false;
  }

  let args: Record<string, unknown> = {};

  try {
    const parsed: unknown = JSON.parse(argumentsJson);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    console.error(
      `[policy] blocked invalid arguments: ${toolName}`,
    );
    return false;
  }

  let summary = "";

  if (toolName === "edit_file") {
    summary = [
      `Path: ${previewValue(args.path)}`,
      `Old text: ${previewValue(args.old_text)}`,
      `New text: ${previewValue(args.new_text)}`,
    ].join("\n");
  } else if (toolName === "run_check") {
    summary = `Check: ${previewValue(args.check)}`;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      `\n[approval required]\n` +
      `Tool: ${toolName}\n` +
      `${summary}\n` +
      `Approve this operation? [y/N] `,
    );

    const approved = /^y(es)?$/i.test(answer.trim());

    console.log(
      `[policy] ${approved ? "approved" : "denied"}: ${toolName}`,
    );

    return approved;
  } finally {
    rl.close();
  }
}

async function showWorkspaceDiff(
  workspaceArgument: string,
): Promise<void> {
  // 只允许查看 MiniHarness 创建的临时工作区，
  // 不允许通过 --diff 任意指定其他目录。
  const sandboxBase = await realpath(
    path.join(
      os.tmpdir(),
      "miniharness-sandboxes",
    ),
  );

  const workspaceRoot = await realpath(
    workspaceArgument,
  );

  const relative = path.relative(
    sandboxBase,
    workspaceRoot,
  );

  const isDirectSandboxChild =
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep) &&
    path.basename(workspaceRoot).startsWith("run-");

  if (!isDirectSandboxChild) {
    throw new Error(
      "The specified directory is not a valid MiniHarness sandbox.",
    );
  }

  // 必须从原始项目根目录运行 CLI。
  const sourceRoot = await realpath(
    process.cwd(),
  );

  const changes = await getWorkspaceChanges(
    sourceRoot,
    workspaceRoot,
  );

  const report = await renderWorkspaceChanges(
    sourceRoot,
    workspaceRoot,
    changes,
  );

  console.log("\n=== Workspace Diff ===");
  console.log(`Source: ${sourceRoot}`);
  console.log(`Workspace: ${workspaceRoot}`);
  console.log("");
  console.log(report);
}


async function applyWorkspaceInteractively(
  workspaceArgument: string,
): Promise<void> {
  const sandboxBase = await realpath(
    path.join(os.tmpdir(), "miniharness-sandboxes"),
  );

  const sourceRoot = await realpath(process.cwd());
  const workspaceRoot = await realpath(workspaceArgument);

  // 只允许操作 MiniHarness 创建的直接子工作区。
  const relative = path.relative(
    sandboxBase,
    workspaceRoot,
  );

  const validSandbox =
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep) &&
    path.basename(workspaceRoot).startsWith("run-");

  if (!validSandbox) {
    throw new Error(
      "Invalid MiniHarness sandbox path.",
    );
  }

  const changes = await getWorkspaceChanges(
    sourceRoot,
    workspaceRoot,
  );

  if (changes.length === 0) {
    console.log("No workspace changes to apply.");
    return;
  }

  // 展示实际差异，而不只是文件名。
  console.log("\n=== Changes for Review ===");
  console.log(
    await renderWorkspaceChanges(
      sourceRoot,
      workspaceRoot,
      changes,
    ),
  );

  // 基线、目标状态和路径安全检查。
  const checks = await inspectWorkspaceWriteback(
    sourceRoot,
    workspaceRoot,
  );

  const checkMap = new Map(
    checks.map((check) => [check.path, check]),
  );

  console.log("\n=== Preflight Results ===");

  for (const change of changes) {
    const check = checkMap.get(change.path);

    console.log(
      `[${check?.status ?? "unsafe"}] ${change.kind}: ${change.path}`,
    );

    if (check) {
      console.log(`  ${check.reason}`);
    }
  }

  const approvedPaths: string[] = [];

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    for (const change of changes) {
      const check = checkMap.get(change.path);

      if (check?.status !== "ready") {
        console.log(
          `Skipped: ${change.path} (not ready)`,
        );
        continue;
      }

      const answer = (
        await rl.question(
          `\nApply ${change.kind} "${change.path}"? [y/N] `,
        )
      ).trim().toLowerCase();

      if (answer === "y") {
        approvedPaths.push(change.path);
      } else {
        console.log(`Rejected: ${change.path}`);
      }
    }
  } finally {
    rl.close();
  }

  if (approvedPaths.length === 0) {
    console.log("\nNo changes approved.");
    return;
  }

  console.log(
    `\nApplying ${approvedPaths.length} approved change(s)...`,
  );

  const results = await applyWorkspaceChanges(
    sourceRoot,
    workspaceRoot,
    approvedPaths,
  );

  for (const result of results) {
    console.log(
      `[${result.status.toUpperCase()}] ${result.kind}: ${result.path}`,
    );
  }

  console.log("\nWriteback completed.");
}

async function main(): Promise<void> {
  const cliArgs = process.argv
    .slice(2)
    .filter((arg) => arg !== "--");

  if (cliArgs[0] === "--apply") {
    const workspaceArgument = cliArgs[1];

    if (!workspaceArgument || cliArgs.length !== 2) {
      throw new Error(
        'Usage: pnpm dev -- --apply "<workspace-path>"',
      );
    }

    await applyWorkspaceInteractively(workspaceArgument);
    return;
  }
  
  // 差异查看模式：不创建新的沙箱，也不调用模型。
  if (cliArgs[0] === "--diff") {
    const workspaceArgument = cliArgs[1];

    if (!workspaceArgument) {
      throw new Error(
        'Usage: pnpm dev -- --diff "<workspace-path>"',
      );
    }

    await showWorkspaceDiff(workspaceArgument);
    return;
  }

  const apiKey = process.env.LLM_API_KEY?.trim();
  const baseURL = process.env.LLM_BASE_URL?.trim();
  const model = process.env.LLM_MODEL?.trim();

  if (!apiKey || !baseURL || !model) {
    throw new Error(
      "Missing LLM_API_KEY, LLM_BASE_URL, or LLM_MODEL.",
    );
  }

  // The current working directory is the workspace boundary.

  const sourceRoot = process.cwd();

  const sandbox =
    await createSandboxWorkspace(sourceRoot);

  const workspaceRoot = sandbox.workspaceRoot;

  console.log(`[sandbox] Source: ${sourceRoot}`);
  console.log(`[sandbox] Workspace: ${workspaceRoot}`);

  const traceWriter = createTraceWriter(sourceRoot);

  console.log(`[trace file] ${traceWriter.filePath}`);

  const registry = new ToolRegistry();

  try {
    await prepareSandboxDependencies(workspaceRoot);
  } catch (error) {
    await sandbox.cleanup();
    throw error;
  }

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

    authorizeTool: authorizeToolCall,

  });

  const task =
    cliArgs.join(" ").trim() ||
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

  // 新增：告知用户沙箱工作区的位置，供后续检查修改
  console.log(
    `[sandbox] Workspace retained for review: ${workspaceRoot}`,
  );
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error);

  console.error("\n[agent error]", message);
  process.exitCode = 1;
});