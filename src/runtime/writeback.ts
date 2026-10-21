
import { randomUUID, createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { getWorkspaceChanges } from "./diff.js";
import type { WorkspaceChange } from "./diff.js";
import { inspectWorkspaceWriteback } from "./writeback-check.js";
import { shouldExcludeWorkspacePath } from "./workspace.js";

export type AppliedChange = {
  path: string;
  kind: WorkspaceChange["kind"];
  status: "applied";
};

type FileInfo = {
  exists: boolean;
  absolutePath: string;
  mode?: number;
};

type AppliedOperation = {
  path: string;
  kind: WorkspaceChange["kind"];
  absolutePath: string;
  originalContent?: Buffer;
  originalMode?: number | undefined;
};

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
}

function validateRelativePath(relativePath: string): string[] {
  if (
    !relativePath ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    throw new Error(`Invalid relative path: ${relativePath}`);
  }

  const segments = relativePath.split("/");

  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === "..",
    )
  ) {
    throw new Error(`Path traversal rejected: ${relativePath}`);
  }

  if (
    shouldExcludeWorkspacePath(
      segments.join(path.sep),
    )
  ) {
    throw new Error(`Excluded path: ${relativePath}`);
  }

  return segments;
}

function hashBuffer(content: Buffer): string {
  return createHash("sha256")
    .update(content)
    .digest("hex");
}

async function inspectFile(
  root: string,
  segments: string[],
): Promise<FileInfo> {
  const absolutePath = path.join(root, ...segments);
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);

    let info;

    try {
      info = await lstat(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return { exists: false, absolutePath };
      }

      throw error;
    }

    if (info.isSymbolicLink()) {
      throw new Error(
        `Symbolic link rejected: ${segments.join("/")}`,
      );
    }

    const isLast = index === segments.length - 1;

    if (!isLast && !info.isDirectory()) {
      throw new Error(
        `Parent path is not a directory: ${segments.join("/")}`,
      );
    }

    if (isLast && !info.isFile()) {
      throw new Error(
        `Expected a regular file: ${segments.join("/")}`,
      );
    }

    if (isLast) {
      return {
        exists: true,
        absolutePath,
        mode: info.mode & 0o777,
      };
    }
  }

  return { exists: false, absolutePath };
}

async function ensureParentDirectories(
  root: string,
  segments: string[],
  createdDirectories: string[],
): Promise<void> {
  let current = root;

  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);

    try {
      await mkdir(current);
      createdDirectories.push(current);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }

    const info = await lstat(current);

    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        `Unsafe parent directory: ${current}`,
      );
    }
  }
}

async function atomicReplace(
  target: string,
  content: Buffer,
  mode?: number,
): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, content, {
      flag: "wx",
      mode: mode ?? 0o666,
    });

    await rename(temporaryPath, target);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function createExclusiveFile(
  target: string,
  content: Buffer,
  mode?: number,
): Promise<void> {
  let created = false;

  try {
    const handle = await open(
      target,
      "wx",
      mode ?? 0o666,
    );

    created = true;

    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (created) {
      try {
        await unlink(target);
      } catch {
        // Preserve the original write error.
      }
    }

    throw error;
  }
}

