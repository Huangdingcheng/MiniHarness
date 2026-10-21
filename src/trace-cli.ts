import {
  readdir,
  stat,
} from "node:fs/promises";

import path from "node:path";

import {
  readTraceFile,
  summarizeTrace,
} from "./observability/trace-reader.js";

async function findLatestTrace(
  directory: string,
): Promise<string> {
  const names = await readdir(directory);

  const files = names.filter(
    (name) => name.endsWith(".jsonl"),
  );

  if (files.length === 0) {
    throw new Error(
      `No trace files found in ${directory}. Run an Agent task first.`,
    );
  }

  const candidates = await Promise.all(
    files.map(async (name) => {
      const filePath = path.join(directory, name);
      const info = await stat(filePath);

      return {
        filePath,
        modifiedAt: info.mtimeMs,
      };
    }),
  );

  candidates.sort(
    (a, b) => b.modifiedAt - a.modifiedAt,
  );

  return candidates[0]!.filePath;
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd();

  const traceDirectory = path.join(
    workspaceRoot,
    ".miniharness",
    "traces",
  );

  const requestedPath = process.argv[2];

  const filePath = requestedPath
    ? path.resolve(workspaceRoot, requestedPath)
    : await findLatestTrace(traceDirectory);

  const records = await readTraceFile(filePath);
  const summary = summarizeTrace(records);

  console.log("\n=== MiniHarness Trace Summary ===");
  console.log(`File: ${filePath}`);
  console.log(`Records: ${summary.recordCount}`);
  console.log(`Status: ${summary.status}`);

  console.log(
    `Duration: ${
      summary.durationMs === null
        ? "unknown"
        : `${summary.durationMs} ms`
    }`,
  );

  console.log(`Model requests: ${summary.modelRequests}`);
  console.log(`Model errors: ${summary.modelErrors}`);
  console.log(`Tool calls: ${summary.toolCalls}`);
  console.log(`Tool failures: ${summary.toolFailures}`);

  console.log("\nEvent counts:");

  for (const [name, count] of Object.entries(
    summary.eventCounts,
  )) {
    console.log(`  ${name}: ${count}`);
  }

  console.log("\nTool statistics:");

  const toolEntries = Object.entries(summary.tools);

  if (toolEntries.length === 0) {
    console.log("  No tools were executed.");
  }

  for (const [name, stats] of toolEntries) {
    const averageMs =
      stats.completed > 0
        ? Math.round(
            stats.totalDurationMs / stats.completed,
          )
        : null;

    console.log(
      `  ${name}: calls=${stats.calls}, ` +
      `completed=${stats.completed}, ` +
      `failures=${stats.failures}, ` +
      `avg_ms=${averageMs ?? "n/a"}`,
    );
  }
}

main().catch((error: unknown) => {
  const reason =
    error instanceof Error
      ? error.message
      : String(error);

  console.error(`[trace error] ${reason}`);
  process.exitCode = 1;
});