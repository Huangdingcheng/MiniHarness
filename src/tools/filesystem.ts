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

const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_DEPTH = 10;
const MAX_SEARCH_TOTAL_BYTES = 2_000_000;

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


function parseMaxResults(value: unknown): number {
  if (value === undefined) {
    return 30;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SEARCH_RESULTS
  ) {
    throw new Error(
      `max_results must be an integer from 1 to ${MAX_SEARCH_RESULTS}.`,
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


const searchFilesDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "search_files",
    description:
      "Search for a literal, case-insensitive text query " +
      "in text files under a workspace directory. " +
      "Returns matching file paths, line numbers, and snippets.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Literal text to search for.",
        },
        path: {
          type: "string",
          description:
            "Workspace-relative directory. Defaults to '.'.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description:
            "Maximum matching lines to return. Defaults to 30.",
        },
      },
      required: ["query"],
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

  
  registry.register(
    searchFilesDefinition,
    async (args) => {
      const rawQuery = args.query;

      if (
        typeof rawQuery !== "string" ||
        rawQuery.trim().length === 0
      ) {
        throw new Error(
          "query must be a non-empty string.",
        );
      }

      if (rawQuery.length > 200) {
        throw new Error(
          "query cannot exceed 200 characters.",
        );
      }

      const query = rawQuery.trim().toLowerCase();

      const maxResults: number = parseMaxResults(
        args.max_results,
      );

      if (
        typeof maxResults !== "number" ||
        !Number.isInteger(maxResults) ||
        maxResults < 1 ||
        maxResults > MAX_SEARCH_RESULTS
      ) {
        throw new Error(
          `max_results must be an integer from 1 to ${MAX_SEARCH_RESULTS}.`,
        );
      }

      const inputPath = getPathArgument(args);

      const target = await resolveWorkspacePath(
        root,
        inputPath,
      );

      const targetInfo = await stat(target);

      if (!targetInfo.isDirectory()) {
        throw new Error(
          "Search path must be a directory.",
        );
      }

      const matches: string[] = [];

      let scannedFiles = 0;
      let scannedBytes = 0;
      let truncated = false;

      async function walk(
        directory: string,
        relativeDirectory: string,
        depth: number,
      ): Promise<void> {
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }

        if (depth > MAX_SEARCH_DEPTH) {
          truncated = true;
          return;
        }

        const entries = await readdir(directory, {
          withFileTypes: true,
        });

        entries.sort((a, b) =>
          a.name.localeCompare(b.name),
        );

        for (const entry of entries) {
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }

          const relativeEntry = relativeDirectory
            ? path.join(relativeDirectory, entry.name)
            : entry.name;

          // Reuse the existing sensitive-path policy.
          if (isBlockedPath(relativeEntry)) {
            continue;
          }

          // Never recursively follow symbolic links.
          if (entry.isSymbolicLink()) {
            continue;
          }

          const absoluteEntry = path.join(
            directory,
            entry.name,
          );

          if (entry.isDirectory()) {
            await walk(
              absoluteEntry,
              relativeEntry,
              depth + 1,
            );
            continue;
          }

          if (!entry.isFile()) {
            continue;
          }

          let info;

          try {
            info = await stat(absoluteEntry);
          } catch {
            // A file may disappear during the search.
            continue;
          }

          if (
            !info.isFile() ||
            info.size > MAX_FILE_BYTES
          ) {
            continue;
          }

          if (
            scannedBytes + info.size >
            MAX_SEARCH_TOTAL_BYTES
          ) {
            truncated = true;
            return;
          }

          let content: Buffer;

          try {
            content = await readFile(absoluteEntry);
          } catch {
            continue;
          }

          scannedFiles += 1;
          scannedBytes += content.length;

          // Skip likely binary files.
          if (content.includes(0)) {
            continue;
          }

          const lines = content.toString("utf8")
            .split(/\r?\n/);

          for (
            let index = 0;
            index < lines.length;
            index += 1
          ) {
            const line = lines[index] ?? "";

            if (
              !line.toLowerCase().includes(query)
            ) {
              continue;
            }

            const snippet = line.trim().slice(0, 240);

            matches.push(
              `${relativeEntry}:${index + 1}: ${snippet}`,
            );

            if (matches.length >= maxResults) {
              truncated = true;
              return;
            }
          }
        }
      }

      const relativeStart = path.relative(
        root,
        target,
      );

      await walk(target, relativeStart, 0);

      const summary = [
        `Query: "${rawQuery.trim()}"`,
        `Files scanned: ${scannedFiles}`,
        `Bytes scanned: ${scannedBytes}`,
        `Matches: ${matches.length}`,
      ];

      if (truncated) {
        summary.push(
          "Search stopped at a limit; additional results may exist.",
        );
      }

      if (matches.length === 0) {
        summary.push("No matches found.");
      } else {
        summary.push(...matches);
      }

      return summary.join("\n");
    },
  );

}