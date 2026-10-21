import { afterEach, describe, expect, it } from "vitest";

import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createSandboxWorkspace,
} from "../../src/runtime/workspace.js";

describe("SandboxWorkspace", () => {
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

  it("creates an isolated copy and excludes sensitive files", async () => {
    testRoot = await mkdtemp(
      path.join(os.tmpdir(), "miniharness-workspace-test-"),
    );

    const sourceRoot = path.join(testRoot, "source");

    await mkdir(
      path.join(sourceRoot, "src"),
      { recursive: true },
    );

    await mkdir(
      path.join(sourceRoot, "node_modules", "demo"),
      { recursive: true },
    );

    await mkdir(
      path.join(sourceRoot, ".git"),
      { recursive: true },
    );

    await mkdir(
      path.join(sourceRoot, ".miniharness", "traces"),
      { recursive: true },
    );

    await writeFile(
      path.join(sourceRoot, "package.json"),
      '{"name":"demo"}',
    );

    await writeFile(
      path.join(sourceRoot, "src", "index.ts"),
      "original",
    );

    await writeFile(
      path.join(sourceRoot, ".env"),
      "API_KEY=secret",
    );

    await writeFile(
      path.join(sourceRoot, ".env.local"),
      "TOKEN=secret",
    );

    await writeFile(
      path.join(sourceRoot, "node_modules", "demo", "index.js"),
      "module",
    );

    await writeFile(
      path.join(sourceRoot, ".git", "config"),
      "git config",
    );

    await writeFile(
      path.join(
        sourceRoot,
        ".miniharness",
        "traces",
        "run.jsonl",
      ),
      "{}",
    );

    const sandbox =
      await createSandboxWorkspace(sourceRoot);

    try {
      expect(
        await readFile(
          path.join(sandbox.workspaceRoot, "src", "index.ts"),
          "utf8",
        ),
      ).toBe("original");

      expect(
        existsSync(
          path.join(sandbox.workspaceRoot, ".env"),
        ),
      ).toBe(false);

      expect(
        existsSync(
          path.join(sandbox.workspaceRoot, ".env.local"),
        ),
      ).toBe(false);

      expect(
        existsSync(
          path.join(sandbox.workspaceRoot, "node_modules"),
        ),
      ).toBe(false);

      expect(
        existsSync(
          path.join(sandbox.workspaceRoot, ".git"),
        ),
      ).toBe(false);

      expect(
        existsSync(
          path.join(sandbox.workspaceRoot, ".miniharness"),
        ),
      ).toBe(false);

      // 修改副本，不应改变原始项目。
      await writeFile(
        path.join(sandbox.workspaceRoot, "src", "index.ts"),
        "modified",
      );

      expect(
        await readFile(
          path.join(sourceRoot, "src", "index.ts"),
          "utf8",
        ),
      ).toBe("original");

      // cleanup 应删除副本。
      await sandbox.cleanup();

      await expect(
        access(sandbox.workspaceRoot),
      ).rejects.toThrow();
    } finally {
      await rm(sandbox.workspaceRoot, {
        recursive: true,
        force: true,
      });
    }
  });
});