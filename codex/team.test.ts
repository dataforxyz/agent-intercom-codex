import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatIntercomTeam, resolveIntercomTeam, type TeamSession } from "./team.ts";

const legacyWorker = (id: string, runId: string, managerSessionId: string, state = "running") => ({
  id, runId, harness: "codex", role: "reviewer", state, owned: true, managerSessionId, intercomTarget: id,
});

const bossWorker = (
  id: string,
  bossRunId: string,
  participantId: string,
  role: "manager" | "worker" = "worker",
  intercomTarget = id,
) => ({
  id,
  workerIncarnationId: `incarnation-${id}`,
  workerGeneration: 1,
  bossRunId,
  participantId,
  bindingEpoch: 1,
  harness: "codex",
  role,
  state: "working",
  owned: true,
  managerSessionId: "manager-session",
  intercomTarget,
});

function bossSession(worker: ReturnType<typeof bossWorker>): TeamSession {
  return {
    id: worker.intercomTarget,
    boss: {
      binding: {
        bossRunId: worker.bossRunId,
        participantId: worker.participantId,
        bindingEpoch: worker.bindingEpoch,
        role: worker.role,
        sessionId: worker.intercomTarget,
        state: "active",
      },
      workerIdentity: {
        version: "orc.worker-identity.v2",
        workerId: worker.id,
        workerIncarnationId: worker.workerIncarnationId,
        workerGeneration: worker.workerGeneration,
        bossRunId: worker.bossRunId,
        participantId: worker.participantId,
        bindingEpoch: worker.bindingEpoch,
      },
      participantState: worker.state,
    },
  };
}

const bossEnv = {
  AGENT_INTERCOM_WORKER_ID: "self",
  AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-self",
  AGENT_INTERCOM_WORKER_GENERATION: "1",
  AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
  AGENT_INTERCOM_PARTICIPANT_ID: "participant-self",
  AGENT_INTERCOM_BINDING_EPOCH: "1",
};

test("ordinary team discovery follows the orchestrator owner instead of stale worker environment", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-team-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(join(dir, "workers.json"), JSON.stringify({
      version: 1,
      workers: [legacyWorker("self", "run-self", "manager-new"), legacyWorker("peer", "run-peer", "manager-new"), legacyWorker("old", "run-old", "manager-old")],
    }));
    const team = await resolveIntercomTeam({
      selfId: "mcp-helper",
      agentDir,
      env: { AGENT_INTERCOM_WORKER_ID: "self", AGENT_INTERCOM_RUN_ID: "run-self", AGENT_INTERCOM_MANAGER_SESSION_ID: "manager-old" },
      sessions: [{ id: "manager-new" }, { id: "peer" }],
    });
    assert.equal(team.manager?.target, "manager-new");
    assert.equal(team.manager?.connected, true);
    assert.deepEqual(team.coworkers.map((entry) => entry.id), ["peer"]);
    assert.match(formatIntercomTeam(team), /You: self/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Boss roster intersects exact session/run/participant/epoch/role/incarnation/generation/state", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-team-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const self = bossWorker("self", "boss-run-1", "participant-self", "worker", "self-session");
    const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
    const peer = bossWorker("same-run", "boss-run-1", "participant-peer");
    const hidden = bossWorker("hidden-same-run", "boss-run-1", "participant-hidden");
    const other = bossWorker("other-run", "boss-run-2", "participant-other");
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [self, manager, peer, hidden, other] }));
    const team = await resolveIntercomTeam({
      selfId: "self-session",
      agentDir,
      env: bossEnv,
      sessions: [bossSession(self), bossSession(manager), bossSession(peer), bossSession(other)],
    });
    assert.equal(team.self.isManager, false);
    assert.equal(team.manager?.connected, true);
    assert.deepEqual(team.coworkers, [], "a Worker must not discover a sibling Worker");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a current-run Manager retains exact live visibility of its owned Workers", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-manager-team-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
    const workerOne = bossWorker("worker-one", "boss-run-1", "participant-one");
    const workerTwo = bossWorker("worker-two", "boss-run-1", "participant-two");
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [manager, workerOne, workerTwo] }));
    const team = await resolveIntercomTeam({
      selfId: "manager-session",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "manager",
        AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-manager",
        AGENT_INTERCOM_WORKER_GENERATION: "1",
        AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
        AGENT_INTERCOM_PARTICIPANT_ID: "participant-manager",
        AGENT_INTERCOM_BINDING_EPOCH: "1",
      },
      sessions: [bossSession(manager), bossSession(workerOne), bossSession(workerTwo)],
    });
    assert.deepEqual(team.coworkers.map((entry) => entry.id), ["worker-one", "worker-two"]);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a Boss Manager cannot discover a roster through a substituted selfId", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-substituted-self-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
    const worker = bossWorker("worker", "boss-run-1", "participant-worker", "worker", "worker-session");
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [manager, worker] }));
    const team = await resolveIntercomTeam({
      selfId: "worker-session",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "manager",
        AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-manager",
        AGENT_INTERCOM_WORKER_GENERATION: "1",
        AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
        AGENT_INTERCOM_PARTICIPANT_ID: "participant-manager",
        AGENT_INTERCOM_BINDING_EPOCH: "1",
      },
      sessions: [bossSession(manager), bossSession(worker)],
    });
    assert.equal(team.self.id, "worker-session");
    assert.equal(team.self.isManager, false);
    assert.equal(team.manager, undefined);
    assert.deepEqual(team.coworkers, []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("duplicate Boss current worker or live-session IDs fail closed", async () => {
  for (const duplicate of ["worker", "session"] as const) {
    const agentDir = await mkdtemp(join(tmpdir(), `codex-boss-duplicate-${duplicate}-`));
    const dir = join(agentDir, "intercom", "orchestrator");
    await mkdir(dir, { recursive: true });
    try {
      const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
      const worker = bossWorker("worker", "boss-run-1", "participant-worker");
      const staleDuplicate = { ...manager, workerGeneration: 2, intercomTarget: "stale-manager-session" };
      const workers = duplicate === "worker" ? [manager, staleDuplicate, worker] : [manager, worker];
      const sessions = duplicate === "session" ? [bossSession(manager), bossSession(manager), bossSession(worker)] : [bossSession(manager), bossSession(worker)];
      await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers }));
      const team = await resolveIntercomTeam({
        selfId: "manager-session",
        agentDir,
        env: {
          AGENT_INTERCOM_WORKER_ID: "manager",
          AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-manager",
          AGENT_INTERCOM_WORKER_GENERATION: "1",
          AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
          AGENT_INTERCOM_PARTICIPANT_ID: "participant-manager",
          AGENT_INTERCOM_BINDING_EPOCH: "1",
        },
        sessions,
      });
      assert.equal(team.self.isManager, false, `${duplicate} duplication must not confer Manager discovery`);
      assert.equal(team.manager, undefined);
      assert.deepEqual(team.coworkers, []);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  }
});

