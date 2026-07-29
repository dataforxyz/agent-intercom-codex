import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntercomClient } from "../broker/client.ts";
import { CodexBridgeDaemon, VirtualCodexAgent, getApprovedIntercomSend, getApprovedIntercomToolFromApproval, getCompletedIntercomSend, isIntercomToolApprovalRequest, threadSandboxMode } from "./bridge-daemon.ts";

class FakeIntercomClient extends EventEmitter {
  connected = false;
  connectCount = 0;
  sessionId: string | null = null;
  statuses: string[] = [];

  isConnected(): boolean { return this.connected; }
  async connect(_registration: unknown, sessionId?: string): Promise<void> {
    this.connected = true;
    this.connectCount += 1;
    this.sessionId = sessionId ?? "fake-session";
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.sessionId = null;
  }
  updatePresence(presence: { status?: string }): void {
    if (presence.status) this.statuses.push(presence.status);
  }
  drop(): void {
    this.connected = false;
    this.sessionId = null;
    this.emit("disconnected", new Error("broker restarted"));
  }
}

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

test("Codex stream reconnect notifications keep the worker alive and visible as retrying", () => {
  const client = new FakeIntercomClient();
  const agent = new VirtualCodexAgent(
    { id: "codex-stream", name: "codex-stream", cwd: process.cwd() } as any,
    {} as any,
    { agents: { "codex-stream": { threadId: "thread-1", updatedAt: 1 } } },
    "/tmp/codex-stream-state.json",
    {},
    { client: client as unknown as IntercomClient },
  );
  agent.onNotification({
    method: "error",
    params: {
      error: { message: "Reconnecting... 1/5", additionalDetails: "stream closed before response.completed" },
      willRetry: true,
      threadId: "thread-1",
      turnId: "turn-1",
    },
  });
  assert.equal(client.statuses.at(-1), "reconnecting: Reconnecting... 1/5");
});

test("persistent Codex bridge reconnects its stable Intercom identity after broker restart", async () => {
  const client = new FakeIntercomClient();
  const agent = new VirtualCodexAgent(
    { id: "codex-reconnect", name: "codex-reconnect", cwd: process.cwd() } as any,
    {} as any,
    { agents: {} },
    "/tmp/codex-reconnect-state.json",
    {},
    {
      client: client as unknown as IntercomClient,
      prepareConnection: async () => {},
      reconnectDelays: [1],
    },
  );

  await agent.start();
  client.drop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.connectCount, 2);
  assert.equal(client.sessionId, "codex-reconnect");
  await agent.stop();
});

test("threadSandboxMode maps bridge sandbox policies to codex thread modes", () => {
  assert.equal(threadSandboxMode({ type: "readOnly" }), "read-only");
  assert.equal(threadSandboxMode({ type: "workspaceWrite" }), "workspace-write");
  assert.equal(threadSandboxMode({ type: "dangerFullAccess" }), "danger-full-access");
  assert.equal(threadSandboxMode(undefined), "read-only");
});

test("protected bridge rejects hostile PATH Codex before app-client or process creation", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-provider-bridge-"));
  const marker = join(dir, "executed");
  const executable = join(dir, "codex");
  writeFileSync(executable, `#!/bin/sh\nprintf hostile > '${marker}'\n`);
  chmodSync(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    assert.throws(
      () => new CodexBridgeDaemon({
        statePath: join(dir, "state.json"),
        agents: [{ id: "reviewer", name: "reviewer", cwd: dir, bossClient: "boss_reviewer" }],
      }),
      (error: unknown) => (error as { code?: unknown }).code === "PROVIDER_AUTHORITY_UNAVAILABLE",
    );
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(dir, "state.json")), false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
