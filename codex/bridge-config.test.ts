import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertHardenedBossAgentConfig, assertHardenedBossBridgeConfig, bridgeAgentApprovalPolicy, bridgeAgentDefaultSandbox, defaultBridgeConfig, loadBridgeConfig, loadBridgeState, saveBridgeState } from "./bridge-config.ts";

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
      appServer: { command: "codex", args: ["app-server"], transport: "unix-websocket", socketPath: "/tmp/codex.sock", startDaemon: false },
      agents: [{ id: "worker", cwd: dir, instructions: "Stay terse." }],
    }));
    const config = loadBridgeConfig(path);
    assert.equal(config.statePath, join(dir, "state.json"));
    assert.deepEqual(config.appServer?.args, ["app-server"]);
    assert.equal(config.appServer?.transport, "unix-websocket");
    assert.equal(config.appServer?.socketPath, "/tmp/codex.sock");
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

test("missing config and state initialization is read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-bridge-read-only-init-"));
  try {
    assert.deepEqual(readdirSync(dir), []);
    loadBridgeConfig(join(dir, "missing-config.json"));
    assert.deepEqual(loadBridgeState(join(dir, "missing-state.json")), { agents: {} });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hardened Boss clients default safely and reject yolo-equivalent policy", () => {
  const reviewer = defaultBridgeConfig({
    CODEX_INTERCOM_BRIDGE_ID: "reviewer",
    CODEX_INTERCOM_BRIDGE_CWD: "/tmp",
    CODEX_INTERCOM_BOSS_CLIENT: "boss_reviewer",
  }).agents[0];
  assert.equal(bridgeAgentApprovalPolicy(reviewer), "untrusted");
  assert.equal(bridgeAgentDefaultSandbox(reviewer), "read-only");

  const dir = mkdtempSync(join(tmpdir(), "codex-bridge-boss-policy-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({
      agents: [{
        id: "participant",
        bossClient: "boss_participant",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      }],
    }));
    assert.throws(() => loadBridgeConfig(path), /cannot use danger-full-access/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hardened Boss bridge validates every app-server and daemon argv position and form", () => {
  const agent = {
    id: "reviewer",
    name: "reviewer",
    cwd: "/tmp",
    bossClient: "boss_reviewer" as const,
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  };
  assert.throws(
    () => assertHardenedBossBridgeConfig({ agents: [agent], statePath: "/tmp/state", appServer: { args: ["app-server", "--profile=unsafe"] } }),
    /raw --profile/,
  );
  assert.throws(
    () => assertHardenedBossAgentConfig({ ...agent, sandboxPolicy: { type: "readOnly", networkAccess: true } }),
    /networkAccess must be false/,
  );
  assert.throws(
    () => assertHardenedBossBridgeConfig({ agents: [agent], statePath: "/tmp/state", appServer: { command: "/attacker/codex" } }),
    /caller-provided app-server commands/,
  );
  assert.throws(
    () => assertHardenedBossBridgeConfig({ agents: [agent], statePath: "/tmp/state", appServer: { args: ["app-server", "--", "--enable=escape"] } }),
    /raw --enable/,
  );
  const overrides = [
    ["--sandbox", /policy override/], ["--sandbox=workspace-write", /policy override/],
    ["-s", /policy override/], ["-s=workspace-write", /policy override/], ["-sworkspace-write", /policy override/],
    ["--ask-for-approval", /policy override/], ["--ask-for-approval=untrusted", /policy override/],
    ["-a", /policy override/], ["-a=untrusted", /policy override/], ["-anever", /policy override/],
    ["-C", /launch escape/], ["-C\/etc", /launch escape/],
  ] as const;
  for (const field of ["args", "startDaemonArgs"] as const) {
    for (const [override, expected] of overrides) {
      for (const argv of [["app-server", override], ["app-server", "--", override]]) {
        assert.throws(
          () => assertHardenedBossBridgeConfig({ agents: [agent], statePath: "/tmp/state", appServer: { [field]: argv } }),
          expected,
          `${field} must reject ${override} in ${argv.join(" ")}`,
        );
      }
    }
  }
  assert.doesNotThrow(() => assertHardenedBossBridgeConfig({ agents: [agent], statePath: "/tmp/state", appServer: { args: [], startDaemonArgs: [] } }));
  assert.doesNotThrow(() => assertHardenedBossBridgeConfig({
    agents: [{ id: "ordinary", name: "ordinary", cwd: "/tmp" }],
    statePath: "/tmp/state",
    appServer: { args: ["app-server", "-sworkspace-write", "-anever", "-C/etc"] },
  }));
});

test("writable Boss participants fail closed without broker-owned assigned-root authority", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-boss-root-"));
  try {
    const inside = join(dir, "inside");
    const rootAlias = join(dir, "root-alias");
    mkdirSync(inside);
    symlinkSync("/", rootAlias);
    const candidates = [
      { cwd: inside, roots: [inside] },
      { cwd: "/etc", roots: ["/etc"] },
      { cwd: "/", roots: ["/"] },
      { cwd: rootAlias, roots: [rootAlias] },
      { cwd: `${inside}/..`, roots: [`${inside}/..`] },
    ];
    for (const candidate of candidates) {
      assert.throws(() => assertHardenedBossAgentConfig({
        id: "worker",
        name: "worker",
        cwd: candidate.cwd,
        bossClient: "boss_participant",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: candidate.roots, networkAccess: false },
      }), /broker-owned assigned workspace authority|filesystem root/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
