import { describe, expect, it } from "vitest";

import {
  runProcess,
} from "../../src/runtime/process.js";

describe("ProcessRuntime", () => {
  it("captures stdout, stderr, and exit code", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("hello"); ' +
          'process.stderr.write("warning"); ' +
          "process.exitCode = 3;",
      ],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });

    expect(result.stdout).toContain("hello");
    expect(result.stderr).toContain("warning");
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it("terminates a process that exceeds its timeout", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        "setInterval(() => {}, 1000)",
      ],
      cwd: process.cwd(),
      timeoutMs: 100,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("limits captured output", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("0123456789");',
      ],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxOutputChars: 8,
    });

    expect(result.stdout).toBe("01234567");
    expect(result.stdoutTruncated).toBe(true);
  });
});