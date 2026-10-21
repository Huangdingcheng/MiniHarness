// 执行和管理进程，check.ts判断允许执行什么命令
import {
  spawn,
  type ChildProcess,
} from "node:child_process";

export type RunProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputChars?: number;
};

export type RunProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

type CapturedOutput = {
  text: string;
  truncated: boolean;
};

function appendCapped(
  current: CapturedOutput,
  chunk: Buffer | string,
  limit: number,
): CapturedOutput {
  const incoming = chunk.toString();
  const remaining = limit - current.text.length;

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function terminateProcessTree(
  child: ChildProcess,
): Promise<void> {
  const pid = child.pid;

  if (pid === undefined) {
    try {
      child.kill();
    } catch {
      // The process may already have exited.
    }

    return;
  }

  if (process.platform === "win32") {
    // Windows: terminate the process and its descendants.
    await new Promise<void>((resolve) => {
      let settled = false;
      let fallbackTimer:
        | ReturnType<typeof setTimeout>
        | undefined;

      const finish = (fallback: boolean): void => {
        if (settled) {
          return;
        }

        settled = true;

        if (fallbackTimer !== undefined) {
          clearTimeout(fallbackTimer);
        }

        if (fallback) {
          try {
            child.kill();
          } catch {
            // Best-effort fallback.
          }
        }

        resolve();
      };

      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        {
          windowsHide: true,
          stdio: "ignore",
        },
      );

      fallbackTimer = setTimeout(() => {
        finish(true);
      }, 3000);

      killer.once("error", () => {
        finish(true);
      });

      killer.once("close", (code) => {
        finish(code !== 0);
      });
    });

    return;
  }

  // POSIX: spawn() uses a separate process group.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }

  // Allow a short grace period before force termination.
  await delay(250);

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}

export async function runProcess(
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputChars = options.maxOutputChars ?? 10_000;

  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new Error(
      "timeoutMs must be a positive integer.",
    );
  }

  if (
    !Number.isInteger(maxOutputChars) ||
    maxOutputChars < 1
  ) {
    throw new Error(
      "maxOutputChars must be a positive integer.",
    );
  }

  const stdout: CapturedOutput = {
    text: "",
    truncated: false,
  };

  const stderr: CapturedOutput = {
    text: "",
    truncated: false,
  };

  const child = spawn(
    options.command,
    options.args,
    {
      cwd: options.cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let timedOut = false;
  let settled = false;
  let terminationPromise: Promise<void> | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout>;

  const finish = (callback: () => void): void => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timeoutHandle);
    callback();
  };

  timeoutHandle = setTimeout(() => {
    timedOut = true;
    terminationPromise = terminateProcessTree(child);
  }, timeoutMs);

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const next = appendCapped(
      stdout,
      chunk,
      maxOutputChars,
    );

    stdout.text = next.text;
    stdout.truncated = next.truncated;
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const next = appendCapped(
      stderr,
      chunk,
      maxOutputChars,
    );

    stderr.text = next.text;
    stderr.truncated = next.truncated;
  });

  return await new Promise<RunProcessResult>(
    (resolve, reject) => {
      child.once("error", (error) => {
        finish(() => reject(error));
      });

      child.once("close", (code, signal) => {
        void (async () => {
          if (terminationPromise) {
            await terminationPromise;
          }

          finish(() => {
            resolve({
              exitCode: code,
              signal,
              timedOut,
              stdout: stdout.text,
              stderr: stderr.text,
              stdoutTruncated: stdout.truncated,
              stderrTruncated: stderr.truncated,
            });
          });
        })();
      });
    },
  );
}