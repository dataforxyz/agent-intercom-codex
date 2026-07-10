import { once } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexBridgeDaemon } from "./bridge-daemon.ts";
import type { BridgeConfig } from "./bridge-config.ts";
import { ensureIntercomRuntimeDir, getIntercomDirPath } from "../broker/paths.ts";
import { copyTextToClipboard, copyTextToTerminalClipboard } from "./clipboard.ts";
import { formatContactInstruction } from "./contact.ts";
import { TuiInputDecoder } from "./tui-input.ts";

export interface CoiOptions {
  id?: string;
  name?: string;
  cwd: string;
  instructions?: string;
  socketPath?: string;
  statePath?: string;
  noTui: boolean;
  copyShortcut: boolean;
  codexCommand: string;
  codexArgs: string[];
}

interface IdentityInput {
  cwd: string;
  pid: number;
  gitRoot?: string | null;
  branch?: string | null;
}

interface BridgeRuntimeConfig {
  approvalPolicy?: string;
  sandboxPolicy?: Record<string, unknown>;
}

const CODEX_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "--ask-for-approval",
  "--add-dir",
  "--disable",
  "--enable",
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

function envFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return defaultValue;
}

function camelSandboxType(mode: string): string {
  switch (mode) {
    case "read-only":
      return "readOnly";
    case "workspace-write":
      return "workspaceWrite";
    case "danger-full-access":
      return "dangerFullAccess";
    default:
      throw new Error(`Unsupported sandbox mode: ${mode}`);
  }
}

function readCodexFlagValue(args: string[], index: number, option: string): { value: string; nextIndex: number } {
  const arg = args[index];
  const inline = arg.includes("=") ? arg.split(/=(.*)/s, 2)[1] : undefined;
  if (inline !== undefined) return { value: inline, nextIndex: index };
  return { value: readValue(args, index, option), nextIndex: index + 1 };
}

export function deriveBridgeAgentRuntimeConfig(args: string[], cwd: string): BridgeRuntimeConfig {
  let approvalPolicy: string | undefined;
  let sandboxMode: string | undefined;
  const writableRoots = new Set<string>([resolve(cwd)]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;

    switch (optionName) {
      case "--ask-for-approval":
      case "-a": {
        const parsed = readCodexFlagValue(args, index, optionName);
        approvalPolicy = parsed.value;
        index = parsed.nextIndex;
        break;
      }
      case "--sandbox":
      case "-s": {
        const parsed = readCodexFlagValue(args, index, optionName);
        sandboxMode = parsed.value;
        index = parsed.nextIndex;
        break;
      }
      case "--add-dir": {
        const parsed = readCodexFlagValue(args, index, optionName);
        writableRoots.add(resolve(cwd, parsed.value));
        index = parsed.nextIndex;
        break;
      }
      case "--dangerously-bypass-approvals-and-sandbox":
      case "--yolo":
        approvalPolicy = "never";
        sandboxMode = "danger-full-access";
        break;
      default:
        break;
    }
  }

  const sandboxType = sandboxMode ? camelSandboxType(sandboxMode) : undefined;
  const sandboxPolicy = sandboxType === "workspaceWrite"
    ? { type: sandboxType, writableRoots: [...writableRoots], networkAccess: false }
    : sandboxType
      ? { type: sandboxType, ...(sandboxType === "readOnly" ? { networkAccess: false } : {}) }
      : undefined;

  return {
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {}),
  };
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
      case "--no-intercom-shortcut":
      case "--intercom-no-shortcut":
        options.copyShortcut = false;
        break;
      case "--intercom-shortcut":
        options.copyShortcut = true;
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
    copyShortcut: options.copyShortcut ?? envFlagEnabled(env.CODEX_INTERCOM_SHORTCUT, true),
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

export function resolveCoiResumeRequest(args: string[]): {
  optionArgs: string[];
  promptArgs: string[];
  threadId?: string;
} {
  const { optionArgs, promptArgs } = splitCodexResumeArgs(args);
  if (promptArgs[0] !== "resume" || !promptArgs[1]) return { optionArgs, promptArgs };
  return { optionArgs, threadId: promptArgs[1], promptArgs: promptArgs.slice(2) };
}

