import { once } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexBridgeDaemon } from "./bridge-daemon.ts";
import type { BridgeConfig } from "./bridge-config.ts";
import { ensureIntercomRuntimeDir, getIntercomDirPath } from "../broker/paths.ts";

export interface CoiOptions {
  id?: string;
  name?: string;
  cwd: string;
  instructions?: string;
  socketPath?: string;
  statePath?: string;
  noTui: boolean;
  codexCommand: string;
  codexArgs: string[];
}

interface IdentityInput {
  cwd: string;
  pid: number;
  gitRoot?: string | null;
  branch?: string | null;
}

const CODEX_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "--ask-for-approval",
  "--add-dir",
  "-c",
  "--cd",
  "-C",
  "--config",
  "-i",
  "--image",
  "-m",
  "--model",
  "-p",
  "--profile",
  "--remote-auth-token-env",
  "-s",
  "--sandbox",
  "--local-provider",
]);
const COI_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function sanitizeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "codex";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function gitString(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const trimmed = result.stdout.trim();
  return trimmed || null;
}

export function createDefaultIdentity(input: IdentityInput): { id: string; name: string } {
  const root = input.gitRoot || input.cwd;
  const repo = basename(root) || "codex";
  const branch = input.branch || "worktree";
  const readable = `${repo}:${branch}`;
  const suffix = `${shortHash(input.cwd)}-${input.pid}`;
  return {
    id: sanitizeSegment(`codex-${repo}-${branch}-${suffix}`),
    name: `codex:${readable}#${input.pid}`,
  };
}

function detectIdentity(cwd: string): { id: string; name: string } {
  return createDefaultIdentity({
    cwd,
    pid: process.pid,
    gitRoot: gitString(cwd, ["rev-parse", "--show-toplevel"]),
    branch: gitString(cwd, ["branch", "--show-current"]),
  });
}

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseCoiArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CoiOptions {
  const codexArgs: string[] = [];
  const options: Partial<CoiOptions> = {};
  let afterSeparator = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (afterSeparator) {
      codexArgs.push(arg);
      continue;
    }

    if (arg === "--") {
      afterSeparator = true;
      continue;
    }

    const [key, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const value = inlineValue ?? null;

    switch (key) {
      case "--name":
      case "--intercom-name":
        options.name = value ?? readValue(argv, index++, key);
        break;
      case "--id":
      case "--intercom-id":
        options.id = value ?? readValue(argv, index++, key);
        break;
      case "--cwd":
      case "--intercom-cwd":
        options.cwd = resolve(value ?? readValue(argv, index++, key));
        break;
      case "--instructions":
      case "--intercom-instructions":
        options.instructions = value ?? readValue(argv, index++, key);
        break;
      case "--socket":
      case "--intercom-socket":
        options.socketPath = resolve(value ?? readValue(argv, index++, key));
        break;
      case "--state":
      case "--intercom-state":
        options.statePath = resolve(value ?? readValue(argv, index++, key));
        break;
      case "--no-tui":
      case "--intercom-no-tui":
        options.noTui = true;
        break;
      default:
        codexArgs.push(arg);
        break;
    }
  }

  return {
    cwd: resolve(options.cwd ?? env.CODEX_INTERCOM_CWD ?? process.cwd()),
    id: options.id ?? env.CODEX_INTERCOM_SESSION_ID,
    name: options.name ?? env.CODEX_INTERCOM_NAME,
    instructions: options.instructions ?? env.CODEX_INTERCOM_INSTRUCTIONS,
    socketPath: options.socketPath,
    statePath: options.statePath,
    noTui: options.noTui ?? false,
    codexCommand: env.CODEX_INTERCOM_CODEX_COMMAND || "codex",
    codexArgs,
  };
}

export function hasCodexHelpOrVersion(args: string[]): boolean {
  return args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V");
}

export function splitCodexResumeArgs(args: string[]): { optionArgs: string[]; promptArgs: string[] } {
  const optionArgs: string[] = [];
  const promptArgs: string[] = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      promptArgs.push(...args.slice(index + 1));
      return { optionArgs, promptArgs };
    }
    if (!arg.startsWith("-") || arg === "-") break;
    optionArgs.push(arg);
    const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!arg.includes("=") && CODEX_OPTIONS_WITH_VALUE.has(optionName) && index + 1 < args.length) {
      optionArgs.push(args[index + 1]);
      index += 1;
    }
  }
  promptArgs.push(...args.slice(index));
  return { optionArgs, promptArgs };
}

