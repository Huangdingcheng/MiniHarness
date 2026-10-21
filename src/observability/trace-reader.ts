import { readFile } from "node:fs/promises";

import type { AgentEvent } from "../agent/agent.js";
import type { TraceRecord } from "./trace-writer.js";

const EVENT_TYPES = new Set([
  "run_started",
  "model_request",
  "model_response",
  "model_error",
  "tool_started",
  "tool_finished",
  "run_finished",
]);

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseRecord(
  value: unknown,
  lineNumber: number,
): TraceRecord {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid trace record on line ${lineNumber}: expected an object.`,
    );
  }

  if (value.schemaVersion !== 1) {
    throw new Error(
      `Unsupported trace schema on line ${lineNumber}.`,
    );
  }

  if (
    typeof value.recordedAt !== "string" ||
    !isRecord(value.event) ||
    typeof value.event.type !== "string" ||
    !EVENT_TYPES.has(value.event.type)
  ) {
    throw new Error(
      `Invalid trace record structure on line ${lineNumber}.`,
    );
  }

  // This reader validates the envelope and event type.
  // Individual event fields are checked where they are consumed.
  return value as unknown as TraceRecord;
}

export async function readTraceFile(
  filePath: string,
): Promise<TraceRecord[]> {
  const content = await readFile(filePath, "utf8");

  const lines = content.split(/\r?\n/);
  const records: TraceRecord[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();

    // A final newline is normal in JSONL.
    if (!line) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new Error(
        `Invalid JSON on line ${index + 1}.`,
      );
    }

    records.push(parseRecord(parsed, index + 1));
  }

  return records;
}

export type ToolStats = {
  calls: number;
  completed: number;
  failures: number;
  totalDurationMs: number;
};

export type TraceSummary = {
  recordCount: number;
  eventCounts: Record<string, number>;
  modelRequests: number;
  modelErrors: number;
  toolCalls: number;
  toolFailures: number;
  status: "completed" | "max_steps" | "incomplete";
  durationMs: number | null;
  tools: Record<string, ToolStats>;
};

export function summarizeTrace(
  records: TraceRecord[],
): TraceSummary {
  const eventCounts: Record<string, number> = {};
  const tools = Object.create(null) as Record<
    string,
    ToolStats
  >;

  let modelRequests = 0;
  let modelErrors = 0;
  let toolCalls = 0;
  let toolFailures = 0;

  const events: AgentEvent[] = records.map(
    (record) => record.event,
  );

  for (const event of events) {
    eventCounts[event.type] =
      (eventCounts[event.type] ?? 0) + 1;

    if (event.type === "model_request") {
      modelRequests += 1;
    }

    if (event.type === "model_error") {
      modelErrors += 1;
    }

    if (event.type === "tool_started") {
      toolCalls += 1;

      const stats = tools[event.toolName] ?? {
        calls: 0,
        completed: 0,
        failures: 0,
        totalDurationMs: 0,
      };

      stats.calls += 1;
      tools[event.toolName] = stats;
    }

    if (event.type === "tool_finished") {
      const stats = tools[event.toolName] ?? {
        calls: 0,
        completed: 0,
        failures: 0,
        totalDurationMs: 0,
      };

      stats.completed += 1;
      stats.totalDurationMs += Math.max(
        0,
        event.durationMs,
      );

      if (!event.ok) {
        stats.failures += 1;
        toolFailures += 1;
      }

      tools[event.toolName] = stats;
    }
  }

  const startEvent = events.find(
    (event) => event.type === "run_started",
  );

  const finishEvent = [...events]
    .reverse()
    .find((event) => event.type === "run_finished");

  let durationMs: number | null = null;

  if (startEvent && finishEvent) {
    const start = Date.parse(startEvent.timestamp);
    const finish = Date.parse(finishEvent.timestamp);

    if (
      Number.isFinite(start) &&
      Number.isFinite(finish)
    ) {
      durationMs = Math.max(0, finish - start);
    }
  }

  const status =
    finishEvent?.type === "run_finished"
      ? finishEvent.status
      : "incomplete";

  return {
    recordCount: records.length,
    eventCounts,
    modelRequests,
    modelErrors,
    toolCalls,
    toolFailures,
    status,
    durationMs,
    tools,
  };
}