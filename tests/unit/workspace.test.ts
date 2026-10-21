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
  getWorkspaceBaselinePath,
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

    await writeFile(
      path.join(sourceRoot, ".npmrc"),
      "//registry.example/:_authToken=test-token",
    );

    await writeFile(
      path.join(sourceRoot, ".pnpmfile.cjs"),
      "module.exports = {};",
    );

    const sandbox =
      await createSandboxWorkspace(sourceRoot);
        
    const baselinePath = getWorkspaceBaselinePath(
      sandbox.workspaceRoot,
    );

    expect(existsSync(baselinePath)).toBe(true);

    const baseline = JSON.parse(
      await readFile(baselinePath, "utf8"),
    ) as {
      version: number;
      sourceRoot: string;
      workspaceRoot: string;
      files: Record<
        string,
        { size: number; sha256: string }
      >;
    };

    expect(baseline.version).toBe(1);

    expect(baseline.sourceRoot).toBe(
      sandbox.sourceRoot,
    );

    expect(baseline.workspaceRoot).toBe(
      sandbox.workspaceRoot,
    );

    expect(
      baseline.files["src/index.ts"]?.sha256,
    ).toMatch(/^[a-f0-9]{64}$/);

    expect(
      baseline.files[".env"],
    ).toBeUndefined();

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

      expect(
        existsSync(
          path.join(sandbox.workspaceRoot, ".npmrc"),
        ),
      ).toBe(false);

      expect(
        existsSync(
          path.join(sandbox.workspaceRoot, ".pnpmfile.cjs"),
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
        access(baselinePath),
      ).rejects.toThrow();

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