import { once } from "node:events";
import { basename } from "node:path";
import { CodexAppServerClient, type JsonRpcMessage } from "./app-server-client.ts";
import { loadBridgeConfig, loadBridgeState, saveBridgeState, type BridgeAgentConfig, type BridgeConfig, type BridgeState } from "./bridge-config.ts";
import { IntercomClient } from "../broker/client.ts";
import { spawnBrokerIfNeeded } from "../broker/spawn.ts";
import { loadConfig } from "../config.ts";
import type { Message, SessionInfo } from "../types.ts";

interface TurnWaiter {
  from: SessionInfo;
  message: Message;
}

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

export class VirtualCodexAgent {
  private client = new IntercomClient();
  private threadId: string | null;
  private activeTurnId: string | null = null;
  private waiters = new Map<string, TurnWaiter[]>();
  private finalMessages = new Map<string, string>();

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
      void this.handleMessage(from, message).catch((error) => {
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
      void this.replyToWaiters(turnId);
    }
  }

  private async ensureThread(): Promise<string> {
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

  private async handleMessage(from: SessionInfo, message: Message): Promise<void> {
    const threadId = await this.ensureThread();
    const input = [textInput(formatMessage(from, message, this.agent))];
    let turnId: string;

    if (this.activeTurnId) {
      try {
        const result = await this.app.request("turn/steer", {
          threadId,
          expectedTurnId: this.activeTurnId,
          input,
        });
        const steered = result && typeof result === "object" ? (result as Record<string, unknown>).turnId : undefined;
        turnId = typeof steered === "string" ? steered : this.activeTurnId;
      } catch {
        const result = await this.startTurn(threadId, input);
        turnId = getTurnId(result);
      }
    } else {
      const result = await this.startTurn(threadId, input);
      turnId = getTurnId(result);
    }

    if (message.expectsReply) {
      const waiters = this.waiters.get(turnId) ?? [];
      waiters.push({ from, message });
      this.waiters.set(turnId, waiters);
    }
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
}

export class CodexBridgeDaemon {
  private app: CodexAppServerClient;
  private agents: VirtualCodexAgent[] = [];

  constructor(private readonly config: BridgeConfig) {
    this.app = new CodexAppServerClient(config.appServer);
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
