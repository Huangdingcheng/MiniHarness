// 显示差异

import { lstat, readFile, realpath } from "node:fs/promises";
import { TextDecoder } from "node:util";
import path from "node:path";

import type { WorkspaceChange } from "./diff.js";

const MAX_TEXT_FILE_BYTES = 256 * 1024;
const MAX_LCS_CELLS = 1_000_000;
const MAX_RENDERED_LINES = 300;

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");

  // 不把文件末尾的换行符当作额外内容行。
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

/**
 * 返回类似 unified diff 的行列表：
 *   unchanged
 * - removed
 * + added
 *
 * 返回 null 表示差异规模过大，不适合使用当前算法。
 */
export function buildLineDiff(
  beforeText: string,
  afterText: string,
): string[] | null {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);

  // 如果规范化后的行完全相同，就没有实际的行级差异。
  // 这也能处理 Windows (\r\n) 与 Unix (\n) 换行符的区别。
  if (
    before.length === after.length &&
    before.every((line, index) => line === after[index])
  ) {
    return [];
  }

  const n = before.length;
  const m = after.length;

  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    return null;
  }

  const dp = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );

  // 从后向前计算最长公共子序列长度。
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] =
        before[i] === after[j]
          ? 1 + dp[i + 1]![j + 1]!
          : Math.max(
              dp[i + 1]![j]!,
              dp[i]![j + 1]!,
            );
    }
  }

  const result: string[] = [];
  let i = 0;
  let j = 0;

  while (i < n || j < m) {
    if (
      i < n &&
      j < m &&
      before[i] === after[j]
    ) {
      result.push(`  ${before[i]}`);
      i += 1;
      j += 1;
    } else if (
      i < n &&
      (
        j >= m ||
        dp[i + 1]![j]! >= dp[i]![j + 1]!
      )
    ) {
      result.push(`- ${before[i]}`);
      i += 1;
    } else {
      result.push(`+ ${after[j]}`);
      j += 1;
    }
  }

  if (result.length > MAX_RENDERED_LINES) {
    return [
      ...result.slice(0, MAX_RENDERED_LINES),
      `... diff truncated; ${result.length - MAX_RENDERED_LINES} more lines omitted`,
    ];
  }

  return result;
}

async function readTextFile(
  root: string,
  relativePath: string,
): Promise<string | null> {
  const absolutePath = path.resolve(
    root,
    ...relativePath.split("/"),
  );

  const relative = path.relative(root, absolutePath);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Path escapes workspace root: ${relativePath}`,
    );
  }

  const info = await lstat(absolutePath);

  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      `Expected a regular file: ${relativePath}`,
    );
  }

  if (info.size > MAX_TEXT_FILE_BYTES) {
    return null;
  }

  const buffer = await readFile(absolutePath);

  // 二进制文件不生成文本差异。
  if (buffer.includes(0)) {
    return null;
  }

  try {
    return new TextDecoder("utf-8", {
      fatal: true,
    }).decode(buffer);
  } catch {
    return null;
  }
}

export async function renderWorkspaceChanges(
  sourceRoot: string,
  workspaceRoot: string,
  changes: WorkspaceChange[],
): Promise<string> {
  if (changes.length === 0) {
    return "No workspace changes detected.";
  }

  const source = await realpath(sourceRoot);
  const workspace = await realpath(workspaceRoot);

  const sections = [
    `Workspace changes: ${changes.length}`,
    "",
  ];

  for (const change of changes) {
    sections.push(
      `[${change.kind.toUpperCase()}] ${change.path}`,
    );

    let beforeText: string | null;
    let afterText: string | null;

    if (change.kind === "added") {
      beforeText = "";
    } else {
      beforeText = await readTextFile(
        source,
        change.path,
      );
    }

    if (change.kind === "deleted") {
      afterText = "";
    } else {
      afterText = await readTextFile(
        workspace,
        change.path,
      );
    }

    if (
      beforeText === null ||
      afterText === null
    ) {
      sections.push(
        "  [Text diff unavailable: binary file or file exceeds 256 KiB.]",
        "",
      );
      continue;
    }

    sections.push(
      `--- source/${change.path}`,
      `+++ workspace/${change.path}`,
    );

    const diff = buildLineDiff(
      beforeText,
      afterText,
    );

    if (diff === null) {
      sections.push(
        "  [Line diff omitted: comparison exceeds the configured size limit.]",
      );
    } else if (diff.length === 0) {
      sections.push(
        "  [No line-level differences; the change may involve line endings.]",
      );
    } else {
      sections.push(...diff);
    }

    sections.push("");
  }

  return sections.join("\n");
}
