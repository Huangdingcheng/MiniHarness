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

});