import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultBridgeConfig, loadBridgeConfig, loadBridgeState, saveBridgeState } from "./bridge-config.ts";

test("defaultBridgeConfig builds one virtual worker from env", () => {
  const config = defaultBridgeConfig({
    CODEX_INTERCOM_BRIDGE_ID: "planner",
    CODEX_INTERCOM_BRIDGE_NAME: "Planner",
    CODEX_INTERCOM_BRIDGE_CWD: "/tmp",
    CODEX_INTERCOM_BRIDGE_MODEL: "gpt-test",
  });
  assert.equal(config.agents.length, 1);
  assert.equal(config.agents[0].id, "planner");
  assert.equal(config.agents[0].name, "Planner");
  assert.equal(config.agents[0].model, "gpt-test");
});

test("loadBridgeConfig parses agents and app-server options", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-bridge-config-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({
      statePath: join(dir, "state.json"),
      appServer: { command: "codex", args: ["app-server"], startDaemon: false },
      agents: [{ id: "worker", cwd: dir, instructions: "Stay terse." }],
    }));
    const config = loadBridgeConfig(path);
    assert.equal(config.statePath, join(dir, "state.json"));
    assert.deepEqual(config.appServer?.args, ["app-server"]);
    assert.equal(config.appServer?.startDaemon, false);
    assert.equal(config.agents[0].name, "worker");
    assert.equal(config.agents[0].instructions, "Stay terse.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadBridgeState and saveBridgeState persist thread ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-bridge-state-"));
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "state.json");
    saveBridgeState(path, { agents: { worker: { threadId: "thread-1", updatedAt: 123 } } });
    assert.deepEqual(loadBridgeState(path), { agents: { worker: { threadId: "thread-1", updatedAt: 123 } } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
