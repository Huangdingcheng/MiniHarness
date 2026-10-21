import { afterEach, describe, expect, it } from "vitest";

import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  createSandboxWorkspace,
  type SandboxWorkspace,
} from "../../src/runtime/workspace.js";

import { inspectWorkspaceWriteback } from "../../src/runtime/writeback-check.js";

describe("WorkspaceWritebackCheck", () => {
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
      path.join(os.tmpdir(), "miniharness-writeback-test-"),
    );

    const sourceRoot = path.join(testRoot, "source");

    await mkdir(path.join(sourceRoot, "src"), { recursive: true });

    await writeFile(
      path.join(sourceRoot, "src", "demo.ts"),
      'export const value = "original";\n',
    );

    sandbox = await createSandboxWorkspace(sourceRoot);

    return {
      sourceRoot,
      workspaceRoot: sandbox.workspaceRoot,
    };
  }

  it("marks a modified file ready when the original matches baseline", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    await writeFile(
      path.join(workspaceRoot, "src", "demo.ts"),
      'export const value = "agent-change";\n',
    );

    const results = await inspectWorkspaceWriteback(sourceRoot, workspaceRoot);

    expect(results).toHaveLength(1);

    expect(results[0]).toMatchObject({
      path: "src/demo.ts",
      kind: "modified",
      status: "ready",
    });
  });

  it("detects a conflict when the original changes after baseline creation", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    // Agent 修改沙箱副本。
    await writeFile(
      path.join(workspaceRoot, "src", "demo.ts"),
      'export const value = "agent-change";\n',
    );

    // 模拟用户同时修改原始项目。
    await writeFile(
      path.join(sourceRoot, "src", "demo.ts"),
      'export const value = "user-change";\n',
    );

    const results = await inspectWorkspaceWriteback(sourceRoot, workspaceRoot);

    expect(results).toHaveLength(1);

    expect(results[0]).toMatchObject({
      path: "src/demo.ts",
      kind: "modified",
      status: "conflict",
    });

    expect(results[0]?.reason).toContain("changed after the baseline");
  });

  it("marks a new file ready when its destination is available", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    await writeFile(
      path.join(workspaceRoot, "new-file.txt"),
      "created by agent\n",
    );

    const results = await inspectWorkspaceWriteback(sourceRoot, workspaceRoot);

    expect(results).toHaveLength(1);

    expect(results[0]).toMatchObject({
      path: "new-file.txt",
      kind: "added",
      status: "ready",
    });
  });

  it("detects a conflict when a new file's destination is occupied", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    await writeFile(
      path.join(workspaceRoot, "new-file.txt"),
      "created by agent\n",
    );

    // 模拟沙箱创建后，原始项目出现同名文件。
    await writeFile(path.join(sourceRoot, "new-file.txt"), "created by user\n");

    const results = await inspectWorkspaceWriteback(sourceRoot, workspaceRoot);

    expect(results).toHaveLength(1);

    expect(results[0]?.status).toBe("conflict");
  });

  it("marks a deletion ready when the original still matches baseline", async () => {
    const { sourceRoot, workspaceRoot } = await setup();

    await unlink(path.join(workspaceRoot, "src", "demo.ts"));

    const results = await inspectWorkspaceWriteback(sourceRoot, workspaceRoot);

    expect(results).toHaveLength(1);

    expect(results[0]).toMatchObject({
      path: "src/demo.ts",
      kind: "deleted",
      status: "ready",
    });
  });
});
