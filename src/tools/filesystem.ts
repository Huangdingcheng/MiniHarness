import {
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";

import path from "node:path";

import type {
  ToolDefinition,
} from "../model/types.js";

import { ToolRegistry } from "./registry.js";

const MAX_FILE_BYTES = 100_000;
const MAX_DIRECTORY_ENTRIES = 200;

function isWithinRoot(
  root: string,
  target: string,
): boolean {
  const relative = path.relative(root, target);

  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

function isBlockedPath(relativePath: string): boolean {
  const segments = relativePath
    .split(path.sep)
    .filter(Boolean);

  return segments.some((segment) => {
    const name = segment.toLowerCase();

    if (name === ".git" || name === "node_modules") {
      return true;
    }

    if (name === ".env") {
      return true;
    }

    if (
      name.startsWith(".env.") &&
      name !== ".env.example"
    ) {
      return true;
    }

    return false;
  });
}

function getPathArgument(
  args: Record<string, unknown>,
): string {
  const value = args.path ?? ".";

  if (
    typeof value !== "string" ||
    value.trim() === ""
  ) {
    throw new Error(
      "The path argument must be a non-empty string.",
    );
  }

  return value;
}

async function resolveWorkspacePath(
  root: string,
  inputPath: string,
): Promise<string> {
  const candidate = path.resolve(root, inputPath);

  if (!isWithinRoot(root, candidate)) {
    throw new Error("Path is outside the workspace.");
  }

  const relative = path.relative(root, candidate);

  if (isBlockedPath(relative)) {
    throw new Error("Access to this path is blocked.");
  }

  // Resolve symlinks as well as ordinary paths.
  const actual = await realpath(candidate);

  if (!isWithinRoot(root, actual)) {
    throw new Error("Path is outside the workspace.");
  }

  const actualRelative = path.relative(root, actual);

  if (isBlockedPath(actualRelative)) {
    throw new Error("Access to this path is blocked.");
  }

  return actual;
}

const listDirectoryDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "list_directory",
    description:
      "List files and subdirectories in the workspace. " +
      "Use a relative path, or '.' for the workspace root.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative directory path. Defaults to '.'.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

const readFileDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the workspace. " +
      "Use a workspace-relative path.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Workspace-relative file path.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

export async function registerFileSystemTools(
  registry: ToolRegistry,
  workspaceRoot: string = process.cwd(),
): Promise<void> {
  // Canonicalize the workspace root once.
  const root = await realpath(workspaceRoot);

  registry.register(
    listDirectoryDefinition,
    async (args) => {
      const inputPath = getPathArgument(args);
      const target = await resolveWorkspacePath(
        root,
        inputPath,
      );

      const info = await stat(target);

      if (!info.isDirectory()) {
        throw new Error("Path is not a directory.");
      }

      const entries = await readdir(target, {
        withFileTypes: true,
      });

      const relativeDirectory = path.relative(
        root,
        target,
      );

      const visibleEntries = entries
        .filter((entry) => {
          const relativeEntry = path.join(
            relativeDirectory,
            entry.name,
          );

          return !isBlockedPath(relativeEntry);
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      const truncated =
        visibleEntries.length > MAX_DIRECTORY_ENTRIES;

      const lines = visibleEntries
        .slice(0, MAX_DIRECTORY_ENTRIES)
        .map((entry) => {
          const kind = entry.isDirectory()
            ? "dir"
            : entry.isFile()
              ? "file"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other";

          return `[${kind}] ${entry.name}`;
        });

      if (truncated) {
        lines.push(
          `... truncated; total visible entries: ${visibleEntries.length}`,
        );
      }

      return lines.join("\n") || "(empty directory)";
    },
  );

  registry.register(
    readFileDefinition,
    async (args) => {
      const inputPath = getPathArgument(args);

      const target = await resolveWorkspacePath(
        root,
        inputPath,
      );

      const info = await stat(target);

      if (!info.isFile()) {
        throw new Error("Path is not a regular file.");
      }

      if (info.size > MAX_FILE_BYTES) {
        throw new Error(
          `File exceeds the ${MAX_FILE_BYTES}-byte limit.`,
        );
      }

      return await readFile(target, "utf8");
    },
  );
}