export function buildCoiTuiArgs(
  remote: string,
  optionArgs: string[],
  threadId: string,
  promptArgs: string[],
  explicitResume: boolean,
): string[] {
  return explicitResume
    ? ["resume", "--remote", remote, ...optionArgs, threadId, ...promptArgs]
    : ["--remote", remote, ...optionArgs, ...promptArgs];
}

export function buildCodexAppServerArgs(args: string[], socketPath: string): string[] {
  const { optionArgs } = splitCodexResumeArgs(args);
  const appServerArgs: string[] = [];

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    const optionName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (optionName === "--strict-config") {
      appServerArgs.push(arg);
      continue;
    }
    if (optionName !== "-c" && optionName !== "--config" && optionName !== "--enable" && optionName !== "--disable") {
      continue;
    }
    appServerArgs.push(arg);
    if (!arg.includes("=") && index + 1 < optionArgs.length) {
      appServerArgs.push(optionArgs[index + 1]);
      index += 1;
    }
  }

  return ["app-server", ...appServerArgs, "--listen", `unix://${socketPath}`];
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

function terminalNotification(message: string): void {
  const safe = message.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
  if (process.stdout.isTTY) process.stdout.write(`\x1b]9;${safe}\x1b\\`);
  else process.stderr.write(`${safe}\n`);
}

