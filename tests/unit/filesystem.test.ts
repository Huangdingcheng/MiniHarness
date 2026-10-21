import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ToolRegistry } from "../../src/tools/registry.js";

import {
  registerFileSystemTools,
} from "../../src/tools/filesystem.js";

describe("FileSystemTools", () => {
  let root: string;

  afterEach(async () => {
    if (root) {
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  });

  async function setup(): Promise<ToolRegistry> {
    root = await mkdtemp(
      path.join(os.tmpdir(), "mini-harness-"),
    );

    await mkdir(path.join(root, "src"));

    await writeFile(
      path.join(root, "src", "example.ts"),
      "export const answer = 42;\n",
    );

    await writeFile(
      path.join(root, ".env"),
      "LLM_API_KEY=secret-test-value\n",
    );

    await mkdir(path.join(root, "node_modules"));

    const registry = new ToolRegistry();

    await registerFileSystemTools(registry, root);

    return registry;
  }

  it("lists workspace entries without sensitive files", async () => {
    const registry = await setup();

    const output = await registry.execute(
      "list_directory",
      JSON.stringify({ path: "." }),
    );

    expect(output).toContain("[dir] src");
    expect(output).not.toContain(".env");
    expect(output).not.toContain("node_modules");
  });

  it("reads a file inside the workspace", async () => {
    const registry = await setup();

    const output = await registry.execute(
      "read_file",
      JSON.stringify({ path: "src/example.ts" }),
    );

    expect(output).toContain(
      "export const answer = 42;",
    );
  });

  it("blocks workspace traversal", async () => {
    const registry = await setup();

    await expect(
      registry.execute(
        "read_file",
        JSON.stringify({ path: "../outside.txt" }),
      ),
    ).rejects.toThrow("Path is outside the workspace.");
  });

  it("blocks reading the .env file", async () => {
    const registry = await setup();

    await expect(
      registry.execute(
        "read_file",
        JSON.stringify({ path: ".env" }),
      ),
    ).rejects.toThrow("Access to this path is blocked.");
  });

  
it("searches files and reports line numbers", async () => {
  const registry = await setup();

  const output = await registry.execute(
    "search_files",
    JSON.stringify({
      query: "answer",
      path: "src",
    }),
  );

  const normalized = output.replaceAll("\\", "/");

  expect(normalized).toContain(
    "example.ts:1: export const answer = 42;",
  );

  expect(output).toContain("Files scanned:");
  expect(output).toContain("Matches: 1");
});

it("does not expose secrets from blocked files", async () => {
  const registry = await setup();

  const output = await registry.execute(
    "search_files",
    JSON.stringify({
      query: "LLM_API_KEY",
      path: ".",
    }),
  );

  expect(output).not.toContain("secret-test-value");
  expect(output).not.toContain(".env:");
  expect(output).toContain("No matches found.");
});


it("creates a new file in the workspace", async () => {
  const registry = await setup();
  const content = 'export const greeting = "hello";\n';

  const result = await registry.execute(
    "write_file",
    JSON.stringify({
      path: "src/new-file.ts",
      content,
    }),
  );

  expect(result).toContain(
    "File created successfully: src/new-file.ts",
  );

  await expect(
    readFile(
      path.join(root, "src", "new-file.ts"),
      "utf8",
    ),
  ).resolves.toBe(content);
});

it("never overwrites an existing file with write_file", async () => {
  const registry = await setup();
  const filePath = path.join(root, "src", "example.ts");

  await expect(
    registry.execute(
      "write_file",
      JSON.stringify({
        path: "src/example.ts",
        content: "replacement content\n",
      }),
    ),
  ).rejects.toThrow(
    "File already exists; write_file never overwrites existing files.",
  );

  await expect(
    readFile(filePath, "utf8"),
  ).resolves.toBe("export const answer = 42;\n");
});

it("blocks creating files outside the workspace or in blocked paths", async () => {
  const registry = await setup();

  await expect(
    registry.execute(
      "write_file",
      JSON.stringify({
        path: "../outside.ts",
        content: "unsafe",
      }),
    ),
  ).rejects.toThrow("Path is outside the workspace.");

  await expect(
    registry.execute(
      "write_file",
      JSON.stringify({
        path: path.join(root, "src", "absolute.ts"),
        content: "unsafe",
      }),
    ),
  ).rejects.toThrow("path must be workspace-relative.");

  await expect(
    registry.execute(
      "write_file",
      JSON.stringify({
        path: ".env.local",
        content: "LLM_API_KEY=unsafe",
      }),
    ),
  ).rejects.toThrow("Access to this path is blocked.");
});

it("requires the parent directory to exist", async () => {
  const registry = await setup();

  await expect(
    registry.execute(
      "write_file",
      JSON.stringify({
        path: "missing-dir/new-file.ts",
        content: "export {};\n",
      }),
    ),
  ).rejects.toThrow("Parent directory does not exist.");
});

it("rejects binary content and oversized files", async () => {
  const registry = await setup();

  await expect(
    registry.execute(
      "write_file",
      JSON.stringify({
        path: "src/binary.txt",
        content: "before\0after",
      }),
    ),
  ).rejects.toThrow("Binary content cannot be written by this tool.");

  await expect(
    registry.execute(
      "write_file",
      JSON.stringify({
        path: "src/large.txt",
        content: "x".repeat(100_001),
      }),
    ),
  ).rejects.toThrow("File content exceeds the 100000-byte limit.");
});

it("replaces exactly one occurrence in a file", async () => {
  const registry = await setup();

  const result = await registry.execute(
    "edit_file",
    JSON.stringify({
      path: "src/example.ts",
      old_text: "answer = 42",
      new_text: "answer = 43",
    }),
  );

  expect(result).toContain("File updated successfully");

  const updated = await readFile(
    path.join(root, "src", "example.ts"),
    "utf8",
  );

  expect(updated).toContain("answer = 43");
  expect(updated).not.toContain("answer = 42");
});

it("rejects ambiguous edits without changing the file", async () => {
  const registry = await setup();

  const filePath = path.join(root, "src", "example.ts");

  await writeFile(
    filePath,
    "const value = 1;\nconst value = 1;\n",
  );

  await expect(
    registry.execute(
      "edit_file",
      JSON.stringify({
        path: "src/example.ts",
        old_text: "const value = 1;",
        new_text: "const value = 2;",
      }),
    ),
  ).rejects.toThrow(
    "Expected exactly one match for old_text, found 2.",
  );

  const unchanged = await readFile(filePath, "utf8");

  expect(unchanged).toBe(
    "const value = 1;\nconst value = 1;\n",
  );
});

it("blocks edits to .env", async () => {
  const registry = await setup();

  await expect(
    registry.execute(
      "edit_file",
      JSON.stringify({
        path: ".env",
        old_text: "LLM_API_KEY",
        new_text: "OTHER_KEY",
      }),
    ),
  ).rejects.toThrow("Access to this path is blocked.");
});

});