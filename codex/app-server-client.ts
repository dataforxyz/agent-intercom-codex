import { EventEmitter } from "node:events";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CodexAppServerClientOptions {
  command?: string;
  args?: string[];
  startDaemon?: boolean;
  startDaemonCommand?: string;
  startDaemonArgs?: string[];
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function defaultServerRequestResponse(method: string): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return { decision: "decline" };
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn", strictAutoReview: true };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/call":
      return { contentItems: [{ type: "text", text: "Background bridge declined tool call." }], success: false };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: "denied" };
    default:
      throw new Error(`Unsupported app-server request: ${method}`);
  }
}

export class CodexAppServerClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private initialized = false;
  private options: Required<CodexAppServerClientOptions>;

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    this.options = {
      command: options.command ?? "codex",
      args: options.args ?? ["app-server"],
      startDaemon: options.startDaemon ?? false,
      startDaemonCommand: options.startDaemonCommand ?? "codex",
      startDaemonArgs: options.startDaemonArgs ?? ["app-server", "daemon", "start"],
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
  }

  async connect(): Promise<void> {
    if (this.proc) return;

    if (this.options.startDaemon) {
      const started = spawnSync(this.options.startDaemonCommand, this.options.startDaemonArgs, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (started.status !== 0) {
        throw new Error(`Failed to start Codex app-server daemon: ${started.stderr || started.stdout || `exit ${started.status}`}`);
      }
    }

    const proc = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.proc = proc;
    this.rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.handleLine(line));
    proc.stderr.on("data", (chunk) => this.emit("stderr", String(chunk)));
    proc.once("error", (error) => this.failAll(asError(error)));
    proc.once("exit", (code, signal) => {
      this.failAll(new Error(`Codex app-server proxy exited (${signal ?? code ?? "unknown"})`));
      this.proc = null;
      this.initialized = false;
      this.emit("exit", { code, signal });
    });

    await this.initialize();
  }

  async disconnect(): Promise<void> {
    const proc = this.proc;
    this.rl?.close();
    this.rl = null;
    this.proc = null;
    this.initialized = false;
    this.failAll(new Error("Codex app-server client disconnected"));
    if (!proc) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2000);
      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      proc.stdin.end();
      proc.kill("SIGTERM");
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      clientInfo: {
        name: "codex_intercom_bridge",
        title: "Codex Intercom Bridge",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  request(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs): Promise<unknown> {
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) {
      return Promise.reject(new Error("Codex app-server client is not connected"));
    }

    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    const proc = this.proc;
    if (!proc || !proc.stdin.writable) {
      throw new Error("Codex app-server client is not connected");
    }
    const payload = params === undefined ? { method } : { method, params };
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private respond(id: string | number | null | undefined, result: unknown): void {
    if (id === undefined || id === null) return;
    this.proc?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: string | number | null | undefined, code: number, message: string): void {
    if (id === undefined || id === null) return;
    this.proc?.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch (error) {
      this.emit("protocolError", asError(error));
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      try {
        this.respond(message.id, defaultServerRequestResponse(message.method));
      } catch (error) {
        this.respondError(message.id, -32601, asError(error).message);
      }
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      this.emit(message.method, message.params);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
