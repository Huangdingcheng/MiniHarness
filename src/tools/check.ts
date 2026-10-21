import { runProcess } from "../runtime/process.js";

import { realpath, stat } from "node:fs/promises";

import type { ToolDefinition } from "../model/types.js";
import { ToolRegistry } from "./registry.js";

const MAX_OUTPUT_CHARS = 10_000;
const DEFAULT_TIMEOUT_MS = 120_000;

type CheckName = "typecheck" | "test";

const checkDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "run_check",
    description:
      "Run a predefined project validation command. " +
      "Supported checks are 'typecheck' and 'test'. " +
      "Returns the actual process output and exit status.",
    parameters: {
      type: "object",
      properties: {
        check: {
          type: "string",
          enum: ["typecheck", "test"],
          description:
            "Use 'typecheck' for TypeScript checking, " +
            "or 'test' for the automated test suite.",
        },
      },
      required: ["check"],
      additionalProperties: false,
    },
  },
};

export async function registerCheckTool(
  registry: ToolRegistry,
  workspaceRoot: string = process.cwd(),
): Promise<void> {
  const root = await realpath(workspaceRoot);
  const info = await stat(root);

  if (!info.isDirectory()) {
    throw new Error("Workspace root must be a directory.");
  }

  registry.register(checkDefinition, async (args) => {
    const check = args.check;

    // 1. 校验模型请求，只允许两种检查任务
    if (check !== "typecheck" && check !== "test") {
      throw new Error(
        "Unsupported check. Allowed values: typecheck, test.",
      );
    }

    // 2. 根据操作系统选择固定命令
    // 不允许模型提供任意命令字符串
    const command =
      check === "typecheck"
        ? "pnpm typecheck"
        : "pnpm test";

    // 3. 委托统一 Runtime 管理子进程
    const result =
      process.platform === "win32"
        ? await runProcess({
            command: "cmd.exe",
            args: ["/d", "/s", "/c", command],
            cwd: root,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            maxOutputChars: MAX_OUTPUT_CHARS,
          })
        : await runProcess({
            command: "pnpm",
            args: [check],
            cwd: root,
            timeoutMs: DEFAULT_TIMEOUT_MS,
            maxOutputChars: MAX_OUTPUT_CHARS,
          });

    // 4. 根据真实退出状态判断结果
    const status = result.timedOut
      ? "TIMEOUT"
      : result.exitCode === 0
        ? "PASS"
        : "FAIL";

    const sections = [
      `Check: ${check}`,
      `Status: ${status}`,
      `Exit code: ${result.exitCode ?? "null"}`,
    ];

    if (result.signal) {
      sections.push(`Signal: ${result.signal}`);
    }

    sections.push(
      "",
      "STDOUT:",
      result.stdout || "(empty)",
      "",
      "STDERR:",
      result.stderr || "(empty)",
    );

    if (
      result.stdoutTruncated ||
      result.stderrTruncated
    ) {
      sections.push(
        "",
        "[Output truncated to protect model context.]",
      );
    }

    if (result.timedOut) {
      sections.push(
        "",
        "The check exceeded the time limit.",
      );
    }

    // 5. 将执行结果返回给 Agent
    return sections.join("\n");
  });
}