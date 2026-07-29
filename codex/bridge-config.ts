import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { cwd as processCwd } from "node:process";
import { types as nodeUtilTypes } from "node:util";
import { getIntercomDirPath, restrictIntercomRuntimeFile } from "../broker/paths.ts";
import { HARDENED_BOSS_CODEX_DEFAULTS, type HardenedBossClientKind } from "./boss-client.ts";
import { assertBossCanonicalData } from "../broker/boss-adapter.ts";

export interface BridgeAgentConfig {
  id: string;
  name: string;
  cwd: string;
  model?: string;
  threadId?: string;
  instructions?: string;
  approvalPolicy?: unknown;
  sandboxPolicy?: unknown;
  bossClient?: HardenedBossClientKind;
}

export interface BridgeConfig {
  agents: BridgeAgentConfig[];
  statePath: string;
  appServer?: {
    command?: string;
    args?: string[];
    transport?: "stdio" | "unix-websocket";
    socketPath?: string;
    startDaemon?: boolean;
    startDaemonCommand?: string;
    startDaemonArgs?: string[];
  };
}

export interface BridgeState {
  agents: Record<string, { threadId: string; updatedAt: number }>;
}

export const DEFAULT_BRIDGE_CONFIG_PATH = join(getIntercomDirPath(), "codex-bridge.json");
export const DEFAULT_BRIDGE_STATE_PATH = join(getIntercomDirPath(), "codex-bridge-state.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !nodeUtilTypes.isProxy(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requireString(value: unknown, field: string): string {
  const result = optionalString(value, field);
  if (!result) throw new Error(`${field} must be a non-empty string`);
  return result;
}

export function parseHardenedBossClientKind(value: unknown, field: string): HardenedBossClientKind | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "boss_participant" || value === "boss_reviewer") return value;
  throw new Error(`${field} must be boss_participant or boss_reviewer`);
}

function sandboxType(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.type === "string" ? value.type : undefined;
}

export function assertHardenedBossAgentConfig(agent: BridgeAgentConfig): void {
  if (nodeUtilTypes.isProxy(agent)) throw new Error("Hardened Boss agent config must not be a proxy");
  assertBossCanonicalData(agent, "$.agent");
  if (agent.bossClient === undefined) return;
  if (agent.sandboxPolicy !== undefined && !isRecord(agent.sandboxPolicy)) {
    throw new Error(`${agent.bossClient} sandboxPolicy must be a plain object`);
  }
  if (agent.approvalPolicy !== undefined && typeof agent.approvalPolicy !== "string") {
    throw new Error(`${agent.bossClient} approvalPolicy must be a string`);
  }
  const type = sandboxType(agent.sandboxPolicy);
  if (type === "dangerFullAccess" || type === "danger-full-access") {
    throw new Error(`${agent.bossClient} cannot use danger-full-access`);
  }
  if (agent.approvalPolicy === "never") {
    throw new Error(`${agent.bossClient} cannot disable approval checks`);
  }
  if (agent.bossClient === "boss_reviewer" && type !== undefined && type !== "readOnly" && type !== "read-only") {
    throw new Error("boss_reviewer must use a read-only sandbox");
  }
  const canonicalCwd = resolve(agent.cwd);
  if (agent.bossClient === "boss_participant" && canonicalCwd === parsePath(canonicalCwd).root) {
    throw new Error("boss_participant workspace root must not be a filesystem root");
  }
  if (isRecord(agent.sandboxPolicy)) {
    assertBossCanonicalData(agent.sandboxPolicy, "$.agent.sandboxPolicy");
    const allowedKeys = type === "workspaceWrite" || type === "workspace-write"
      ? new Set(["type", "writableRoots", "networkAccess"])
      : new Set(["type", "networkAccess"]);
    const keys = Reflect.ownKeys(agent.sandboxPolicy);
    if (keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
      throw new Error(`${agent.bossClient} sandboxPolicy contains unsupported capability fields`);
    }
    if (agent.sandboxPolicy.networkAccess !== false) {
      throw new Error(`${agent.bossClient} networkAccess must be false`);
    }
    if (type !== "readOnly" && type !== "read-only" && type !== "workspaceWrite" && type !== "workspace-write") {
      throw new Error(`${agent.bossClient} sandboxPolicy type is unsupported`);
    }
  }
  if (isRecord(agent.sandboxPolicy) && (type === "workspaceWrite" || type === "workspace-write")) {
    const roots = agent.sandboxPolicy.writableRoots;
    assertBossCanonicalData(roots, "$.agent.sandboxPolicy.writableRoots");
    if (!Array.isArray(roots) || nodeUtilTypes.isProxy(roots) || roots.some((root) => typeof root !== "string")) {
      throw new Error(`${agent.bossClient} writableRoots must be a dense string array`);
    }
    if (
      agent.bossClient === "boss_reviewer"
      || roots.length !== 1
      || resolve(roots[0]) !== canonicalCwd
    ) {
      throw new Error(`${agent.bossClient} writable roots must be restricted to the agent cwd`);
    }
  }
  if (agent.bossClient === "boss_participant") {
    // This adapter has no protected broker/assignment projection carrying a
    // canonical workspace root. Caller cwd/config/env values cannot supply
    // that authority, so writable protected launches remain dormant.
    throw new Error("boss_participant requires unavailable broker-owned assigned workspace authority");
  }
}

