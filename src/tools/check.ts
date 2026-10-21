import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";

import type { ToolDefinition } from "../model/types.js";
import { ToolRegistry } from "./registry.js";

const MAX_OUTPUT_CHARS = 10_000;
const DEFAULT_TIMEOUT_MS = 120_000;

type CheckName = "typecheck" | "test";

type CapturedOutput = {
  text: string;
  truncated: boolean;
};

function appendCapped(
  current: CapturedOutput,
  chunk: Buffer | string,
): CapturedOutput {
  const incoming = chunk.toString();
  const remaining = MAX_OUTPUT_CHARS - current.text.length;

  if (remaining <= 0) {
    return {
      ...current,
      truncated: true,
    };
  }

  if (incoming.length > remaining) {
    return {
      text: current.text + incoming.slice(0, remaining),
      truncated: true,
    };
  }

  return {
    text: current.text + incoming,
    truncated: current.truncated,
  };
}

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

    if (check !== "typecheck" && check !== "test") {
      throw new Error(
        "Unsupported check. Allowed values: typecheck, test.",
      );
    }

    // Never interpolate model-supplied strings into a shell command.
    const command =
      check === "typecheck"
        ? "pnpm typecheck"
        : "pnpm test";

    const stdout: CapturedOutput = {
      text: "",
      truncated: false,
    };

    const stderr: CapturedOutput = {
      text: "",
      truncated: false,
    };

    let timedOut = false;

    return await new Promise<string>((resolve, reject) => {
      // On Windows, pnpm is commonly exposed as pnpm.cmd.
      // cmd.exe is used only with one of the two fixed commands above.
      const child =
        process.platform === "win32"
          ? spawn(
              "cmd.exe",
              ["/d", "/s", "/c", command],
              {
                cwd: root,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
              },
            )
          : spawn(
              "pnpm",
              [check],
              {
                cwd: root,
                stdio: ["ignore", "pipe", "pipe"],
              },
            );

      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, DEFAULT_TIMEOUT_MS);

      const finish = (
        callback: () => void,
      ): void => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        callback();
      };

      child.stdout?.on("data", (chunk: Buffer | string) => {
        const captured = appendCapped(stdout, chunk);
        stdout.text = captured.text;
        stdout.truncated = captured.truncated;
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        const captured = appendCapped(stderr, chunk);
        stderr.text = captured.text;
        stderr.truncated = captured.truncated;
      });

      child.on("error", (error) => {
        finish(() => {
          reject(
            new Error(
              `Unable to start check "${check}": ${error.message}`,
            ),
          );
        });
      });

      child.on("close", (code, signal) => {
        finish(() => {
          const status = timedOut
            ? "TIMEOUT"
            : code === 0
              ? "PASS"
              : "FAIL";

          const sections = [
            `Check: ${check}`,
            `Status: ${status}`,
            `Exit code: ${code ?? "null"}`,
          ];

          if (signal) {
            sections.push(`Signal: ${signal}`);
          }

          sections.push(
            "",
            "STDOUT:",
            stdout.text || "(empty)",
            "",
            "STDERR:",
            stderr.text || "(empty)",
          );

          if (stdout.truncated || stderr.truncated) {
            sections.push(
              "",
              "[Output truncated to protect model context.]",
            );
          }

          if (timedOut) {
            sections.push(
              "",
              "The check exceeded the time limit.",
            );
          }

          resolve(sections.join("\n"));
        });
      });
    });
  });
}