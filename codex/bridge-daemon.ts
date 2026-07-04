import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { CodexAppServerClient, defaultServerRequestResponse, type JsonRpcMessage } from "./app-server-client.ts";
import { loadBridgeConfig, loadBridgeState, saveBridgeState, type BridgeAgentConfig, type BridgeConfig, type BridgeState } from "./bridge-config.ts";
import { IntercomClient } from "../broker/client.ts";
import { spawnBrokerIfNeeded } from "../broker/spawn.ts";
import { loadConfig } from "../config.ts";
import type { Message, SessionInfo } from "../types.ts";
import { formatAttachments, formatSessionList, resolveSessionTarget, type ToolResult } from "./runtime.ts";

interface TurnWaiter {
  from: SessionInfo;
  message: Message;
}

interface ToolReplyWaiter {
  from: string;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

const APPROVED_INTERCOM_TOOLS = new Set([
  "intercom_whoami",
  "intercom_status",
  "intercom_list",
  "intercom_set_summary",
  "intercom_send",
  "intercom_ask",
  "intercom_pending",
  "intercom_reply",
]);
const MAX_TOOL_MESSAGES_PER_TURN = 8;
const MAX_TOOL_MESSAGES_PER_MINUTE = 30;

function formatMessage(from: SessionInfo, message: Message, agent: BridgeAgentConfig): string {
  const replyInstruction = message.expectsReply
    ? "\n\nThe sender is waiting for a reply. Put the reply in your final assistant message."
    : "";
  const attachments = message.content.attachments?.map((attachment) => {
    const language = attachment.language ? ` (${attachment.language})` : "";
    return `\n\nAttachment: ${attachment.name}${language}\n${attachment.content}`;
  }).join("") ?? "";
  const custom = agent.instructions ? `\n\nAgent instructions:\n${agent.instructions}` : "";
  return [
    `Intercom message for ${agent.name}.`,
    `From: ${from.name || from.id} (${from.id})`,
    `Message id: ${message.id}`,
    "",
    message.content.text,
    attachments,
    custom,
    replyInstruction,
  ].join("\n");
}

function textInput(text: string) {
  return { type: "text", text, text_elements: [] };
}

function statusText(status: unknown): string {
  if (!status || typeof status !== "object" || !("type" in status)) return "unknown";
  const type = (status as { type?: unknown }).type;
  return typeof type === "string" ? type : "unknown";
}

function getThreadId(result: unknown): string {
  const thread = result && typeof result === "object" ? (result as Record<string, unknown>).thread : undefined;
  if (!thread || typeof thread !== "object" || typeof (thread as Record<string, unknown>).id !== "string") {
    throw new Error("Codex app-server response did not include thread.id");
  }
  return (thread as Record<string, string>).id;
}

function getTurnId(result: unknown): string {
  const turn = result && typeof result === "object" ? (result as Record<string, unknown>).turn : undefined;
  if (!turn || typeof turn !== "object" || typeof (turn as Record<string, unknown>).id !== "string") {
    throw new Error("Codex app-server response did not include turn.id");
  }
  return (turn as Record<string, string>).id;
}

function getNotificationThreadId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const value = (params as Record<string, unknown>).threadId;
  return typeof value === "string" ? value : null;
}

function getNotificationTurnId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const direct = (params as Record<string, unknown>).turnId;
  if (typeof direct === "string") return direct;
  const turn = (params as Record<string, unknown>).turn;
  if (turn && typeof turn === "object" && typeof (turn as Record<string, unknown>).id === "string") {
    return (turn as Record<string, string>).id;
  }
  return null;
}

function getCompletedAgentText(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const item = (params as Record<string, unknown>).item;
  if (!item || typeof item !== "object") return null;
  const raw = item as Record<string, unknown>;
  return raw.type === "agentMessage" && typeof raw.text === "string" ? raw.text : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function normalizeToolName(name: string): string {
  const mcpMatch = name.match(/(?:^|__)intercom_(whoami|status|list|set_summary|send|ask|pending|reply)$/);
  if (mcpMatch) return `intercom_${mcpMatch[1]}`;
  return name;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") {
    const parsed: unknown = value.trim() ? JSON.parse(value) : {};
    if (!isRecord(parsed)) throw new Error("tool arguments must be an object");
    return parsed;
  }
  if (!isRecord(value)) throw new Error("tool arguments must be an object");
  return value;
}