export function bridgeAgentApprovalPolicy(agent: BridgeAgentConfig): unknown {
  return agent.approvalPolicy
    ?? (agent.bossClient === undefined ? "never" : HARDENED_BOSS_CODEX_DEFAULTS[agent.bossClient].approvalPolicy);
}

export function bridgeAgentDefaultSandbox(agent: BridgeAgentConfig): "read-only" | "workspace-write" | undefined {
  return agent.bossClient === undefined ? undefined : HARDENED_BOSS_CODEX_DEFAULTS[agent.bossClient].sandbox;
}

export function assertHardenedBossBridgeConfig(config: BridgeConfig): void {
  assertBossCanonicalData(config, "$.bridgeConfig");
  if (nodeUtilTypes.isProxy(config) || nodeUtilTypes.isProxy(config.agents) || !Array.isArray(config.agents)) {
    throw new Error("Bridge config and agents must be plain non-proxy data");
  }
  for (let index = 0; index < config.agents.length; index += 1) {
    if (!Object.hasOwn(config.agents, index)) throw new Error("Bridge agents must not be sparse");
    const agent = config.agents[index];
    if (typeof agent !== "object" || agent === null || Array.isArray(agent) || nodeUtilTypes.isProxy(agent)) {
      throw new Error("Bridge agents must be plain non-proxy objects");
    }
  }
  if (!config.agents.some((agent) => agent.bossClient !== undefined)) return;
  if (config.appServer !== undefined) {
    assertBossCanonicalData(config.appServer, "$.appServer");
    if (nodeUtilTypes.isProxy(config.appServer)) throw new Error("Hardened Boss app-server config must not be a proxy");
    if (config.appServer.command !== undefined || config.appServer.startDaemonCommand !== undefined) {
      throw new Error("Hardened Boss bridge cannot use caller-provided app-server commands");
    }
  }
  for (const args of [config.appServer?.args, config.appServer?.startDaemonArgs]) {
    if (!args) continue;
    assertBossCanonicalData(args, "$.appServer.argv");
    if (nodeUtilTypes.isProxy(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Hardened Boss bridge arguments must be dense string arrays");
    for (const arg of args) {
      if (arg === "--") {
        continue;
      }
      if (arg.length > 2 && arg.startsWith("-C")) {
        throw new Error("Hardened Boss bridge cannot pass launch escape -C to app-server");
      }
      const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (
        ["-c", "--config", "-p", "--profile", "--enable", "--disable"].includes(optionName)
        || (optionName.startsWith("-c") && optionName !== "-C")
        || optionName.startsWith("-p")
      ) {
        throw new Error(`Hardened Boss bridge cannot pass raw ${optionName} or profile configuration to app-server`);
      }
      if (["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--yolo", "--add-dir", "--cd", "-C"].includes(optionName)) {
        throw new Error(`Hardened Boss bridge cannot pass launch escape ${optionName} to app-server`);
      }
      if (
        ["--sandbox", "--ask-for-approval"].includes(optionName)
        || optionName === "-s"
        || optionName === "-a"
        || optionName.startsWith("-s")
        || optionName.startsWith("-a")
      ) {
        throw new Error(`Hardened Boss bridge cannot pass policy override ${optionName} to app-server`);
      }
      if (optionName.startsWith("-") && /(?:yolo|danger|bypass)/i.test(optionName)) {
        throw new Error(`Hardened Boss bridge cannot pass launch escape ${optionName} to app-server`);
      }
    }
  }
  // The aggregate validator is itself a complete pre-spawn boundary; callers
  // cannot validate argv while bypassing per-agent authority ceilings.
  for (const agent of config.agents) assertHardenedBossAgentConfig(agent);
}

function normalizeAgent(raw: unknown, index: number): BridgeAgentConfig {
  if (!isRecord(raw)) throw new Error(`agents[${index}] must be an object`);
  const id = requireString(raw.id, `agents[${index}].id`);
  const name = optionalString(raw.name, `agents[${index}].name`) ?? id;
  const agent: BridgeAgentConfig = {
    id,
    name,
    cwd: resolve(optionalString(raw.cwd, `agents[${index}].cwd`) ?? processCwd()),
    model: optionalString(raw.model, `agents[${index}].model`),
    threadId: optionalString(raw.threadId, `agents[${index}].threadId`),
    instructions: optionalString(raw.instructions, `agents[${index}].instructions`),
    approvalPolicy: raw.approvalPolicy,
    sandboxPolicy: raw.sandboxPolicy,
    bossClient: parseHardenedBossClientKind(raw.bossClient, `agents[${index}].bossClient`),
  };
  assertHardenedBossAgentConfig(agent);
  return agent;
}

export function defaultBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const id = env.CODEX_INTERCOM_BRIDGE_ID?.trim() || "codex-worker";
  const bossClient = parseHardenedBossClientKind(env.CODEX_INTERCOM_BOSS_CLIENT?.trim(), "CODEX_INTERCOM_BOSS_CLIENT");
  const agent: BridgeAgentConfig = {
    id,
    name: env.CODEX_INTERCOM_BRIDGE_NAME?.trim() || id,
    cwd: resolve(env.CODEX_INTERCOM_BRIDGE_CWD?.trim() || processCwd()),
    model: env.CODEX_INTERCOM_BRIDGE_MODEL?.trim() || undefined,
    instructions: env.CODEX_INTERCOM_BRIDGE_INSTRUCTIONS?.trim() || undefined,
    ...(bossClient === undefined ? {} : { bossClient }),
  };
  assertHardenedBossAgentConfig(agent);
  return {
    statePath: env.CODEX_INTERCOM_BRIDGE_STATE?.trim() || DEFAULT_BRIDGE_STATE_PATH,
    agents: [agent],
  };
}

export function loadBridgeConfig(path = process.env.CODEX_INTERCOM_BRIDGE_CONFIG || DEFAULT_BRIDGE_CONFIG_PATH): BridgeConfig {
  if (!existsSync(path)) return defaultBridgeConfig();

  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("Bridge config must be a JSON object");
  if (!Array.isArray(parsed.agents)) throw new Error("Bridge config requires an agents array");

  const appServer: BridgeConfig["appServer"] = isRecord(parsed.appServer) ? {
    command: optionalString(parsed.appServer.command, "appServer.command"),
    args: Array.isArray(parsed.appServer.args) ? parsed.appServer.args.map((arg, index) => requireString(arg, `appServer.args[${index}]`)) : undefined,
    transport: parsed.appServer.transport === "unix-websocket" || parsed.appServer.transport === "stdio" ? parsed.appServer.transport : undefined,
    socketPath: optionalString(parsed.appServer.socketPath, "appServer.socketPath"),
    startDaemon: typeof parsed.appServer.startDaemon === "boolean" ? parsed.appServer.startDaemon : undefined,
    startDaemonCommand: optionalString(parsed.appServer.startDaemonCommand, "appServer.startDaemonCommand"),
    startDaemonArgs: Array.isArray(parsed.appServer.startDaemonArgs) ? parsed.appServer.startDaemonArgs.map((arg, index) => requireString(arg, `appServer.startDaemonArgs[${index}]`)) : undefined,
  } : undefined;

  return {
    statePath: resolve(optionalString(parsed.statePath, "statePath") ?? DEFAULT_BRIDGE_STATE_PATH),
    agents: parsed.agents.map(normalizeAgent),
    ...(appServer ? { appServer } : {}),
  };
}

export function loadBridgeState(path: string): BridgeState {
  if (!existsSync(path)) return { agents: {} };
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.agents)) return { agents: {} };
  const agents: BridgeState["agents"] = {};
  for (const [id, value] of Object.entries(parsed.agents)) {
    if (!isRecord(value) || typeof value.threadId !== "string") continue;
    agents[id] = {
      threadId: value.threadId,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    };
  }
  return { agents };
}

export function saveBridgeState(path: string, state: BridgeState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  restrictIntercomRuntimeFile(path);
}
