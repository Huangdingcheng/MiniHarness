import { randomUUID } from "node:crypto";

import {
  open,
  readdir,
  readFile,
  realpath,
  stat,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";

import path from "node:path";

import type {
  ToolDefinition,
} from "../model/types.js";

import { ToolRegistry } from "./registry.js";
import { shouldExcludeWorkspacePath } from "../runtime/workspace.js";

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


const editFileDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "Replace exactly one occurrence of specified text " +
      "in an existing workspace file. Read the file first. " +
      "If the old text is missing or ambiguous, no changes are made.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative file path.",
        },
        old_text: {
          type: "string",
          description: "Exact existing text to replace.",
        },
        new_text: {
          type: "string",
          description: "Replacement text.",
        },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
};

const writeFileDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "write_file",
    description:
      "Create a new UTF-8 text file inside the workspace. " +
      "The parent directory must already exist. " +
      "This tool never overwrites an existing file; " +
      "use edit_file to modify an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path for the new file.",
        },
        content: {
          type: "string",
          description: "Complete UTF-8 text content for the new file.",
        },
      },
      required: ["path", "content"],
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

  registry.register(
    editFileDefinition,
    async (args) => {
      const rawPath = args.path;
      const oldText = args.old_text;
      const newText = args.new_text;

      if (
        typeof rawPath !== "string" ||
        rawPath.trim() === ""
      ) {
        throw new Error("path must be a non-empty string.");
      }

      if (
        typeof oldText !== "string" ||
        oldText.length === 0
      ) {
        throw new Error("old_text must be a non-empty string.");
      }

      if (typeof newText !== "string") {
        throw new Error("new_text must be a string.");
      }

      if (
        Buffer.byteLength(oldText, "utf8") > MAX_FILE_BYTES ||
        Buffer.byteLength(newText, "utf8") > MAX_FILE_BYTES
      ) {
        throw new Error("Edit text exceeds the size limit.");
      }

      // Reuse the existing workspace boundary checks.
      const target = await resolveWorkspacePath(
        root,
        rawPath,
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

      const original = await readFile(target, "utf8");

      if (original.includes("\0")) {
        throw new Error(
          "Binary files cannot be edited by this tool.",
        );
      }

      // Count exact, non-overlapping occurrences.
      let occurrences = 0;
      let offset = 0;

      while (true) {
        const index = original.indexOf(oldText, offset);

        if (index === -1) {
          break;
        }

        occurrences += 1;
        offset = index + oldText.length;
      }

      if (occurrences !== 1) {
        throw new Error(
          `Expected exactly one match for old_text, ` +
          `found ${occurrences}. No changes made.`,
        );
      }

      const updated = original.replace(oldText, newText);

      if (
        Buffer.byteLength(updated, "utf8") > MAX_FILE_BYTES
      ) {
        throw new Error(
          `Updated file exceeds the ${MAX_FILE_BYTES}-byte limit.`,
        );
      }

      // Write a temporary file in the same directory, then rename.
      const tempPath = path.join(
        path.dirname(target),
        `.${path.basename(target)}.miniharness-${randomUUID()}.tmp`,
      );

      try {
        await writeFile(tempPath, updated, {
          encoding: "utf8",
          flag: "wx",
          mode: info.mode & 0o777,
        });

        await rename(tempPath, target);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);

        const reason =
          error instanceof Error
            ? error.message
            : String(error);

        throw new Error(`Failed to update file: ${reason}`);
      }

      return [
        `File updated successfully: ${path.relative(root, target)}`,
        "Replaced exactly one occurrence.",
      ].join("\n");
    },
  );

  registry.register(
    writeFileDefinition,
    async (args) => {
      const rawPath = args.path;
      const content = args.content;

      if (
        typeof rawPath !== "string" ||
        rawPath.trim() === ""
      ) {
        throw new Error("path must be a non-empty string.");
      }

      if (path.isAbsolute(rawPath)) {
        throw new Error("path must be workspace-relative.");
      }

      if (typeof content !== "string") {
        throw new Error("content must be a string.");
      }

      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
        throw new Error(
          `File content exceeds the ${MAX_FILE_BYTES}-byte limit.`,
        );
      }

      if (content.includes("\0")) {
        throw new Error(
          "Binary content cannot be written by this tool.",
        );
      }

      // Validate the lexical path before resolving any parent symlinks.
      const candidate = path.resolve(root, rawPath);

      if (!isWithinRoot(root, candidate)) {
        throw new Error("Path is outside the workspace.");
      }

      const relativeCandidate = path.relative(root, candidate);

      if (
        relativeCandidate === "" ||
        isBlockedPath(relativeCandidate) ||
        shouldExcludeWorkspacePath(relativeCandidate)
      ) {
        throw new Error(
          relativeCandidate === ""
            ? "path must point to a file inside the workspace."
            : "Access to this path is blocked.",
        );
      }

      // Resolve the existing parent directory. Requiring it to exist avoids
      // recursively creating directories through an untrusted path.
      let parent: string;

      try {
        parent = await realpath(path.dirname(candidate));
      } catch (error) {
        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined;

        if (code === "ENOENT" || code === "ENOTDIR") {
          throw new Error(
            "Parent directory does not exist. Create or choose an existing directory first.",
          );
        }

        throw error;
      }

      if (!isWithinRoot(root, parent)) {
        throw new Error("Path is outside the workspace.");
      }

      const relativeParent = path.relative(root, parent);

      if (
        isBlockedPath(relativeParent) ||
        shouldExcludeWorkspacePath(relativeParent)
      ) {
        throw new Error("Access to this path is blocked.");
      }

      const parentInfo = await stat(parent);

      if (!parentInfo.isDirectory()) {
        throw new Error("Parent path is not a directory.");
      }

      // Use the canonical parent path and exclusive creation ("wx") so an
      // existing file or symlink can never be overwritten.
      const target = path.join(parent, path.basename(candidate));
      const relativeTarget = path.relative(root, target);

      if (
        !isWithinRoot(root, target) ||
        isBlockedPath(relativeTarget) ||
        shouldExcludeWorkspacePath(relativeTarget)
      ) {
        throw new Error("Access to this path is blocked.");
      }

      let created = false;

      try {
        const handle = await open(target, "wx", 0o666);
        created = true;

        try {
          await handle.writeFile(content, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (created) {
          await unlink(target).catch(() => undefined);
        }

        const code =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined;

        if (code === "EEXIST") {
          throw new Error(
            "File already exists; write_file never overwrites existing files.",
          );
        }

        const reason =
          error instanceof Error ? error.message : String(error);

        throw new Error(`Failed to create file: ${reason}`);
      }

        const relativePath = path
          .relative(root, target)
          .split(path.sep)
          .join("/");

        return [
          `File created successfully: ${relativePath}`,
          `Bytes written: ${Buffer.byteLength(content, "utf8")}`,
        ].join("\n");
    },
  );

}