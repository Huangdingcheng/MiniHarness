// 创建项目副本和清理副本
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  readdir,
  writeFile,
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

export function shouldExcludeWorkspacePath(
  relativePath: string,
): boolean {
  const parts = relativePath
    .split(path.sep)
    .filter(Boolean);

  return parts.some(
    (part) =>
      EXCLUDED_DIRECTORIES.has(part) ||
      part === ".npmrc" ||
      part === ".pnpmfile.cjs" ||
      part === ".env" ||
      part.startsWith(".env."),
  );
}


export type WorkspaceBaselineFile = {
  size: number;
  sha256: string;
};

export type WorkspaceBaseline = {
  version: 1;
  sourceRoot: string;
  workspaceRoot: string;
  createdAt: string;
  files: Record<string, WorkspaceBaselineFile>;
};

export function getWorkspaceBaselinePath(
  workspaceRoot: string,
): string {
  return `${workspaceRoot}.baseline.json`;
}

async function hashWorkspaceFile(
  filePath: string,
): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

async function collectBaselineFiles(
  root: string,
): Promise<Record<string, WorkspaceBaselineFile>> {
  const files: Record<string, WorkspaceBaselineFile> =
    Object.create(null) as Record<
      string,
      WorkspaceBaselineFile
    >;

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

      files[relativePath.split(path.sep).join("/")] = {
        size: info.size,
        sha256: await hashWorkspaceFile(absolutePath),
      };
    }
  }

  await visit(root, "");
  return files;
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

  const baselinePath =
    getWorkspaceBaselinePath(workspaceRoot);

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

        if (shouldExcludeWorkspacePath(relativePath)) {
          return false;
        }

        // Do not copy symlinks into the workspace.
        const info = await lstat(sourcePath);

        return !info.isSymbolicLink();
      },
    });

    const baseline: WorkspaceBaseline = {
      version: 1,
      sourceRoot: resolvedSource,
      workspaceRoot,
      createdAt: new Date().toISOString(),
      files: await collectBaselineFiles(workspaceRoot),
    };

    await writeFile(
      baselinePath,
      JSON.stringify(baseline, null, 2),
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
  } catch (error) {
    await rm(workspaceRoot, {
      recursive: true,
      force: true,
    });

    await rm(baselinePath, {
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

      await rm(baselinePath, {
        force: true,
      });
    },
  };
}