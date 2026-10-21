// 创建项目副本和清理副本

import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".miniharness",
  "node_modules",
  "dist",
  "coverage",
  "release",
  "target",
  ".turbo",
]);

export type SandboxWorkspace = {
  sourceRoot: string;
  workspaceRoot: string;
  cleanup: () => Promise<void>;
};

function shouldExclude(relativePath: string): boolean {
  const parts = relativePath
    .split(path.sep)
    .filter(Boolean);

  return parts.some(
    (part) =>
      EXCLUDED_DIRECTORIES.has(part) ||
      part === ".env" ||
      part.startsWith(".env."),
  );
}

export async function createSandboxWorkspace(
  sourceRoot: string = process.cwd(),
): Promise<SandboxWorkspace> {
  const resolvedSource = await realpath(sourceRoot);
  const sourceInfo = await stat(resolvedSource);

  if (!sourceInfo.isDirectory()) {
    throw new Error(
      "Source workspace must be a directory.",
    );
  }

  const baseDirectory = path.join(
    os.tmpdir(),
    "miniharness-sandboxes",
  );

  await mkdir(baseDirectory, {
    recursive: true,
  });

  const workspaceRoot = await mkdtemp(
    path.join(baseDirectory, "run-"),
  );

  try {
    await cp(resolvedSource, workspaceRoot, {
      recursive: true,
      filter: async (sourcePath) => {
        const relativePath = path.relative(
          resolvedSource,
          sourcePath,
        );

        if (!relativePath) {
          return true;
        }

        if (shouldExclude(relativePath)) {
          return false;
        }

        // Do not copy symlinks into the workspace.
        const info = await lstat(sourcePath);

        return !info.isSymbolicLink();
      },
    });
  } catch (error) {
    await rm(workspaceRoot, {
      recursive: true,
      force: true,
    });

    throw error;
  }

  return {
    sourceRoot: resolvedSource,
    workspaceRoot,

    async cleanup(): Promise<void> {
      await rm(workspaceRoot, {
        recursive: true,
        force: true,
      });
    },
  };
}