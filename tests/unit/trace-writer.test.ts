import { afterEach, describe, expect, it } from "vitest";

import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  createTraceWriter,
} from "../../src/observability/trace-writer.js";

describe("TraceWriter", () => {
  let root = "";

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });

      root = "";
    }
  });

  it("writes events as separate JSONL records", async () => {
    root = await mkdtemp(
      path.join(os.tmpdir(), "mini-harness-trace-"),
    );

    const writer = createTraceWriter(root);

    writer.write({
      type: "run_started",
      timestamp: "2026-10-21T10:00:00.000Z",
      taskLength: 20,
    });

    writer.write({
      type: "run_finished",
      timestamp: "2026-10-21T10:00:01.000Z",
      status: "completed",
      steps: 2,
    });

    const content = await readFile(
      writer.filePath,
      "utf8",
    );

    const lines = content
      .trim()
      .split(/\r?\n/);

    expect(lines).toHaveLength(2);

    const records = lines.map(
      (line) => JSON.parse(line) as {
        schemaVersion: number;
        recordedAt: string;
        event: { type: string };
      },
    );

    expect(records[0]?.schemaVersion).toBe(1);
    expect(records[0]?.event.type).toBe("run_started");
    expect(records[1]?.event.type).toBe("run_finished");
  });

  it("redacts common API key patterns in model errors", async () => {
    root = await mkdtemp(
      path.join(os.tmpdir(), "mini-harness-trace-"),
    );

    const writer = createTraceWriter(root);

    writer.write({
      type: "model_error",
      timestamp: "2026-10-21T10:00:00.000Z",
      step: 1,
      message:
        "Authentication failed for key sk-abcdefghijklmnopqrstuvwxyz123456",
    });

    const content = await readFile(
      writer.filePath,
      "utf8",
    );

    expect(content).toContain("[REDACTED_API_KEY]");
    expect(content).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz123456",
    );
  });
});