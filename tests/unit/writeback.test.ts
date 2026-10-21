
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import { ToolRegistry } from "../../src/tools/registry.js";
import {
  registerFileSystemTools,
} from "../../src/tools/filesystem.js";

import {
  createSandboxWorkspace,
  type SandboxWorkspace,
} from "../../src/runtime/workspace.js";

import {
  applyWorkspaceChanges,
} from "../../src/runtime/writeback.js";

describe("WorkspaceWriteback", () => {
  let testRoot = "";
  let sandbox: SandboxWorkspace | undefined;

  afterEach(async () => {
    if (sandbox) {
      await sandbox.cleanup();
      sandbox = undefined;
    }

    if (testRoot) {
      await rm(testRoot, {
        recursive: true,
        force: true,
      });

      testRoot = "";
    }
  });

  async function setup() {
    testRoot = await mkdtemp(
      path.join(os.tmpdir(), "miniharness-writeback-"),
    );

    const sourceRoot = path.join(testRoot, "source");

    await mkdir(path.join(sourceRoot, "src"), {
      recursive: true,
    });

    await writeFile(
      path.join(sourceRoot, "src", "demo.ts"),
      'export const value = "original";\n',
    );

    await writeFile(
      path.join(sourceRoot, "src", "other.ts"),
      'export const other = "original";\n',
    );

    sandbox = await createSandboxWorkspace(sourceRoot);

    return {
      sourceRoot,
      workspaceRoot: sandbox.workspaceRoot,
    };
  }

  it("creates a file with write_file and writes it back after approval", async () => {
    const { sourceRoot, workspaceRoot } = await setup();
    const registry = new ToolRegistry();
    const content = 'export const generated = true;\n';

    await registerFileSystemTools(registry, workspaceRoot);

    const result = await registry.execute(
      "write_file",
      JSON.stringify({
        path: "src/generated.ts",
        content,
      }),
    );

    expect(result).toContain(
      "File created successfully: src/generated.ts",
    );

    const applied = await applyWorkspaceChanges(
      sourceRoot,
      workspaceRoot,
      ["src/generated.ts"],
    );

    expect(applied).toEqual([
      {
        path: "src/generated.ts",
        kind: "added",
        status: "applied",
      },
    ]);

    await expect(
      readFile(
        path.join(sourceRoot, "src", "generated.ts"),
        "utf8",
      ),
    ).resolves.toBe(content);
  });

  it("applies an approved modification", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    await writeFile(
      path.join(workspaceRoot, "src", "demo.ts"),
      'export const value = "updated";\n',
    );

    const results = await applyWorkspaceChanges(
      sourceRoot,
      workspaceRoot,
      ["src/demo.ts"],
    );

    expect(results).toMatchObject([
      {
        path: "src/demo.ts",
        kind: "modified",
        status: "applied",
      },
    ]);

    await expect(
      readFile(
        path.join(sourceRoot, "src", "demo.ts"),
        "utf8",
      ),
    ).resolves.toContain('"updated"');
  });

  it("creates an approved new file and its parent directories", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    await mkdir(
      path.join(workspaceRoot, "new-dir"),
      { recursive: true },
    );

    await writeFile(
      path.join(workspaceRoot, "new-dir", "note.txt"),
      "created by agent\n",
    );

    await applyWorkspaceChanges(
      sourceRoot,
      workspaceRoot,
      ["new-dir/note.txt"],
    );

    await expect(
      readFile(
        path.join(sourceRoot, "new-dir", "note.txt"),
        "utf8",
      ),
    ).resolves.toBe("created by agent\n");
  });

  it("deletes an approved file", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    await unlink(
      path.join(workspaceRoot, "src", "demo.ts"),
    );

    await applyWorkspaceChanges(
      sourceRoot,
      workspaceRoot,
      ["src/demo.ts"],
    );

    await expect(
      readFile(
        path.join(sourceRoot, "src", "demo.ts"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a conflict without overwriting the original", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    await writeFile(
      path.join(workspaceRoot, "src", "demo.ts"),
      'export const value = "agent";\n',
    );

    await writeFile(
      path.join(sourceRoot, "src", "demo.ts"),
      'export const value = "user";\n',
    );

    await expect(
      applyWorkspaceChanges(
        sourceRoot,
        workspaceRoot,
        ["src/demo.ts"],
      ),
    ).rejects.toThrow("Writeback blocked");

    await expect(
      readFile(
        path.join(sourceRoot, "src", "demo.ts"),
        "utf8",
      ),
    ).resolves.toContain('"user"');
  });

  it("rejects paths outside the workspace", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    await expect(
      applyWorkspaceChanges(
        sourceRoot,
        workspaceRoot,
        ["../outside.txt"],
      ),
    ).rejects.toThrow("Path traversal rejected");
  });

  
  it("applies only explicitly approved files", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    await writeFile(
      path.join(workspaceRoot, "src", "demo.ts"),
      'export const value = "agent";\n',
    );

    await writeFile(
      path.join(workspaceRoot, "src", "other.ts"),
      'export const other = "agent";\n',
    );

    // 只批准 demo.ts，不批准 other.ts。
    await applyWorkspaceChanges(
      sourceRoot,
      workspaceRoot,
      ["src/demo.ts"],
    );

    await expect(
      readFile(
        path.join(sourceRoot, "src", "demo.ts"),
        "utf8",
      ),
    ).resolves.toContain('"agent"');

    await expect(
      readFile(
        path.join(sourceRoot, "src", "other.ts"),
        "utf8",
      ),
    ).resolves.toContain('"original"');
  });

  it("applies no files when any approved file has a conflict", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    await writeFile(
      path.join(workspaceRoot, "src", "demo.ts"),
      'export const value = "agent";\n',
    );

    await writeFile(
      path.join(workspaceRoot, "src", "other.ts"),
      'export const other = "agent";\n',
    );

    // 模拟用户在沙箱创建后修改原始文件。
    await writeFile(
      path.join(sourceRoot, "src", "demo.ts"),
      'export const value = "user";\n',
    );

    // other.ts 虽然没有冲突，但 demo.ts 有冲突。
    // 整批操作应在写入前被拒绝。
    await expect(
      applyWorkspaceChanges(
        sourceRoot,
        workspaceRoot,
        ["src/other.ts", "src/demo.ts"],
      ),
    ).rejects.toThrow("Writeback blocked");

    await expect(
      readFile(
        path.join(sourceRoot, "src", "other.ts"),
        "utf8",
      ),
    ).resolves.toContain('"original"');

    await expect(
      readFile(
        path.join(sourceRoot, "src", "demo.ts"),
        "utf8",
      ),
    ).resolves.toContain('"user"');
  });
});