test("a stale current Boss live binding cannot unlock Manager roster discovery", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-stale-binding-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
    const worker = bossWorker("worker", "boss-run-1", "participant-worker");
    const staleManagerSession = bossSession(manager);
    staleManagerSession.boss!.binding!.bindingEpoch = 2;
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [manager, worker] }));
    const team = await resolveIntercomTeam({
      selfId: "manager-session",
      agentDir,
      env: {
        AGENT_INTERCOM_WORKER_ID: "manager",
        AGENT_INTERCOM_WORKER_INCARNATION_ID: "incarnation-manager",
        AGENT_INTERCOM_WORKER_GENERATION: "1",
        AGENT_INTERCOM_BOSS_RUN_ID: "boss-run-1",
        AGENT_INTERCOM_PARTICIPANT_ID: "participant-manager",
        AGENT_INTERCOM_BINDING_EPOCH: "1",
      },
      sessions: [staleManagerSession, bossSession(worker)],
    });
    assert.equal(team.self.isManager, false);
    assert.equal(team.manager, undefined);
    assert.deepEqual(team.coworkers, []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("a self-consistent foreign-run Manager is never projected as connected", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-foreign-manager-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const self = bossWorker("self", "boss-run-1", "participant-self", "worker", "self-session");
    const foreignManager = bossWorker("manager", "boss-run-2", "participant-manager", "manager", "manager-session");
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [self, foreignManager] }));
    const team = await resolveIntercomTeam({
      selfId: "self-session",
      agentDir,
      env: bossEnv,
      sessions: [bossSession(self), bossSession(foreignManager)],
    });
    assert.deepEqual(team.manager, { target: "manager-session", connected: false });
    assert.deepEqual(team.coworkers, []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("every substituted Boss roster identity dimension fails closed", async () => {
  const dimensions = [
    ["session", (session: TeamSession) => { session.id = "substituted-session"; session.name = "peer"; }],
    ["binding session", (session: TeamSession) => { session.boss!.binding!.sessionId = "substituted-session"; }],
    ["run", (session: TeamSession) => { session.boss!.binding!.bossRunId = "other-run"; }],
    ["participant", (session: TeamSession) => { session.boss!.binding!.participantId = "other-participant"; }],
    ["epoch", (session: TeamSession) => { session.boss!.binding!.bindingEpoch = 2; }],
    ["role", (session: TeamSession) => { session.boss!.binding!.role = "scout"; }],
    ["incarnation", (session: TeamSession) => { (session.boss!.workerIdentity as Record<string, unknown>).workerIncarnationId = "other-incarnation"; }],
    ["generation", (session: TeamSession) => { (session.boss!.workerIdentity as Record<string, unknown>).workerGeneration = 2; }],
    ["state", (session: TeamSession) => { session.boss!.participantState = "waiting"; }],
  ] as const;
  for (const [name, mutate] of dimensions) {
    const agentDir = await mkdtemp(join(tmpdir(), `codex-boss-team-${name.replaceAll(" ", "-")}-`));
    const dir = join(agentDir, "intercom", "orchestrator");
    await mkdir(dir, { recursive: true });
    try {
      const self = bossWorker("self", "boss-run-1", "participant-self", "worker", "self-session");
      const manager = bossWorker("manager", "boss-run-1", "participant-manager", "manager", "manager-session");
      const peer = bossWorker("peer", "boss-run-1", "participant-peer");
      await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [self, manager, peer] }));
      const peerSession = bossSession(peer);
      mutate(peerSession);
      const team = await resolveIntercomTeam({
        selfId: "self-session",
        agentDir,
        env: bossEnv,
        sessions: [bossSession(self), bossSession(manager), peerSession],
      });
      assert.deepEqual(team.coworkers, [], `${name} substitution must be hidden`);
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  }
});

test("stale current Boss identity is not promoted to Manager", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "codex-boss-team-stale-"));
  const dir = join(agentDir, "intercom", "orchestrator");
  await mkdir(dir, { recursive: true });
  try {
    const self = { ...bossWorker("self", "boss-run-1", "participant-self", "worker", "self-session"), workerGeneration: 2 };
    await writeFile(join(dir, "workers.json"), JSON.stringify({ version: 2, workers: [self] }));
    const team = await resolveIntercomTeam({ selfId: "self-session", agentDir, env: bossEnv, sessions: [bossSession(self)] });
    assert.equal(team.self.isManager, false);
    assert.equal(team.manager, undefined);
    assert.deepEqual(team.coworkers, []);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
