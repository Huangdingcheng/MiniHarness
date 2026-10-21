
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  getWorkspaceBaselinePath,
  shouldExcludeWorkspacePath,
  type WorkspaceBaseline,
} from "./workspace.js";

import {
  getWorkspaceChanges,
  type WorkspaceChange,
} from "./diff.js";

export type WritebackCheckStatus =
  | "ready"
  | "conflict"
  | "unsafe";

export type WritebackCheckResult = {
  path: string;
  kind: WorkspaceChange["kind"];
  status: WritebackCheckStatus;
  reason: string;
};

type InspectedFile = {
  exists: boolean;
  absolutePath?: string;
};

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isNotFound(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === "ENOENT"
  );
}

async function hashFile(
  filePath: string,
): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

function validateRelativePath(
  relativePath: string,
): string {
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    throw new Error("Invalid relative path.");
  }

  const segments = relativePath.split("/");

  if (
    segments.some(
      (part) =>
        !part ||
        part === "." ||
        part === "..",
    )
  ) {
    throw new Error("Path traversal is not allowed.");
  }

  if (
    shouldExcludeWorkspacePath(
      segments.join(path.sep),
    )
  ) {
    throw new Error(
      "The target path is excluded from workspace operations.",
    );
  }

  return segments.join("/");
}

async function inspectRegularFile(
  root: string,
  relativePath: string,
): Promise<InspectedFile> {
  const safeRelativePath =
    validateRelativePath(relativePath);

  let current = root;

  const segments = safeRelativePath.split("/");

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);

    let info;

    try {
      info = await lstat(current);
    } catch (error) {
      if (isNotFound(error)) {
        return { exists: false };
      }

      throw error;
    }

    if (info.isSymbolicLink()) {
      throw new Error(
        `Symbolic links are not allowed: ${relativePath}`,
      );
    }

    const isLast = index === segments.length - 1;

    if (!isLast && !info.isDirectory()) {
      throw new Error(
        `Parent path is not a directory: ${relativePath}`,
      );
    }

    if (isLast && !info.isFile()) {
      throw new Error(
        `Expected a regular file: ${relativePath}`,
      );
    }
  }

  return {
    exists: true,
    absolutePath: current,
  };
}

async function readBaseline(
  sourceRoot: string,
  workspaceRoot: string,
): Promise<WorkspaceBaseline> {
  const baselinePath =
    getWorkspaceBaselinePath(workspaceRoot);

  const raw = await readFile(
    baselinePath,
    "utf8",
  );

  const parsed: unknown = JSON.parse(raw);

  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.sourceRoot !== "string" ||
    typeof parsed.workspaceRoot !== "string" ||
    typeof parsed.createdAt !== "string" ||
    !isRecord(parsed.files)
  ) {
    throw new Error(
      "Invalid workspace baseline format.",
    );
  }

  if (
    parsed.sourceRoot !== sourceRoot ||
    parsed.workspaceRoot !== workspaceRoot
  ) {
    throw new Error(
      "Workspace baseline does not match the supplied roots.",
    );
  }

  for (const [relativePath, value] of Object.entries(
    parsed.files,
  )) {
    validateRelativePath(relativePath);

    if (
      !isRecord(value) ||
      typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    ) {
      throw new Error(
        `Invalid baseline entry: ${relativePath}`,
      );
    }
  }

  return parsed as unknown as WorkspaceBaseline;
}

export async function inspectWorkspaceWriteback(
  sourceRootArgument: string,
  workspaceRootArgument: string,
): Promise<WritebackCheckResult[]> {
  const sourceRoot = await realpath(
    sourceRootArgument,
  );

  const workspaceRoot = await realpath(
    workspaceRootArgument,
  );

  // 验证基线存在、格式正确且对应当前两个目录。
  const baseline = await readBaseline(
    sourceRoot,
    workspaceRoot,
  );

  // 重新计算当前差异，不信任外部传入的差异列表。
  const changes = await getWorkspaceChanges(
    sourceRoot,
    workspaceRoot,
  );

  const results: WritebackCheckResult[] = [];

  for (const change of changes) {
    try {
      const relativePath = validateRelativePath(
        change.path,
      );

      const baselineHasFile = Object.hasOwn(
        baseline.files,
        change.path,
      );

      const baselineFile =
        baseline.files[change.path];

      const sourceFile = await inspectRegularFile(
        sourceRoot,
        relativePath,
      );

      const workspaceFile = await inspectRegularFile(
        workspaceRoot,
        relativePath,
      );

      if (change.kind === "added") {
        if (baselineHasFile) {
          results.push({
            path: change.path,
            kind: change.kind,
            status: "conflict",
            reason:
              "The file exists in the baseline but is now classified as added.",
          });
          continue;
        }

        if (sourceFile.exists) {
          results.push({
            path: change.path,
            kind: change.kind,
            status: "conflict",
            reason:
              "The destination already exists in the original project.",
          });
          continue;
        }

        if (!workspaceFile.exists) {
          results.push({
            path: change.path,
            kind: change.kind,
            status: "conflict",
            reason:
              "The added file no longer exists in the workspace.",
          });
          continue;
        }

        results.push({
          path: change.path,
          kind: change.kind,
          status: "ready",
          reason: "New destination is available.",
        });

        continue;
      }

      if (!baselineHasFile || !baselineFile) {
        results.push({
          path: change.path,
          kind: change.kind,
          status: "conflict",
          reason:
            "No baseline entry exists for this original file.",
        });
        continue;
      }

      if (!sourceFile.exists) {
        results.push({
          path: change.path,
          kind: change.kind,
          status: "conflict",
          reason:
            "The original file is missing; it may have been deleted externally.",
        });
        continue;
      }

      const sourceHash = await hashFile(
        sourceFile.absolutePath!,
      );

      if (sourceHash !== baselineFile.sha256) {
        results.push({
          path: change.path,
          kind: change.kind,
          status: "conflict",
          reason:
            "The original file changed after the baseline was created.",
        });
        continue;
      }

      if (
        change.kind === "modified" &&
        !workspaceFile.exists
      ) {
        results.push({
          path: change.path,
          kind: change.kind,
          status: "conflict",
          reason:
            "The modified workspace file is missing.",
        });
        continue;
      }

      if (
        change.kind === "deleted" &&
        workspaceFile.exists
      ) {
        results.push({
          path: change.path,
          kind: change.kind,
          status: "conflict",
          reason:
            "The workspace file still exists.",
        });
        continue;
      }

      results.push({
        path: change.path,
        kind: change.kind,
        status: "ready",
        reason:
          "The original file still matches the baseline.",
      });
    } catch (error) {
      results.push({
        path: change.path,
        kind: change.kind,
        status: "unsafe",
        reason:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  return results;
}
