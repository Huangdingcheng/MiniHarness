import { describe, expect, it } from "vitest";

import {
  summarizeTrace,
} from "../../src/observability/trace-reader.js";

import type {
  TraceRecord,
} from "../../src/observability/trace-writer.js";

describe("TraceReader", () => {
  it("summarizes model calls, tools, and duration", () => {
    const records: TraceRecord[] = [
      {
        schemaVersion: 1,
        recordedAt: "2026-10-21T10:00:00.000Z",
        event: {
          type: "run_started",
          timestamp: "2026-10-21T10:00:00.000Z",
          taskLength: 20,
        },
      },
      {
        schemaVersion: 1,
        recordedAt: "2026-10-21T10:00:00.100Z",
        event: {
          type: "model_request",
          timestamp: "2026-10-21T10:00:00.100Z",
          step: 1,
          messageCount: 2,
          toolCount: 4,
        },
      },
      {
        schemaVersion: 1,
        recordedAt: "2026-10-21T10:00:00.200Z",
        event: {
          type: "tool_started",
          timestamp: "2026-10-21T10:00:00.200Z",
          step: 1,
          callId: "call_001",
          toolName: "read_file",
        },
      },
      {
        schemaVersion: 1,
        recordedAt: "2026-10-21T10:00:00.220Z",
        event: {
          type: "tool_finished",
          timestamp: "2026-10-21T10:00:00.220Z",
          step: 1,
          callId: "call_001",
          toolName: "read_file",
          ok: true,
          resultLength: 100,
          durationMs: 20,
        },
      },
      {
        schemaVersion: 1,
        recordedAt: "2026-10-21T10:00:01.000Z",
        event: {
          type: "model_request",
          timestamp: "2026-10-21T10:00:01.000Z",
          step: 2,
          messageCount: 4,
          toolCount: 4,
        },
      },
      {
        schemaVersion: 1,
        recordedAt: "2026-10-21T10:00:02.000Z",
        event: {
          type: "run_finished",
          timestamp: "2026-10-21T10:00:02.000Z",
          status: "completed",
          steps: 2,
        },
      },
    ];

    const summary = summarizeTrace(records);

    expect(summary.recordCount).toBe(6);
    expect(summary.modelRequests).toBe(2);
    expect(summary.modelErrors).toBe(0);
    expect(summary.toolCalls).toBe(1);
    expect(summary.toolFailures).toBe(0);
    expect(summary.status).toBe("completed");
    expect(summary.durationMs).toBe(2000);

    expect(summary.tools.read_file).toEqual({
      calls: 1,
      completed: 1,
      failures: 0,
      totalDurationMs: 20,
    });
  });

  it("counts tool failures and incomplete runs", () => {
    const records: TraceRecord[] = [
      {
        schemaVersion: 1,
        recordedAt: "2026-10-21T10:00:00.000Z",
        event: {
          type: "run_started",
          timestamp: "2026-10-21T10:00:00.000Z",
          taskLength: 10,
        },
      },
      {
        schemaVersion: 1,
        recordedAt: "2026-10-21T10:00:00.100Z",
        event: {
          type: "tool_started",
          timestamp: "2026-10-21T10:00:00.100Z",
          step: 1,
          callId: "call_002",
          toolName: "edit_file",
        },
      },
      {
        schemaVersion: 1,
        recordedAt: "2026-10-21T10:00:00.120Z",
        event: {
          type: "tool_finished",
          timestamp: "2026-10-21T10:00:00.120Z",
          step: 1,
          callId: "call_002",
          toolName: "edit_file",
          ok: false,
          resultLength: 50,
          durationMs: 20,
        },
      },
    ];

    const summary = summarizeTrace(records);

    expect(summary.status).toBe("incomplete");
    expect(summary.durationMs).toBeNull();
    expect(summary.toolFailures).toBe(1);
    expect(summary.tools.edit_file?.failures).toBe(1);
  });
});