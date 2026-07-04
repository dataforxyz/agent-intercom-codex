import test from "node:test";
import assert from "node:assert/strict";
import { getApprovedIntercomToolFromApproval, isIntercomToolApprovalRequest } from "./bridge-daemon.ts";

test("isIntercomToolApprovalRequest accepts exact codex-intercom tools", () => {
  const params = {
    serverName: "codex-intercom",
    _meta: { codex_approval_kind: "mcp_tool_call" },
    message: 'Allow the codex-intercom MCP server to run tool "intercom_ask"?',
  };
  assert.equal(isIntercomToolApprovalRequest(params), true);
  assert.equal(getApprovedIntercomToolFromApproval(params), "intercom_ask");
});

test("isIntercomToolApprovalRequest rejects spoofed or unknown approvals", () => {
  assert.equal(isIntercomToolApprovalRequest({
    serverName: "other-server",
    _meta: { codex_approval_kind: "mcp_tool_call" },
    message: 'Allow the codex-intercom MCP server to run tool "intercom_ask"?',
  }), false);

  assert.equal(isIntercomToolApprovalRequest({
    serverName: "codex-intercom",
    _meta: { codex_approval_kind: "mcp_tool_call" },
    message: 'Allow the codex-intercom MCP server to run tool "shell_exec"?',
  }), false);

  assert.equal(isIntercomToolApprovalRequest({
    serverName: "codex-intercom",
    _meta: { codex_approval_kind: "other" },
    message: 'Allow the codex-intercom MCP server to run tool "intercom_list"?',
  }), false);
});
