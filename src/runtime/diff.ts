
import { createReadStream } from "node:fs";
import {
  lstat,
  readdir,
  realpath,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  shouldExcludeWorkspacePath,
} from "./workspace.js";

export type WorkspaceChangeKind =
  | "added"
  | "modified"
  | "deleted";

export type WorkspaceChange = {
  path: string;
  kind: WorkspaceChangeKind;
  sourceSize: number | null;
  workspaceSize: number | null;
  sourceSha256: string | null;
  workspaceSha256: string | null;
};

type FileRecord = {
  size: number;
  sha256: string;
};

async function hashFile(
  filePath: string,
): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

async function collectFiles(
  root: string,
): Promise<Map<string, FileRecord>> {
  const files = new Map<string, FileRecord>();

  async function visit(
    directory: string,
    relativeDirectory: string,
  ): Promise<void> {
    const entries = await readdir(directory, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;

      if (shouldExcludeWorkspacePath(relativePath)) {
        continue;
      }

      const absolutePath = path.join(
        directory,
        entry.name,
      );

      // 不跟随符号链接，避免把工作区之外的内容
      // 纳入普通文件差异。
      const info = await lstat(absolutePath);

      if (info.isSymbolicLink()) {
        continue;
      }

      if (info.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }

      if (!info.isFile()) {
        continue;
      }

      // 统一使用 / 作为差异记录中的路径分隔符。
      const normalizedPath = relativePath
        .split(path.sep)
        .join("/");

      files.set(normalizedPath, {
        size: info.size,
        sha256: await hashFile(absolutePath),
      });
    }
  }

  await visit(root, "");
  return files;
}

function isSameOrInside(
  parent: string,
  child: string,
): boolean {
  const relative = path.relative(parent, child);

  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

export async function getWorkspaceChanges(
  sourceRoot: string,
  workspaceRoot: string,
): Promise<WorkspaceChange[]> {
  const source = await realpath(sourceRoot);
  const workspace = await realpath(workspaceRoot);

  const sourceInfo = await lstat(source);
  const workspaceInfo = await lstat(workspace);

  if (
    !sourceInfo.isDirectory() ||
    !workspaceInfo.isDirectory()
  ) {
    throw new Error(
      "Source and workspace roots must be directories.",
    );
  }

  if (
    isSameOrInside(source, workspace) ||
    isSameOrInside(workspace, source)
  ) {
    throw new Error(
      "Source and workspace must be separate directories.",
    );
  }

  const sourceFiles = await collectFiles(source);
  const workspaceFiles = await collectFiles(workspace);

  const allPaths = new Set([
    ...sourceFiles.keys(),
    ...workspaceFiles.keys(),
  ]);

  const changes: WorkspaceChange[] = [];

  for (const filePath of allPaths) {
    const original = sourceFiles.get(filePath);
    const current = workspaceFiles.get(filePath);

    if (!original && current) {
      changes.push({
        path: filePath,
        kind: "added",
        sourceSize: null,
        workspaceSize: current.size,
        sourceSha256: null,
        workspaceSha256: current.sha256,
      });

      continue;
    }

    if (original && !current) {
      changes.push({
        path: filePath,
        kind: "deleted",
        sourceSize: original.size,
        workspaceSize: null,
        sourceSha256: original.sha256,
        workspaceSha256: null,
      });

      continue;
    }

    if (
      original &&
      current &&
      original.sha256 !== current.sha256
    ) {
      changes.push({
        path: filePath,
        kind: "modified",
        sourceSize: original.size,
        workspaceSize: current.size,
        sourceSha256: original.sha256,
        workspaceSha256: current.sha256,
      });
    }
  }

  return changes.sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}