async function waitForSocket(socketPath: string, proc: ChildProcess, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Codex app-server exited before creating ${socketPath}`);
    }
    if (existsSync(socketPath)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for Codex app-server socket: ${socketPath}`);
}

async function stopChild(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 2000);
    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}

export function cleanupOldCoiStateFiles(intercomDir: string, now = Date.now(), maxAgeMs = COI_STATE_MAX_AGE_MS): void {
  let entries: string[];
  try {
    entries = readdirSync(intercomDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!/^coi-.+-state\.json$/.test(entry)) continue;
    const path = join(intercomDir, entry);
    try {
      const stat = statSync(path);
      if (now - stat.mtimeMs > maxAgeMs) rmSync(path, { force: true });
    } catch {
      // Best effort cleanup only.
    }
  }
}

export async function runCoi(options: CoiOptions): Promise<number> {
  if (hasCodexHelpOrVersion(options.codexArgs)) {
    const help = spawn(options.codexCommand, options.codexArgs, {
      cwd: options.cwd,
      env: process.env,
      stdio: "inherit",
    });
    const [code, signal] = await once(help, "exit") as [number | null, NodeJS.Signals | null];
    if (typeof code === "number") return code;
    return signal === "SIGINT" ? 130 : 1;
  }

  ensureIntercomRuntimeDir();
  const identity = detectIdentity(options.cwd);
  const id = sanitizeSegment(options.id ?? identity.id);
  const name = options.name ?? identity.name;
  const intercomDir = getIntercomDirPath();
  cleanupOldCoiStateFiles(intercomDir);
  const socketPath = options.socketPath ?? join(intercomDir, `coi-${process.pid}.sock`);
  const statePath = options.statePath ?? join(intercomDir, `coi-${sanitizeSegment(id)}-state.json`);
  rmSync(socketPath, { force: true });

  const appServer = spawn(options.codexCommand, ["app-server", "--listen", `unix://${socketPath}`], {
    cwd: options.cwd,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  appServer.stderr?.on("data", (chunk) => {
    if (process.env.CODEX_INTERCOM_DEBUG) process.stderr.write(String(chunk));
  });

  const cleanup = async () => {
    await daemon?.stop().catch(() => undefined);
    await stopChild(appServer);
    rmSync(socketPath, { force: true });
  };

  let daemon: CodexBridgeDaemon | null = null;
  let cleaned = false;
  const cleanupOnce = async () => {
    if (cleaned) return;
    cleaned = true;
    await cleanup();
  };

  process.once("SIGINT", () => {
    void cleanupOnce().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void cleanupOnce().finally(() => process.exit(143));
  });

  await waitForSocket(socketPath, appServer);

  const config: BridgeConfig = {
    statePath,
    appServer: {
      transport: "unix-websocket",
      socketPath,
    },
    agents: [{
      id,
      name,
      cwd: options.cwd,
      model: process.env.CODEX_INTERCOM_MODEL,
      instructions: options.instructions,
    }],
  };
  daemon = new CodexBridgeDaemon(config);
  await daemon.start();
  process.stderr.write(`coi intercom session: ${name} (${id})\n`);

  if (options.noTui) {
    await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM"), once(appServer, "exit")]);
    await cleanupOnce();
    return 0;
  }

  const remote = `unix://${socketPath}`;
  const threadId = await daemon.ensureThreadForAgent(id);
  const { optionArgs, promptArgs } = splitCodexResumeArgs(options.codexArgs);
  process.stderr.write(`coi sidecar thread: ${threadId}\n`);
  const resolvedTuiArgs = ["resume", "--remote", remote, ...optionArgs, threadId, ...promptArgs];
  const tui = spawn(options.codexCommand, resolvedTuiArgs, {
    cwd: options.cwd,
    env: process.env,
    stdio: "inherit",
  });
  const [code, signal] = await once(tui, "exit") as [number | null, NodeJS.Signals | null];
  await cleanupOnce();
  if (typeof code === "number") return code;
  return signal === "SIGINT" ? 130 : 1;
}

async function main(): Promise<void> {
  const options = parseCoiArgs(process.argv.slice(2));
  const code = await runCoi(options);
  process.exit(code);
}

if (process.argv[1] && (basename(process.argv[1]) === "coi.ts" || basename(process.argv[1]) === "coi.mjs")) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
