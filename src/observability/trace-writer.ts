import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";

import path from "node:path";
import { randomUUID } from "node:crypto";

import type { AgentEvent } from "../agent/agent.js";

export type TraceRecord = {
  schemaVersion: 1;
  recordedAt: string;
  event: AgentEvent;
};

export type TraceWriter = {
  filePath: string;
  write: (event: AgentEvent) => void;
};

function redactSensitiveText(text: string): string {
  return text
    .replace(
      /\bsk-[A-Za-z0-9_-]{12,}\b/g,
      "[REDACTED_API_KEY]",
    )
    .replace(
      /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
      "$1[REDACTED]",
    );
}

function sanitizeEvent(event: AgentEvent): AgentEvent {
  if (event.type === "model_error") {
    return {
      ...event,
      message: redactSensitiveText(event.message),
    };
  }

  return event;
}

export function createTraceWriter(
  workspaceRoot: string = process.cwd(),
): TraceWriter {
  const traceDirectory = path.join(
    workspaceRoot,
    ".miniharness",
    "traces",
  );

  mkdirSync(traceDirectory, {
    recursive: true,
  });

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const filePath = path.join(
    traceDirectory,
    `${timestamp}-${randomUUID()}.jsonl`,
  );

  // Create a new file; never overwrite an existing trace.
  writeFileSync(filePath, "", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  return {
    filePath,

    write(event: AgentEvent): void {
      const record: TraceRecord = {
        schemaVersion: 1,
        recordedAt: new Date().toISOString(),
        event: sanitizeEvent(event),
      };

      appendFileSync(
        filePath,
        `${JSON.stringify(record)}\n`,
        "utf8",
      );
    },
  };
}