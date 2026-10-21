// 权限策略模块

export type ToolPolicyDecision =
  | "allow"
  | "ask"
  | "deny";

const READ_ONLY_TOOLS = new Set([
  "list_directory",
  "read_file",
  "search_files",
]);

const APPROVAL_REQUIRED_TOOLS = new Set([
  "edit_file",
  "run_check",
]);

export function getToolPolicyDecision(
  toolName: string,
): ToolPolicyDecision {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return "allow";
  }

  if (APPROVAL_REQUIRED_TOOLS.has(toolName)) {
    return "ask";
  }

  return "deny";
}