function extractToolCall(message: JsonRpcMessage): { threadId: string | null; turnId: string | null; name: string; args: Record<string, unknown> } {
  const params = isRecord(message.params) ? message.params : {};
  const nested = ["toolCall", "tool", "call", "item"]
    .map((key) => params[key])
    .find(isRecord) ?? {};
  const rawName = params.name ?? params.toolName ?? params.tool_name ?? nested.name ?? nested.toolName ?? nested.tool_name;
  if (typeof rawName !== "string") throw new Error("item/tool/call did not include a tool name");
  const rawArgs = params.arguments ?? params.args ?? params.input ?? nested.arguments ?? nested.args ?? nested.input;
  const threadId = typeof params.threadId === "string" ? params.threadId : null;
  const turnId = typeof params.turnId === "string" ? params.turnId : null;
  return { threadId, turnId, name: normalizeToolName(rawName), args: parseToolArguments(rawArgs) };
}

function textToolResult(text: string, structuredContent?: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function appServerToolResponse(result: ToolResult): unknown {
  return {
    success: !result.isError,
    contentItems: result.content,
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  };
}

export class VirtualCodexAgent {
  private client = new IntercomClient();
  private threadId: string | null;
  private activeTurnId: string | null = null;
  private waiters = new Map<string, TurnWaiter[]>();
  private finalMessages = new Map<string, string>();
  private toolReplyWaiters = new Map<string, ToolReplyWaiter>();
  private messageQueue: Promise<void> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  private turnCompletionWaiters = new Map<string, Array<() => void>>();
  private toolMessageCountsByTurn = new Map<string, number>();
  private toolMessageTimestamps: number[] = [];

  constructor(
    private readonly agent: BridgeAgentConfig,
    private readonly app: CodexAppServerClient,
    private readonly state: BridgeState,
    private readonly statePath: string,
  ) {
    this.threadId = agent.threadId ?? state.agents[agent.id]?.threadId ?? null;
  }

  async start(): Promise<void> {
    this.client.on("message", (from: SessionInfo, message: Message) => {
      void this.routeMessage(from, message).catch((error) => {
        this.client.updatePresence({ status: `error: ${error instanceof Error ? error.message : String(error)}` });
      });
    });
    this.client.on("error", (error) => {
      process.stderr.write(`intercom ${this.agent.id}: ${error.message}\n`);
    });
    await this.client.connect({
      name: this.agent.name,
      cwd: this.agent.cwd,
      model: this.agent.model ?? "codex-app-server",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      status: this.threadId ? "idle" : "idle:no-thread",
    }, this.agent.id);
  }

  async stop(): Promise<void> {
    await this.client.disconnect();
  }

  get id(): string {
    return this.agent.id;
  }

  ownsThread(threadId: string): boolean {
    return this.threadId === threadId;
  }

  onNotification(message: JsonRpcMessage): void {
    const threadId = getNotificationThreadId(message.params);
    if (!threadId || threadId !== this.threadId) return;

    if (message.method === "turn/started") {
      this.activeTurnId = getNotificationTurnId(message.params);
      this.client.updatePresence({ status: "active" });
      return;
    }

    if (message.method === "thread/status/changed" && message.params && typeof message.params === "object") {
      const status = statusText((message.params as Record<string, unknown>).status);
      this.client.updatePresence({ status });
      return;
    }

    if (message.method === "item/completed") {
      const turnId = getNotificationTurnId(message.params);
      const text = getCompletedAgentText(message.params);
      if (turnId && text) this.finalMessages.set(turnId, text);
      return;
    }

    if (message.method === "turn/completed") {
      const turnId = getNotificationTurnId(message.params);
      if (!turnId) return;
      if (this.activeTurnId === turnId) this.activeTurnId = null;
      this.client.updatePresence({ status: "idle" });
      const idleWaiters = this.idleWaiters.splice(0);
      for (const resolve of idleWaiters) resolve();
      void this.finishTurn(turnId);
    }
  }

  async ensureThread(): Promise<string> {
    if (this.threadId) {
      try {
        await this.app.request("thread/resume", {
          threadId: this.threadId,
          cwd: this.agent.cwd,
          model: this.agent.model ?? null,
          approvalPolicy: this.agent.approvalPolicy ?? "never",
          sandbox: "read-only",
        });
        return this.threadId;
      } catch {
        this.threadId = null;
      }
    }

    const result = await this.app.request("thread/start", {
      cwd: this.agent.cwd,
      model: this.agent.model ?? null,
      approvalPolicy: this.agent.approvalPolicy ?? "never",
      sandbox: "read-only",
      serviceName: "codex-intercom",
      developerInstructions: this.agent.instructions ?? null,
      threadSource: "integration",
    });
    this.threadId = getThreadId(result);
    this.state.agents[this.agent.id] = { threadId: this.threadId, updatedAt: Date.now() };
    saveBridgeState(this.statePath, this.state);
    await this.app.request("thread/name/set", { threadId: this.threadId, name: this.agent.name }).catch(() => undefined);
    this.client.updatePresence({ status: "idle" });
    return this.threadId;
  }

  private routeMessage(from: SessionInfo, message: Message): Promise<void> {
    const toolWaiter = this.toolReplyWaiters.get(message.replyTo ?? "");
    if (toolWaiter) {
      if (from.id === toolWaiter.from) {
        this.toolReplyWaiters.delete(message.replyTo ?? "");
        clearTimeout(toolWaiter.timeout);
        toolWaiter.resolve(message);
        return Promise.resolve();
      }
    }

    const run = this.messageQueue
      .catch(() => undefined)
      .then(() => this.handleMessage(from, message));
    this.messageQueue = run.catch((error) => {
      this.client.updatePresence({ status: `error: ${error instanceof Error ? error.message : String(error)}` });
    });
    return run;
  }

  private async handleMessage(from: SessionInfo, message: Message): Promise<void> {
    const threadId = await this.ensureThread();
    await this.waitUntilIdle();
    const input = [textInput(formatMessage(from, message, this.agent))];
    const result = await this.startTurn(threadId, input);
    const turnId = getTurnId(result);
    const completed = this.waitForTurnCompletion(turnId);

    if (message.expectsReply) {
      const waiters = this.waiters.get(turnId) ?? [];
      waiters.push({ from, message });
      this.waiters.set(turnId, waiters);
    }
    await completed;
  }

  private startTurn(threadId: string, input: Array<ReturnType<typeof textInput>>): Promise<unknown> {
    this.client.updatePresence({ status: "active" });
    return this.app.request("turn/start", {
      threadId,
      input,
      cwd: this.agent.cwd,
      approvalPolicy: this.agent.approvalPolicy ?? "never",
      sandboxPolicy: this.agent.sandboxPolicy ?? { type: "readOnly", networkAccess: false },
      model: this.agent.model ?? null,
    });
  }

  private async replyToWaiters(turnId: string): Promise<void> {
    const waiters = this.waiters.get(turnId);
    if (!waiters?.length) return;
    this.waiters.delete(turnId);
    const reply = this.finalMessages.get(turnId)?.trim() || "Codex turn completed without a final message.";
    for (const waiter of waiters) {
      await this.client.send(waiter.from.id, { text: reply, replyTo: waiter.message.id }).catch((error) => {
        process.stderr.write(`reply failed for ${this.agent.id}: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }
  }

  private waitUntilIdle(): Promise<void> {
    if (!this.activeTurnId) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private waitForTurnCompletion(turnId: string): Promise<void> {
    return new Promise((resolve) => {
      const waiters = this.turnCompletionWaiters.get(turnId) ?? [];
      waiters.push(resolve);
      this.turnCompletionWaiters.set(turnId, waiters);
    });
  }

  private async finishTurn(turnId: string): Promise<void> {
    try {
      await this.replyToWaiters(turnId);
    } finally {
      this.finalMessages.delete(turnId);
      this.waiters.delete(turnId);
      this.toolMessageCountsByTurn.delete(turnId);
      const waiters = this.turnCompletionWaiters.get(turnId) ?? [];
      this.turnCompletionWaiters.delete(turnId);
      for (const resolve of waiters) resolve();
    }
  }

  async handleToolCall(name: string, args: Record<string, unknown>, turnId: string | null): Promise<unknown> {
    try {
      const result = await this.callIntercomTool(name, args, turnId);
      return appServerToolResponse(result);
    } catch (error) {
      return appServerToolResponse(textToolResult(error instanceof Error ? error.message : String(error), { ok: false }, true));
    }
  }

  private async callIntercomTool(name: string, args: Record<string, unknown>, turnId: string | null): Promise<ToolResult> {
    switch (name) {
      case "intercom_whoami":
        return textToolResult(
          `session_id: ${this.agent.id}\nname: ${this.agent.name}\ncwd: ${this.agent.cwd}`,
          { session_id: this.agent.id, name: this.agent.name, cwd: this.agent.cwd, model: this.agent.model ?? "codex-app-server" },
        );
      case "intercom_status": {
        const sessions = await this.client.listSessions();
        return textToolResult(
          `Connected: Yes\nSession ID: ${this.agent.id}\nActive sessions: ${sessions.length}`,
          { connected: true, session_id: this.agent.id, active_sessions: sessions.length },
        );
      }
      case "intercom_list": {
        const includeSelf = typeof args.include_self === "boolean" ? args.include_self : false;
        const sessions = (await this.client.listSessions()).filter((session) => includeSelf || session.id !== this.agent.id);
        return textToolResult(formatSessionList(sessions, this.agent.id, this.agent.cwd), { sessions });
      }
      case "intercom_set_summary": {
        const summary = asString(args.summary, "summary");
        this.client.updatePresence({ status: summary.trim() || "idle" });
        return textToolResult("Summary updated.", { ok: true, summary });
      }
      case "intercom_send": {
        const limit = this.reserveToolMessage(turnId);
        if (limit) return limit;
        const to = asString(args.to, "to");
        const message = asString(args.message, "message");
        const sendTo = await this.resolveTarget(to);
        const result = await this.client.send(sendTo, { text: message });
        if (!result.delivered) {
          return textToolResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
        }
        return textToolResult(`Message sent to ${to}.`, { ok: true, message_id: result.id, to });
      }
      case "intercom_ask": {
        const limit = this.reserveToolMessage(turnId);
        if (limit) return limit;
        const to = asString(args.to, "to");
        const message = asString(args.message, "message");
        const sendTo = await this.resolveTarget(to);
        const questionId = randomUUID();
        const replyPromise = this.waitForToolReply(sendTo, questionId);
        const result = await this.client.send(sendTo, { messageId: questionId, text: message, expectsReply: true });
        if (!result.delivered) {
          this.rejectToolReply(questionId, new Error(result.reason ?? "Session may not exist or has disconnected."));
          return textToolResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
        }
        const reply = await replyPromise;
        return textToolResult(`Reply from ${to}:\n${reply.content.text}${formatAttachments(reply.content.attachments)}`, { ok: true, message_id: result.id, reply });
      }
      case "intercom_pending":
        return textToolResult("No unread messages.", { unread_messages: [], pending_asks: [] });
      case "intercom_reply":
        return textToolResult("No matching pending ask. App-server sidecar asks are answered automatically by final assistant messages.", { ok: false }, true);
      default:
        return textToolResult(`Unknown tool: ${name}`, { ok: false }, true);
    }
  }

  private reserveToolMessage(turnId: string | null): ToolResult | null {
    const now = Date.now();
    this.toolMessageTimestamps = this.toolMessageTimestamps.filter((timestamp) => now - timestamp < 60000);
    if (this.toolMessageTimestamps.length >= MAX_TOOL_MESSAGES_PER_MINUTE) {
      return textToolResult(`Intercom message limit reached: max ${MAX_TOOL_MESSAGES_PER_MINUTE} sidecar-originated sends per minute.`, { ok: false, limit: "per_minute" }, true);
    }

    const key = turnId ?? "unknown-turn";
    const count = this.toolMessageCountsByTurn.get(key) ?? 0;
    if (count >= MAX_TOOL_MESSAGES_PER_TURN) {
      return textToolResult(`Intercom message limit reached: max ${MAX_TOOL_MESSAGES_PER_TURN} sidecar-originated sends per turn.`, { ok: false, limit: "per_turn" }, true);
    }

    this.toolMessageCountsByTurn.set(key, count + 1);
    this.toolMessageTimestamps.push(now);
    return null;
  }

  private async resolveTarget(to: string): Promise<string> {
    const sessions = await this.client.listSessions();
    return resolveSessionTarget(sessions, to) ?? to;
  }

  private waitForToolReply(from: string, replyTo: string): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.toolReplyWaiters.delete(replyTo);
        this.client.cancelAsk(replyTo);
        reject(new Error(`No reply from "${from}" before timeout`));
      }, 120000);
      this.toolReplyWaiters.set(replyTo, { from, resolve, reject, timeout });
    });
  }

  private rejectToolReply(replyTo: string, error: Error): void {
    const waiter = this.toolReplyWaiters.get(replyTo);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.toolReplyWaiters.delete(replyTo);
    waiter.reject(error);
    this.client.cancelAsk(replyTo);
  }
}

export class CodexBridgeDaemon {
  private app: CodexAppServerClient;
  private agents: VirtualCodexAgent[] = [];

  constructor(private readonly config: BridgeConfig) {
    this.app = new CodexAppServerClient(config.appServer);
    this.app.setServerRequestHandler((message) => this.handleServerRequest(message));
  }

  async start(): Promise<void> {
    const intercomConfig = loadConfig();
    await spawnBrokerIfNeeded(intercomConfig.brokerCommand, intercomConfig.brokerArgs);
    await this.app.connect();
    const state = loadBridgeState(this.config.statePath);
    this.app.on("notification", (message: JsonRpcMessage) => {
      for (const agent of this.agents) agent.onNotification(message);
    });
    this.agents = this.config.agents.map((agent) => new VirtualCodexAgent(agent, this.app, state, this.config.statePath));
    for (const agent of this.agents) await agent.start();
    process.stderr.write(`codex-intercom bridge running ${this.agents.length} virtual agent(s)\n`);
  }

  async stop(): Promise<void> {
    for (const agent of this.agents) await agent.stop().catch(() => undefined);
    await this.app.disconnect();
  }

  async ensureThreadForAgent(agentId: string): Promise<string> {
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`No bridge agent registered with id: ${agentId}`);
    return agent.ensureThread();
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<unknown> {
    if (message.method === "mcpServer/elicitation/request" && isIntercomToolApprovalRequest(message.params)) {
      return { action: "accept", content: {}, _meta: null };
    }

    if (message.method !== "item/tool/call") {
      if (!message.method) throw new Error("Unsupported app-server request");
      return defaultServerRequestResponse(message.method);
    }

    const call = extractToolCall(message);
    const agent = call.threadId
      ? this.agents.find((candidate) => candidate.ownsThread(call.threadId!))
      : this.agents[0];
    if (!agent) return appServerToolResponse(textToolResult("No bridge agent owns this tool call.", { ok: false }, true));
    return agent.handleToolCall(call.name, call.args, call.turnId);
  }
}

export function isIntercomToolApprovalRequest(params: unknown): boolean {
  if (!isRecord(params)) return false;
  const meta = isRecord(params._meta) ? params._meta : {};
  return params.serverName === "codex-intercom"
    && meta.codex_approval_kind === "mcp_tool_call"
    && Boolean(getApprovedIntercomToolFromApproval(params));
}

export function getApprovedIntercomToolFromApproval(params: unknown): string | null {
  if (!isRecord(params)) return null;
  const meta = isRecord(params._meta) ? params._meta : {};
  const candidates = [
    meta.tool,
    meta.toolName,
    meta.tool_name,
    meta.name,
    typeof params.message === "string" ? params.message.match(/tool "([^"]+)"/)?.[1] : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && APPROVED_INTERCOM_TOOLS.has(candidate)) return candidate;
  }
  return null;
}

async function main(): Promise<void> {
  const configPath = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : undefined;
  const config = loadBridgeConfig(configPath);
  if (!config.agents.length) throw new Error("Bridge config must include at least one agent");
  const daemon = new CodexBridgeDaemon(config);
  const stop = () => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await daemon.start();
  await once(process, "SIGTERM");
}

if (process.argv[1] && basename(process.argv[1]) === "bridge-daemon.ts") {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
