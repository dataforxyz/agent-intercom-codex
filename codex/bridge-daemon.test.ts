import test from "node:test";
import assert from "node:assert/strict";
import { getApprovedIntercomSend, getApprovedIntercomToolFromApproval, getCompletedIntercomSend, isIntercomToolApprovalRequest } from "./bridge-daemon.ts";

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

test("getCompletedIntercomSend extracts MCP intercom_send tool calls", () => {
  assert.deepEqual(getCompletedIntercomSend({
    item: {
      type: "function_call",
      name: "mcp__codex_intercom.intercom_send",
      arguments: JSON.stringify({ to: "manager", message: "ACK" }),
    },
  }), { to: "manager", message: "ACK" });

  assert.deepEqual(getCompletedIntercomSend({
    item: {
      type: "function_call",
      name: "mcp__codex_intercom__intercom_send",
      arguments: { to: "manager", message: "ACK" },
    },
  }), { to: "manager", message: "ACK" });
});

test("getCompletedIntercomSend ignores non-send and malformed tool calls", () => {
  assert.equal(getCompletedIntercomSend({ item: { name: "intercom_reply", arguments: "{}" } }), null);
  assert.equal(getCompletedIntercomSend({ item: { name: "intercom_send", arguments: "not-json" } }), null);
  assert.equal(getCompletedIntercomSend({ item: { name: "intercom_send", arguments: { to: "manager" } } }), null);
});

test("getApprovedIntercomSend extracts approved intercom_send tool params", () => {
  assert.deepEqual(getApprovedIntercomSend({
    serverName: "codex-intercom",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool: "intercom_send",
      tool_params: { to: "manager", message: "ACK" },
    },
  }), { to: "manager", message: "ACK" });

  assert.equal(getApprovedIntercomSend({
    serverName: "codex-intercom",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool: "intercom_reply",
      tool_params: { to: "manager", message: "ACK" },
    },
  }), null);
});
