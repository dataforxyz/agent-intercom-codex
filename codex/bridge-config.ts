import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cwd as processCwd } from "node:process";
import { getIntercomDirPath, restrictIntercomRuntimeFile } from "../broker/paths.ts";

export interface BridgeAgentConfig {
  id: string;
  name: string;
  cwd: string;
  model?: string;
  threadId?: string;
  instructions?: string;
  approvalPolicy?: unknown;
  sandboxPolicy?: unknown;
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function normalizeAgent(raw: unknown, index: number): BridgeAgentConfig {
  if (!isRecord(raw)) throw new Error(`agents[${index}] must be an object`);
  const id = requireString(raw.id, `agents[${index}].id`);
  const name = optionalString(raw.name, `agents[${index}].name`) ?? id;
  return {
    id,
    name,
    cwd: resolve(optionalString(raw.cwd, `agents[${index}].cwd`) ?? processCwd()),
    model: optionalString(raw.model, `agents[${index}].model`),
    threadId: optionalString(raw.threadId, `agents[${index}].threadId`),
    instructions: optionalString(raw.instructions, `agents[${index}].instructions`),
    approvalPolicy: raw.approvalPolicy,
    sandboxPolicy: raw.sandboxPolicy,
  };
}

export function defaultBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const id = env.CODEX_INTERCOM_BRIDGE_ID?.trim() || "codex-worker";
  return {
    statePath: env.CODEX_INTERCOM_BRIDGE_STATE?.trim() || DEFAULT_BRIDGE_STATE_PATH,
    agents: [{
      id,
      name: env.CODEX_INTERCOM_BRIDGE_NAME?.trim() || id,
      cwd: resolve(env.CODEX_INTERCOM_BRIDGE_CWD?.trim() || processCwd()),
      model: env.CODEX_INTERCOM_BRIDGE_MODEL?.trim() || undefined,
      instructions: env.CODEX_INTERCOM_BRIDGE_INSTRUCTIONS?.trim() || undefined,
    }],
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