async function rollback(
  operations: AppliedOperation[],
  createdDirectories: string[],
): Promise<string[]> {
  const failures: string[] = [];

  for (const operation of [...operations].reverse()) {
    try {
      if (operation.kind === "added") {
        await unlink(operation.absolutePath);
      } else if (operation.kind === "modified") {
        await atomicReplace(
          operation.absolutePath,
          operation.originalContent!,
          operation.originalMode,
        );
      } else {
        await createExclusiveFile(
          operation.absolutePath,
          operation.originalContent!,
          operation.originalMode,
        );
      }
    } catch (error) {
      failures.push(
        `${operation.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  for (const directory of [...createdDirectories].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (
        errorCode(error) !== "ENOENT" &&
        errorCode(error) !== "ENOTEMPTY" &&
        errorCode(error) !== "EEXIST"
      ) {
        failures.push(
          `Directory cleanup ${directory}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return failures;
}

export async function applyWorkspaceChanges(
  sourceRootArgument: string,
  workspaceRootArgument: string,
  approvedPaths: string[],
): Promise<AppliedChange[]> {
  if (approvedPaths.length === 0) {
    return [];
  }

  const sourceRoot = await realpath(sourceRootArgument);
  const workspaceRoot = await realpath(workspaceRootArgument);

  if (new Set(approvedPaths).size !== approvedPaths.length) {
    throw new Error("Duplicate approved paths are not allowed.");
  }

  for (const relativePath of approvedPaths) {
    validateRelativePath(relativePath);
  }

  // 初次检查：所有批准项必须属于当前差异且状态为 ready。
  const initialChanges = await getWorkspaceChanges(
    sourceRoot,
    workspaceRoot,
  );

  const changeMap = new Map(
    initialChanges.map((change) => [change.path, change]),
  );

  const initialChecks = await inspectWorkspaceWriteback(
    sourceRoot,
    workspaceRoot,
  );

  const checkMap = new Map(
    initialChecks.map((check) => [check.path, check]),
  );

  for (const relativePath of approvedPaths) {
    if (!changeMap.has(relativePath)) {
      throw new Error(
        `Approved path is not a current change: ${relativePath}`,
      );
    }

    const check = checkMap.get(relativePath);

    if (check?.status !== "ready") {
      throw new Error(
        `Writeback blocked for ${relativePath}: ${
          check?.reason ?? "No valid preflight result."
        }`,
      );
    }
  }

  const operations: AppliedOperation[] = [];
  const createdDirectories: string[] = [];
  const results: AppliedChange[] = [];

  try {
    for (const relativePath of approvedPaths) {
      // 每个文件写入前重新检查，尽量缩小检查与使用之间的时间窗口。
      const currentChanges = await getWorkspaceChanges(
        sourceRoot,
        workspaceRoot,
      );

      const change = currentChanges.find(
        (item) => item.path === relativePath,
      );

      if (!change) {
        throw new Error(
          `Change disappeared before writeback: ${relativePath}`,
        );
      }

      const currentChecks = await inspectWorkspaceWriteback(
        sourceRoot,
        workspaceRoot,
      );

      const check = currentChecks.find(
        (item) => item.path === relativePath,
      );

      if (check?.status !== "ready") {
        throw new Error(
          `Writeback blocked for ${relativePath}: ${
            check?.reason ?? "Change is no longer ready."
          }`,
        );
      }

      const segments = validateRelativePath(relativePath);

      const sourceFile = await inspectFile(
        sourceRoot,
        segments,
      );

      const workspaceFile = await inspectFile(
        workspaceRoot,
        segments,
      );

      if (change.kind === "added") {
        if (sourceFile.exists || !workspaceFile.exists) {
          throw new Error(
            `Added-file state changed: ${relativePath}`,
          );
        }

        const content = await readFile(
          workspaceFile.absolutePath,
        );

        if (hashBuffer(content) !== change.workspaceSha256) {
          throw new Error(
            `Workspace file changed during review: ${relativePath}`,
          );
        }

        await ensureParentDirectories(
          sourceRoot,
          segments,
          createdDirectories,
        );

        // 在创建目标文件时使用 wx，拒绝覆盖意外出现的同名文件。
        await createExclusiveFile(
          sourceFile.absolutePath,
          content,
          workspaceFile.mode,
        );

        operations.push({
          path: relativePath,
          kind: "added",
          absolutePath: sourceFile.absolutePath,
        });
      } else if (change.kind === "modified") {
        if (!sourceFile.exists || !workspaceFile.exists) {
          throw new Error(
            `Modified-file state changed: ${relativePath}`,
          );
        }

        const originalContent = await readFile(
          sourceFile.absolutePath,
        );

        const newContent = await readFile(
          workspaceFile.absolutePath,
        );

        if (
          hashBuffer(originalContent) !== change.sourceSha256 ||
          hashBuffer(newContent) !== change.workspaceSha256
        ) {
          throw new Error(
            `File changed during review: ${relativePath}`,
          );
        }

        operations.push({
          path: relativePath,
          kind: "modified",
          absolutePath: sourceFile.absolutePath,
          originalContent,
          originalMode: sourceFile.mode,
        });

        await atomicReplace(
          sourceFile.absolutePath,
          newContent,
          sourceFile.mode,
        );
      } else {
        if (sourceFile.exists === false || workspaceFile.exists) {
          throw new Error(
            `Deleted-file state changed: ${relativePath}`,
          );
        }

        const originalContent = await readFile(
          sourceFile.absolutePath,
        );

        if (hashBuffer(originalContent) !== change.sourceSha256) {
          throw new Error(
            `File changed during review: ${relativePath}`,
          );
        }

        operations.push({
          path: relativePath,
          kind: "deleted",
          absolutePath: sourceFile.absolutePath,
          originalContent,
          originalMode: sourceFile.mode,
        });

        await unlink(sourceFile.absolutePath);
      }

      results.push({
        path: relativePath,
        kind: change.kind,
        status: "applied",
      });
    }

    // 后置验证：批准的文件必须不再存在于原始项目与沙箱的差异中。
    const remainingChanges = await getWorkspaceChanges(
      sourceRoot,
      workspaceRoot,
    );

    for (const relativePath of approvedPaths) {
      if (
        remainingChanges.some(
          (change) => change.path === relativePath,
        )
      ) {
        throw new Error(
          `Post-write verification failed: ${relativePath}`,
        );
      }
    }

    return results;
  } catch (error) {
    const rollbackFailures = await rollback(
      operations,
      createdDirectories,
    );

    const message =
      error instanceof Error ? error.message : String(error);

    throw new Error(
      `Writeback failed: ${message}` +
        (rollbackFailures.length > 0
          ? `\nRollback failures:\n${rollbackFailures.join("\n")}`
          : "\nApplied changes were rolled back where possible."),
    );
  }
}
