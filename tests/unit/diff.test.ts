
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";

import os from "node:os";
import path from "node:path";

import {
  getWorkspaceChanges,
} from "../../src/runtime/diff.js";

describe("WorkspaceDiff", () => {
  let testRoot = "";

  afterEach(async () => {
    if (testRoot) {
      await rm(testRoot, {
        recursive: true,
        force: true,
      });

      testRoot = "";
    }
  });

  it("detects added, modified, and deleted files", async () => {
    testRoot = await mkdtemp(
      path.join(os.tmpdir(), "miniharness-diff-test-"),
    );

    const sourceRoot = path.join(testRoot, "source");
    const workspaceRoot = path.join(testRoot, "workspace");

    await mkdir(sourceRoot, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });

    // 两边内容相同：不应出现在差异列表中。
    await writeFile(
      path.join(sourceRoot, "same.txt"),
      "same",
    );

    await writeFile(
      path.join(workspaceRoot, "same.txt"),
      "same",
    );

    // 两边内容不同：modified。
    await writeFile(
      path.join(sourceRoot, "modified.txt"),
      "before",
    );

    await writeFile(
      path.join(workspaceRoot, "modified.txt"),
      "after",
    );

    // 只在原始项目中：deleted。
    await writeFile(
      path.join(sourceRoot, "deleted.txt"),
      "old file",
    );

    // 只在工作区中：added。
    await writeFile(
      path.join(workspaceRoot, "added.txt"),
      "new file",
    );

    // 沙箱不应把排除的文件误报为删除。
    await writeFile(
      path.join(sourceRoot, ".env"),
      "SECRET=test",
    );

    await mkdir(
      path.join(sourceRoot, "node_modules", "demo"),
      { recursive: true },
    );

    await writeFile(
      path.join(
        sourceRoot,
        "node_modules",
        "demo",
        "index.js",
      ),
      "module",
    );

    const changes = await getWorkspaceChanges(
      sourceRoot,
      workspaceRoot,
    );

    expect(
      changes.map(({ path: filePath, kind }) => ({
        path: filePath,
        kind,
      })),
    ).toEqual([
      { path: "added.txt", kind: "added" },
      { path: "deleted.txt", kind: "deleted" },
      { path: "modified.txt", kind: "modified" },
    ]);

    const modified = changes.find(
      (change) => change.path === "modified.txt",
    );

    expect(modified?.sourceSha256).not.toBe(
      modified?.workspaceSha256,
    );

    expect(modified?.sourceSize).toBe(6);
    expect(modified?.workspaceSize).toBe(5);
  });

  it("rejects identical source and workspace roots", async () => {
    testRoot = await mkdtemp(
      path.join(os.tmpdir(), "miniharness-diff-root-test-"),
    );

    await expect(
      getWorkspaceChanges(testRoot, testRoot),
    ).rejects.toThrow(
      "Source and workspace must be separate directories.",
    );
  });
});