async function runInteractiveTui(
  command: string,
  args: string[],
  refreshArgs: string[],
  cwd: string,
  onAltI?: (controls: { insertText(text: string): void }) => void,
  onAltM?: (controls: { insertText(text: string): void }) => void,
  installRefresh?: (refresh: () => void) => () => void,
): Promise<number> {
  const runInherited = async (): Promise<number> => {
    const tui = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    const [code, signal] = await once(tui, "exit") as [number | null, NodeJS.Signals | null];
    if (typeof code === "number") return code;
    return signal === "SIGINT" ? 130 : 1;
  };

  if ((!onAltI && !onAltM) || !process.stdin.isTTY || !process.stdout.isTTY) {
    return runInherited();
  }

  let nodePty: typeof import("node-pty");
  try {
    nodePty = await import("node-pty");
  } catch (error) {
    process.stderr.write(`coi: Alt+I unavailable because optional node-pty could not load: ${error instanceof Error ? error.message : String(error)}\n`);
    return runInherited();
  }

  const tui = nodePty.spawn(command, args, {
    name: process.env.TERM || "xterm-256color",
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd,
    env: process.env,
  });
  const outputSubscription = tui.onData((data) => process.stdout.write(data));
  let refreshRequested = false;
  const removeRefresh = installRefresh?.(() => {
    if (refreshRequested) return;
    refreshRequested = true;
    terminalNotification("Intercom turn completed; refreshing Codex TUI");
    tui.kill();
  });
  const previousRawMode = Boolean(process.stdin.isRaw);
  const inputDecoder = new TuiInputDecoder();
  let pendingTimer: NodeJS.Timeout | null = null;

  const flushPending = () => {
    const pending = inputDecoder.flushPendingEscape();
    if (!pending) return;
    try {
      tui.write(pending);
    } catch {
      // The PTY may have closed while a partial escape sequence was buffered.
    }
    pendingTimer = null;
  };
  const onInput = (chunk: Buffer | string) => {
    if (pendingTimer) clearTimeout(pendingTimer);
    const filtered = inputDecoder.write(chunk);
    if (filtered.forwarded) tui.write(filtered.forwarded);
    const controls = {
      insertText(text: string) {
        const safe = text.replace(/\x1b/g, "");
        tui.write(`\x1b[200~${safe}\x1b[201~`);
      },
    };
    for (let index = 0; index < filtered.altICount; index += 1) onAltI?.(controls);
    for (let index = 0; index < filtered.altMCount; index += 1) onAltM?.(controls);
    pendingTimer = inputDecoder.hasPendingEscape() ? setTimeout(flushPending, 25) : null;
  };
  const onResize = () => tui.resize(process.stdout.columns || 80, process.stdout.rows || 24);

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onInput);
  process.stdout.on("resize", onResize);

  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve) => {
      tui.onExit(({ exitCode, signal }) => resolve(exitCode ?? (signal === 2 ? 130 : 1)));
    });
  } finally {
    removeRefresh?.();
    if (pendingTimer) clearTimeout(pendingTimer);
    flushPending();
    const ended = inputDecoder.end();
    if (ended.forwarded) {
      try {
        tui.write(ended.forwarded);
      } catch {
        // The PTY is already closed.
      }
    }
    process.stdin.off("data", onInput);
    process.stdout.off("resize", onResize);
    process.stdin.setRawMode(previousRawMode);
    outputSubscription.dispose();
  }
  if (refreshRequested) {
    return runInteractiveTui(command, refreshArgs, refreshArgs, cwd, onAltI, onAltM, installRefresh);
  }
  return exitCode;
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

  const appServer = spawn(options.codexCommand, buildCodexAppServerArgs(options.codexArgs, socketPath), {
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

  const resumeRequest = resolveCoiResumeRequest(options.codexArgs);
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
      threadId: resumeRequest.threadId,
      ...deriveBridgeAgentRuntimeConfig(options.codexArgs, options.cwd),
    }],
  };
  let refreshVisibleTui: (() => void) | undefined;
  daemon = new CodexBridgeDaemon(config, {
    onExternalTurnComplete: ({ from, response }) => {
      terminalNotification(`Intercom turn from ${from.name || from.id} completed: ${response}`);
      setTimeout(() => refreshVisibleTui?.(), 1000).unref();
    },
  });
  await daemon.start();
  process.stderr.write(`coi intercom session: ${name} (${id})\n`);

  if (options.noTui) {
    await Promise.race([once(process, "SIGINT"), once(process, "SIGTERM"), once(appServer, "exit")]);
    await cleanupOnce();
    return 0;
  }

  const remote = `unix://${socketPath}`;
  const threadId = await daemon.ensureThreadForAgent(id);
  const { optionArgs, promptArgs } = resumeRequest;
  process.stderr.write(`coi sidecar thread: ${threadId}\n`);
  const resolvedTuiArgs = buildCoiTuiArgs(
    remote,
    optionArgs,
    threadId,
    promptArgs,
    Boolean(resumeRequest.threadId),
  );
  const refreshTuiArgs = ["resume", "--remote", remote, ...optionArgs, threadId];
  let copying = false;
  const copyCurrentContact = (controls: { insertText(text: string): void }) => {
    if (copying) return;
    copying = true;
    void daemon!.getContactTargetForAgent(id)
      .then(async (contact) => {
        const instruction = formatContactInstruction(contact);
        const preferTerminal = Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION);
        let copied = preferTerminal
          ? copyTextToTerminalClipboard(instruction, (sequence) => process.stdout.write(sequence))
          : await copyTextToClipboard(instruction);
        if (!copied.ok && process.stdout.isTTY) {
          copied = copyTextToTerminalClipboard(instruction, (sequence) => process.stdout.write(sequence));
        }

        if (copied.ok) {
          const fallback = contact.fallback ? " using the stable ID" : "";
          terminalNotification(`Copied intercom contact${fallback}: ${contact.target}`);
          return;
        }

        controls.insertText(instruction);
        terminalNotification(`Clipboard unavailable; inserted intercom contact: ${contact.target}`);
      })
      .catch((error) => terminalNotification(`Failed to read intercom contact: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        copying = false;
      });
  };
  const openIntercom = (controls: { insertText(text: string): void }) => {
    controls.insertText("Use intercom_list to show the active sessions, then ask me which session to message and what to send. Use intercom_send after I choose.");
    terminalNotification("Inserted intercom session picker request");
  };
  try {
    return await runInteractiveTui(
      options.codexCommand,
      resolvedTuiArgs,
      refreshTuiArgs,
      options.cwd,
      options.copyShortcut ? copyCurrentContact : undefined,
      options.copyShortcut ? openIntercom : undefined,
      (refresh) => {
        refreshVisibleTui = refresh;
        return () => {
          if (refreshVisibleTui === refresh) refreshVisibleTui = undefined;
        };
      },
    );
  } finally {
    await cleanupOnce();
  }
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
