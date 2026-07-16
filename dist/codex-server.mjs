#!/usr/bin/env node

// codex/server.ts
import readline from "node:readline";
import { stdin, stdout } from "node:process";

// codex/runtime.ts
import { randomUUID as randomUUID4, createHash as createHash2 } from "crypto";
import { spawnSync } from "child_process";
import { basename } from "path";
import { cwd as processCwd } from "process";

// broker/client.ts
import { EventEmitter } from "events";
import net from "net";
import { randomUUID as randomUUID2 } from "crypto";

// broker/framing.ts
var MAX_FRAME_BYTES = 1024 * 1024;
function writeMessage(socket, msg) {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}
function createMessageReader(onMessage, onError, maxFrameBytes = MAX_FRAME_BYTES) {
  let buffer = Buffer.alloc(0);
  function reportMessage(payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf-8"));
    } catch (error2) {
      const message = error2 instanceof Error ? error2.message : String(error2);
      onError(new Error(`Failed to parse intercom message: ${message}`, { cause: error2 }));
      return false;
    }
    try {
      onMessage(msg);
      return true;
    } catch (error2) {
      const message = error2 instanceof Error ? error2.message : String(error2);
      onError(new Error(`Failed to handle intercom message: ${message}`, { cause: error2 }));
      return false;
    }
  }
  return (data) => {
    let remaining = data;
    while (remaining.length > 0) {
      if (buffer.length < 4) {
        const headerBytes = Math.min(4 - buffer.length, remaining.length);
        buffer = Buffer.concat([buffer, remaining.subarray(0, headerBytes)]);
        remaining = remaining.subarray(headerBytes);
        if (buffer.length < 4) {
          return;
        }
      }
      const length = buffer.readUInt32BE(0);
      if (length > maxFrameBytes) {
        buffer = Buffer.alloc(0);
        onError(new Error(`Intercom frame length ${length} exceeds maximum ${maxFrameBytes} bytes`));
        return;
      }
      const missingPayloadBytes = length - Math.max(0, buffer.length - 4);
      const payloadBytes = Math.min(missingPayloadBytes, remaining.length);
      if (payloadBytes > 0) {
        buffer = Buffer.concat([buffer, remaining.subarray(0, payloadBytes)]);
        remaining = remaining.subarray(payloadBytes);
      }
      if (buffer.length < 4 + length) {
        return;
      }
      const payload = buffer.subarray(4, 4 + length);
      buffer = Buffer.alloc(0);
      if (!reportMessage(payload)) {
        return;
      }
    }
  };
}

// outbound-outbox.ts
import { createHash } from "crypto";
import { chmodSync as chmodSync2, existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2 } from "fs";
import { join as join2 } from "path";

// broker/paths.ts
import { chmodSync, mkdirSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { homedir } from "os";
var INTERCOM_DIR_MODE = 448;
var INTERCOM_RUNTIME_FILE_MODE = 384;
var INTERCOM_TCP_HOST = "127.0.0.1";
var INTERCOM_PROTOCOL_NAME = "pi-intercom";
var INTERCOM_PROTOCOL_VERSION = 3;
function sanitizePipeSegment(value) {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "default";
}
function getAgentDirPath(env = process.env, homeDir = homedir(), cwd = process.cwd()) {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) {
    return join(homeDir, ".pi/agent");
  }
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}
function getIntercomDirPath(agentDir = getAgentDirPath()) {
  return join(agentDir, "intercom");
}
function shouldUseWindowsTcpTransport(platform = process.platform, env = process.env) {
  if (platform !== "win32") {
    return false;
  }
  const transport = env.PI_INTERCOM_TRANSPORT?.trim().toLowerCase();
  if (transport === "tcp") {
    return true;
  }
  const legacyOptIn = env.PI_INTERCOM_TCP?.trim().toLowerCase();
  return legacyOptIn === "1" || legacyOptIn === "true";
}
function getBrokerPortFilePath(intercomDir = getIntercomDirPath()) {
  return join(intercomDir, "broker.port.json");
}
function getBrokerSocketPath(platform = process.platform, agentDir = getAgentDirPath()) {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(agentDir)}`;
  }
  return join(getIntercomDirPath(agentDir), "broker.sock");
}
function getBrokerConnectTarget(platform = process.platform, env = process.env, intercomDir = getIntercomDirPath(getAgentDirPath(env))) {
  if (shouldUseWindowsTcpTransport(platform, env)) {
    const endpointFile = getBrokerPortFilePath(intercomDir);
    const raw = readFileSync(endpointFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}: expected a JSON object`);
    }
    const endpoint = parsed;
    if (endpoint.transport !== "tcp" || endpoint.host !== INTERCOM_TCP_HOST || typeof endpoint.port !== "number" || !Number.isSafeInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535 || typeof endpoint.stateId !== "string" || endpoint.stateId.length === 0) {
      throw new Error(`Invalid intercom TCP endpoint at ${endpointFile}`);
    }
    return { transport: "tcp", host: endpoint.host, port: endpoint.port, stateId: endpoint.stateId };
  }
  return getBrokerSocketPath(platform, getAgentDirPath(env));
}
function ensureIntercomRuntimeDir(intercomDir = getIntercomDirPath(), platform = process.platform) {
  mkdirSync(intercomDir, { recursive: true, mode: INTERCOM_DIR_MODE });
  if (platform !== "win32") {
    chmodSync(intercomDir, INTERCOM_DIR_MODE);
  }
}
function restrictIntercomRuntimeFile(filePath, platform = process.platform) {
  if (platform !== "win32") {
    chmodSync(filePath, INTERCOM_RUNTIME_FILE_MODE);
  }
}

// durable-json.ts
import { randomUUID } from "crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
function writeDurableJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf-8", mode: INTERCOM_RUNTIME_FILE_MODE });
  const fileDescriptor = openSync(temporaryPath, "r");
  try {
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  renameSync(temporaryPath, filePath);
  restrictIntercomRuntimeFile(filePath);
  if (process.platform !== "win32") {
    const directoryDescriptor = openSync(dirname(filePath), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}

// outbound-outbox.ts
var OUTBOX_STATE_VERSION = 1;
var MAX_OUTBOX_MESSAGES = 256;
function fingerprint(entry) {
  return JSON.stringify({
    to: entry.to,
    replyTo: entry.message.replyTo,
    expectsReply: entry.message.expectsReply,
    content: entry.message.content
  });
}
function isStoredOutboundMessage(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value;
  if (typeof entry.to !== "string" || typeof entry.queuedAt !== "number") return false;
  if (typeof entry.message !== "object" || entry.message === null || Array.isArray(entry.message)) return false;
  const message = entry.message;
  return typeof message.id === "string" && typeof message.timestamp === "number" && typeof message.content === "object" && message.content !== null && typeof message.content.text === "string";
}
function fileName(sessionId) {
  return `${createHash("sha256").update(sessionId).digest("hex")}.json`;
}
var PersistentOutboundOutbox = class {
  directory;
  filePath;
  state;
  constructor(sessionId, intercomDir = getIntercomDirPath()) {
    ensureIntercomRuntimeDir(intercomDir);
    this.directory = join2(intercomDir, "outbox");
    mkdirSync2(this.directory, { recursive: true, mode: INTERCOM_DIR_MODE });
    if (process.platform !== "win32") chmodSync2(this.directory, INTERCOM_DIR_MODE);
    this.filePath = join2(this.directory, fileName(sessionId));
    this.state = this.load();
  }
  list() {
    return this.state.entries.map((entry) => ({ ...entry, message: { ...entry.message, content: { ...entry.message.content } } }));
  }
  enqueue(to, message) {
    const existing = this.state.entries.find((entry) => entry.message.id === message.id);
    if (existing) {
      if (fingerprint(existing) !== fingerprint({ to, message })) {
        throw new Error(`Message ID ${message.id} is already queued with a different payload`);
      }
      return "existing";
    }
    if (this.state.entries.length >= MAX_OUTBOX_MESSAGES) {
      throw new Error(`Durable outbox is full (${MAX_OUTBOX_MESSAGES} messages)`);
    }
    this.state.entries.push({ to, message, queuedAt: Date.now() });
    this.persist();
    return "added";
  }
  remove(messageId) {
    const remaining = this.state.entries.filter((entry) => entry.message.id !== messageId);
    if (remaining.length === this.state.entries.length) return;
    this.state.entries = remaining;
    this.persist();
  }
  clear() {
    if (this.state.entries.length === 0) return;
    this.state.entries = [];
    this.persist();
  }
  load() {
    if (!existsSync(this.filePath)) return { version: OUTBOX_STATE_VERSION, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync2(this.filePath, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected object");
      const state = parsed;
      if (state.version !== OUTBOX_STATE_VERSION || !Array.isArray(state.entries) || !state.entries.every(isStoredOutboundMessage)) {
        throw new Error("invalid outbox state");
      }
      return { version: OUTBOX_STATE_VERSION, entries: state.entries };
    } catch {
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
      renameSync2(this.filePath, corruptPath);
      restrictIntercomRuntimeFile(corruptPath);
      return { version: OUTBOX_STATE_VERSION, entries: [] };
    }
  }
  persist() {
    writeDurableJson(this.filePath, this.state);
  }
};

// broker/client.ts
function toError(error2) {
  return error2 instanceof Error ? error2 : new Error(String(error2));
}
function connectToBrokerTarget(target) {
  return typeof target === "string" ? net.connect(target) : net.connect({ host: target.host, port: target.port });
}
function isAttachment(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const attachment = value;
  if (attachment.type !== "file" && attachment.type !== "snippet" && attachment.type !== "context") {
    return false;
  }
  if (typeof attachment.name !== "string" || typeof attachment.content !== "string") {
    return false;
  }
  return attachment.language === void 0 || typeof attachment.language === "string";
}
function isMessage(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const message = value;
  if (typeof message.id !== "string" || typeof message.timestamp !== "number") {
    return false;
  }
  if (message.replyTo !== void 0 && typeof message.replyTo !== "string") {
    return false;
  }
  if (message.expectsReply !== void 0 && typeof message.expectsReply !== "boolean") {
    return false;
  }
  if (typeof message.content !== "object" || message.content === null) {
    return false;
  }
  const content = message.content;
  if (typeof content.text !== "string") {
    return false;
  }
  return content.attachments === void 0 || Array.isArray(content.attachments) && content.attachments.every(isAttachment);
}
function isSessionInfo(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const session = value;
  if (typeof session.id !== "string" || typeof session.cwd !== "string" || typeof session.model !== "string" || typeof session.pid !== "number" || typeof session.startedAt !== "number" || typeof session.lastActivity !== "number") {
    return false;
  }
  if (session.name !== void 0 && typeof session.name !== "string") {
    return false;
  }
  if (session.status !== void 0 && typeof session.status !== "string") {
    return false;
  }
  if (session.peerUid !== void 0 && typeof session.peerUid !== "number") {
    return false;
  }
  return session.trustedLocal === void 0 || typeof session.trustedLocal === "boolean";
}
var IntercomClient = class extends EventEmitter {
  socket = null;
  _sessionId = null;
  pendingSends = /* @__PURE__ */ new Map();
  pendingLists = /* @__PURE__ */ new Map();
  pendingAskControls = /* @__PURE__ */ new Map();
  outbox = null;
  disconnecting = false;
  disconnectError = null;
  failPending(error2) {
    for (const pending of this.pendingSends.values()) {
      pending.reject(error2);
    }
    this.pendingSends.clear();
    for (const pending of this.pendingLists.values()) {
      pending.reject(error2);
    }
    this.pendingLists.clear();
    for (const pending of this.pendingAskControls.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    this.pendingAskControls.clear();
  }
  get sessionId() {
    return this._sessionId;
  }
  get outboxSize() {
    return this.outbox?.list().length ?? 0;
  }
  isConnected() {
    const socket = this.socket;
    return Boolean(socket && this._sessionId && !this.disconnecting && !socket.destroyed && !socket.writableEnded && socket.writable);
  }
  requireActiveSocket() {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }
    const socket = this.socket;
    if (!socket || !this._sessionId) {
      throw new Error("Not connected");
    }
    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      throw new Error("Client disconnected");
    }
    return socket;
  }
  connect(session, sessionId) {
    if (this.socket) {
      return Promise.reject(new Error("Already connected"));
    }
    return new Promise((resolve3, reject) => {
      let socket;
      let target;
      try {
        target = getBrokerConnectTarget();
        socket = connectToBrokerTarget(target);
      } catch (error2) {
        reject(toError(error2));
        return;
      }
      this.socket = socket;
      this.disconnectError = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new Error("Connection timeout"));
        }
      }, 1e4);
      let connectionEstablished = false;
      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        resolve3();
      };
      const onError = (err) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };
      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        const disconnectError = this.disconnectError ?? new Error("Client disconnected");
        this.disconnecting = false;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending(disconnectError);
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        this.disconnectError = null;
        if (connectionEstablished && !wasDisconnecting) {
          this.emit("disconnected", disconnectError);
        }
        if (wasConnecting) {
          reject(new Error("Connection closed before registration"));
        }
      };
      const onSocketError = (err) => {
        if (connectionEstablished) {
          this.disconnectError = err;
          this.emit("error", err);
        }
      };
      const onReaderError = (error2) => {
        const protocolError = new Error(`Intercom protocol error: ${error2.message}`, { cause: error2 });
        if (!connectionEstablished) {
          onError(protocolError);
          return;
        }
        this.disconnectError = protocolError;
        this.emit("error", protocolError);
        socket.destroy();
      };
      const reader = createMessageReader((msg) => {
        this.handleBrokerMessage(msg);
      }, onReaderError);
      const cleanupConnectionAttempt = () => {
        this.off("_registered", onRegistered);
        socket.off("error", onError);
        clearTimeout(timeout);
      };
      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };
      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("error", onSocketError);
      this.once("_registered", onRegistered);
      try {
        writeMessage(socket, {
          type: "register",
          protocol: INTERCOM_PROTOCOL_NAME,
          version: INTERCOM_PROTOCOL_VERSION,
          session,
          ...sessionId ? { sessionId } : {},
          ...typeof target === "string" ? {} : { stateId: target.stateId }
        });
      } catch (error2) {
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(toError(error2));
      }
    });
  }
  handleBrokerMessage(msg) {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid broker message");
    }
    const brokerMessage = msg;
    if (this._sessionId === null && brokerMessage.type !== "registered" && brokerMessage.type !== "error") {
      throw new Error(`Received ${brokerMessage.type} before registered`);
    }
    switch (brokerMessage.type) {
      case "registered": {
        if (typeof brokerMessage.sessionId !== "string" || brokerMessage.protocol !== INTERCOM_PROTOCOL_NAME || brokerMessage.version !== INTERCOM_PROTOCOL_VERSION) {
          throw new Error("Invalid registered message");
        }
        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
        }
        this._sessionId = brokerMessage.sessionId;
        this.outbox = new PersistentOutboundOutbox(brokerMessage.sessionId);
        this.replayOutbox();
        this.emit("_registered", { type: "registered", sessionId: brokerMessage.sessionId });
        break;
      }
      case "sessions": {
        const { requestId, sessions } = brokerMessage;
        if (typeof requestId !== "string" || !Array.isArray(sessions) || !sessions.every(isSessionInfo)) {
          throw new Error("Invalid sessions message");
        }
        const pending = this.pendingLists.get(requestId);
        if (!pending) {
          return;
        }
        this.pendingLists.delete(requestId);
        pending.resolve(sessions);
        break;
      }
      case "message": {
        const { deliveryId, from, message } = brokerMessage;
        if (typeof deliveryId !== "string" || !isSessionInfo(from) || !isMessage(message)) {
          throw new Error("Invalid message event");
        }
        this.emit("message", from, message, deliveryId);
        break;
      }
      case "delivery_accepted": {
        const { deliveryId, messageId } = brokerMessage;
        if (typeof deliveryId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid delivery_accepted message");
        }
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          return;
        }
        pending.accepted = true;
        pending.deliveryId = deliveryId;
        this.emit("delivery_accepted", messageId, deliveryId);
        break;
      }
      case "delivered": {
        const { deliveryId, messageId } = brokerMessage;
        if (typeof deliveryId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid delivered message");
        }
        this.outbox?.remove(messageId);
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          this.emit("outbox_delivered", messageId, deliveryId);
          return;
        }
        this.pendingSends.delete(messageId);
        pending.resolve({ id: messageId, accepted: true, delivered: true, deliveryId });
        break;
      }
      case "delivery_failed": {
        const { accepted, code, messageId, reason } = brokerMessage;
        if (typeof accepted !== "boolean" || typeof code !== "string" || typeof messageId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid delivery_failed message");
        }
        this.outbox?.remove(messageId);
        const pending = this.pendingSends.get(messageId);
        if (!pending) {
          this.emit("outbox_failed", messageId, code, reason);
          return;
        }
        this.pendingSends.delete(messageId);
        pending.resolve({
          id: messageId,
          accepted,
          delivered: false,
          code,
          reason,
          ...pending.deliveryId ? { deliveryId: pending.deliveryId } : {}
        });
        break;
      }
      case "ask_deferred": {
        const { fromSessionId, messageId } = brokerMessage;
        if (typeof fromSessionId !== "string" || typeof messageId !== "string") {
          throw new Error("Invalid ask_deferred message");
        }
        this.emit("ask_deferred", messageId, fromSessionId);
        break;
      }
      case "ask_cancelled": {
        const { fromSessionId, messageId, reason } = brokerMessage;
        if (typeof fromSessionId !== "string" || typeof messageId !== "string" || typeof reason !== "string") {
          throw new Error("Invalid ask_cancelled message");
        }
        this.emit("ask_cancelled", messageId, fromSessionId, reason);
        break;
      }
      case "ask_control_result": {
        const { action, applied, messageId, requestId } = brokerMessage;
        if (action !== "defer" && action !== "cancel" || typeof applied !== "boolean" || typeof messageId !== "string" || typeof requestId !== "string") {
          throw new Error("Invalid ask_control_result message");
        }
        const pending = this.pendingAskControls.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pendingAskControls.delete(requestId);
        pending.resolve(applied);
        break;
      }
      case "session_joined": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid session_joined message");
        }
        this.emit("session_joined", brokerMessage.session);
        break;
      }
      case "session_left": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid session_left message");
        }
        this.emit("session_left", brokerMessage.sessionId);
        break;
      }
      case "presence_update": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid presence_update message");
        }
        this.emit("presence_update", brokerMessage.session);
        break;
      }
      case "error": {
        if (typeof brokerMessage.code !== "string" || typeof brokerMessage.error !== "string") {
          throw new Error("Invalid error message");
        }
        if (this._sessionId === null) {
          const error3 = new Error(brokerMessage.error);
          error3.code = brokerMessage.code;
          throw error3;
        }
        const error2 = new Error(brokerMessage.error);
        error2.code = brokerMessage.code;
        this.emit("error", error2);
        break;
      }
      default:
        throw new Error(`Unknown broker message type: ${brokerMessage.type}`);
    }
  }
  async disconnect(preserveAsks = false) {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.disconnecting = true;
    this.disconnectError = null;
    this.failPending(new Error("Client disconnected"));
    if (!preserveAsks) this.outbox?.clear();
    await new Promise((resolve3) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve3();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2e3);
      socket.once("close", onClose);
      socket.once("error", onError);
      try {
        writeMessage(socket, { type: "unregister", ...preserveAsks ? { preserveAsks: true } : {} });
        socket.end();
      } catch {
        socket.destroy();
      }
    });
  }
  listSessions() {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error2) {
      return Promise.reject(toError(error2));
    }
    return new Promise((resolve3, reject) => {
      const requestId = randomUUID2();
      const wrappedResolve = (sessions) => {
        clearTimeout(timeout);
        resolve3(sessions);
      };
      const wrappedReject = (error2) => {
        clearTimeout(timeout);
        reject(error2);
      };
      const timeout = setTimeout(() => {
        if (this.pendingLists.has(requestId)) {
          this.pendingLists.delete(requestId);
          wrappedReject(new Error("List sessions timeout"));
        }
      }, 5e3);
      this.pendingLists.set(requestId, { resolve: wrappedResolve, reject: wrappedReject });
      try {
        writeMessage(socket, { type: "list", requestId });
      } catch (error2) {
        clearTimeout(timeout);
        this.pendingLists.delete(requestId);
        reject(toError(error2));
      }
    });
  }
  send(to, options) {
    let socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error2) {
      return Promise.reject(toError(error2));
    }
    const messageId = options.messageId ?? randomUUID2();
    if (this.pendingSends.has(messageId)) {
      return Promise.resolve({
        id: messageId,
        accepted: false,
        delivered: false,
        code: "DUPLICATE_MESSAGE_ID",
        reason: `Message ID ${messageId} is already pending`
      });
    }
    const message = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      content: {
        text: options.text,
        attachments: options.attachments
      }
    };
    try {
      this.outbox?.enqueue(to, message);
    } catch (error2) {
      return Promise.reject(toError(error2));
    }
    return new Promise((resolve3, reject) => {
      const wrappedResolve = (result) => {
        clearTimeout(timeout);
        resolve3(result);
      };
      const wrappedReject = (error2) => {
        clearTimeout(timeout);
        reject(error2);
      };
      const timeout = setTimeout(() => {
        if (this.pendingSends.has(messageId)) {
          this.pendingSends.delete(messageId);
          wrappedReject(new Error("Send timeout"));
        }
      }, 1e4);
      this.pendingSends.set(messageId, {
        accepted: false,
        resolve: wrappedResolve,
        reject: wrappedReject
      });
      try {
        writeMessage(socket, { type: "send", to, message });
      } catch (error2) {
        clearTimeout(timeout);
        this.pendingSends.delete(messageId);
        reject(toError(error2));
      }
    });
  }
  acknowledgeMessage(deliveryId) {
    return this.writeControlMessage({ type: "message_received", deliveryId });
  }
  rejectMessage(deliveryId, reason) {
    return this.writeControlMessage({ type: "message_rejected", deliveryId, code: "CONFLICTING_MESSAGE_ID", reason });
  }
  deferAsk(messageId) {
    return this.sendAskControl("defer", messageId);
  }
  cancelAsk(messageId) {
    return this.sendAskControl("cancel", messageId);
  }
  sendAskControl(action, messageId) {
    const requestId = randomUUID2();
    return new Promise((resolve3) => {
      const timeout = setTimeout(() => {
        this.pendingAskControls.delete(requestId);
        resolve3(false);
      }, 2e3);
      timeout.unref?.();
      this.pendingAskControls.set(requestId, { resolve: resolve3, timeout });
      if (!this.writeControlMessage({ type: action === "defer" ? "defer_ask" : "cancel_ask", requestId, messageId })) {
        clearTimeout(timeout);
        this.pendingAskControls.delete(requestId);
        resolve3(false);
      }
    });
  }
  writeControlMessage(message) {
    if (this.disconnecting) {
      return false;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return false;
    }
    try {
      writeMessage(socket, message);
      return true;
    } catch {
      return false;
    }
  }
  replayOutbox() {
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) return;
    for (const entry of this.outbox?.list() ?? []) {
      if (this.pendingSends.has(entry.message.id)) continue;
      try {
        writeMessage(socket, { type: "send", to: entry.to, message: entry.message });
      } catch {
        return;
      }
    }
  }
  updatePresence(updates) {
    if (this.disconnecting) {
      return;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }
    writeMessage(socket, { type: "presence", ...updates });
  }
};

// broker/spawn.ts
import { spawn } from "child_process";
import { existsSync as existsSync2, readFileSync as readFileSync3, unlinkSync, writeFileSync as writeFileSync2 } from "fs";
import { join as join3, dirname as dirname2 } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import net2 from "net";
import { randomUUID as randomUUID3 } from "crypto";
var INTERCOM_DIR = getIntercomDirPath();
var EXTENSION_DIR = join3(dirname2(fileURLToPath(import.meta.url)), "..");
var BROKER_PID = join3(INTERCOM_DIR, "broker.pid");
var BROKER_SPAWN_LOCK = join3(INTERCOM_DIR, "broker.spawn.lock");
function sleep(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
function getBrokerEntryPath(moduleUrl = import.meta.url) {
  const moduleDir = dirname2(fileURLToPath(moduleUrl));
  const bundledBroker = join3(moduleDir, "broker.mjs");
  return existsSync2(bundledBroker) ? bundledBroker : join3(moduleDir, "broker.ts");
}
function getTsxCliPath(extensionDir = EXTENSION_DIR) {
  try {
    const requireFromExtension = createRequire(import.meta.url);
    const tsxMain = requireFromExtension.resolve("tsx");
    return join3(dirname2(tsxMain), "cli.mjs");
  } catch {
    return join3(extensionDir, "node_modules", "tsx", "dist", "cli.mjs");
  }
}
function quoteWindowsArg(value) {
  return `"${value.replace(/"/g, '""')}"`;
}
function getWindowsHiddenLauncherPath(intercomDir = INTERCOM_DIR) {
  return join3(intercomDir, "broker-launch.vbs");
}
function usesDefaultBrokerCommand(brokerCommand, brokerArgs) {
  return brokerCommand === "npx" && brokerArgs.length === 2 && brokerArgs[0] === "--no-install" && brokerArgs[1] === "tsx";
}
function getWindowsBrokerCommandLine(brokerPath, extensionDir = EXTENSION_DIR, nodePath = process.execPath, brokerCommand = "npx", brokerArgs = ["--no-install", "tsx"]) {
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return [quoteWindowsArg(nodePath), quoteWindowsArg(getTsxCliPath(extensionDir)), quoteWindowsArg(brokerPath)].join(" ");
  }
  return [quoteWindowsArg(brokerCommand), ...brokerArgs.map(quoteWindowsArg), quoteWindowsArg(brokerPath)].join(" ");
}
function getWindowsHiddenLauncherScript(commandLine) {
  return [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${commandLine.replace(/"/g, '""')}", 0, False`,
    "Set WshShell = Nothing",
    ""
  ].join("\r\n");
}
function isBrokerHealthOkMessage(message, requestId) {
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return false;
  }
  const response = message;
  return response.type === "health_ok" && response.requestId === requestId && response.protocol === INTERCOM_PROTOCOL_NAME && response.version === INTERCOM_PROTOCOL_VERSION;
}
function writeWindowsHiddenLauncher(commandLine, launcherPath = getWindowsHiddenLauncherPath()) {
  ensureIntercomRuntimeDir(dirname2(launcherPath));
  writeFileSync2(launcherPath, getWindowsHiddenLauncherScript(commandLine), {
    encoding: "utf-8",
    mode: INTERCOM_RUNTIME_FILE_MODE
  });
  restrictIntercomRuntimeFile(launcherPath);
  return launcherPath;
}
function getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs, extensionDir = EXTENSION_DIR, platform = process.platform, intercomDir = INTERCOM_DIR, nodePath = process.execPath) {
  if (platform === "win32") {
    const launcherPath = getWindowsHiddenLauncherPath(intercomDir);
    return {
      kind: "windows-launcher",
      command: "wscript.exe",
      args: [launcherPath],
      launcherPath,
      launcherCommandLine: getWindowsBrokerCommandLine(brokerPath, extensionDir, nodePath, brokerCommand, brokerArgs)
    };
  }
  if (usesDefaultBrokerCommand(brokerCommand, brokerArgs)) {
    return {
      kind: "direct",
      command: nodePath,
      args: [getTsxCliPath(extensionDir), brokerPath]
    };
  }
  return {
    kind: "direct",
    command: brokerCommand,
    args: [...brokerArgs, brokerPath]
  };
}
function getBrokerSpawnOptions(extensionDir = EXTENSION_DIR, env = process.env) {
  return {
    detached: true,
    stdio: "ignore",
    cwd: extensionDir,
    env: { ...env, PI_CODING_AGENT_DIR: getAgentDirPath(env), NODE_NO_WARNINGS: "1" },
    windowsHide: true
  };
}
function toError2(error2) {
  return error2 instanceof Error ? error2 : new Error(String(error2));
}
async function spawnBrokerIfNeeded(brokerCommand, brokerArgs) {
  ensureIntercomRuntimeDir(INTERCOM_DIR);
  if (await isBrokerRunning()) {
    return;
  }
  const ownsLock = acquireSpawnLock();
  if (!ownsLock) {
    await waitForBroker();
    return;
  }
  try {
    if (await isBrokerRunning()) {
      return;
    }
    if (await checkBrokerHealth() === "incompatible") {
      await stopBrokerProcess();
    }
    const brokerPath = getBrokerEntryPath();
    const launch = getBrokerLaunchSpec(brokerPath, brokerCommand, brokerArgs);
    if (launch.kind === "windows-launcher") {
      writeWindowsHiddenLauncher(launch.launcherCommandLine, launch.launcherPath);
    }
    const child = spawn(launch.command, launch.args, getBrokerSpawnOptions());
    child.unref();
    await new Promise((resolve3, reject) => {
      const cleanup = () => {
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onError = (error2) => {
        cleanup();
        reject(new Error(`Failed to spawn intercom broker: ${error2.message}`, { cause: error2 }));
      };
      const onExit = (code, signal) => {
        if (launch.kind === "windows-launcher" && code === 0 && signal === null) {
          return;
        }
        cleanup();
        if (signal) {
          reject(new Error(`Intercom broker exited before startup with signal ${signal}`));
          return;
        }
        reject(new Error(`Intercom broker exited before startup with code ${code ?? "unknown"}`));
      };
      child.once("error", onError);
      child.once("exit", onExit);
      waitForBroker().then(() => {
        cleanup();
        resolve3();
      }, (error2) => {
        cleanup();
        reject(toError2(error2));
      });
    });
  } finally {
    releaseSpawnLock();
  }
}
async function stopBrokerProcess(pidFile = BROKER_PID, timeoutMs = 3e3) {
  if (!existsSync2(pidFile)) return;
  let pid;
  try {
    pid = Number.parseInt(readFileSync3(pidFile, "utf-8").trim(), 10);
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
      await sleep(50);
    } catch {
      return;
    }
  }
  throw new Error(`Incompatible intercom broker ${pid} did not stop within ${timeoutMs}ms`);
}
async function isBrokerRunning() {
  if (await checkSocketConnectable()) {
    return true;
  }
  if (!existsSync2(BROKER_PID)) return false;
  try {
    const pid = parseInt(readFileSync3(BROKER_PID, "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return checkSocketConnectable();
  } catch {
    return false;
  }
}
function connectToBrokerTarget2(target) {
  return typeof target === "string" ? net2.connect(target) : net2.connect({ host: target.host, port: target.port });
}
async function checkSocketConnectable() {
  return await checkBrokerHealth() === "compatible";
}
function checkBrokerHealth() {
  return new Promise((resolve3) => {
    let target;
    try {
      target = getBrokerConnectTarget();
    } catch {
      resolve3("unreachable");
      return;
    }
    const socket = connectToBrokerTarget2(target);
    const requestId = randomUUID3();
    const expectedStateId = typeof target === "string" ? void 0 : target.stateId;
    let settled = false;
    const finish = (health) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("data", reader);
      socket.destroy();
      resolve3(health);
    };
    const onConnect = () => {
      try {
        writeMessage(socket, {
          type: "health",
          requestId,
          ...expectedStateId ? { stateId: expectedStateId } : {}
        });
      } catch {
        finish("unreachable");
      }
    };
    const onError = () => finish("unreachable");
    const reader = createMessageReader((message) => {
      if (isBrokerHealthOkMessage(message, requestId)) {
        finish("compatible");
        return;
      }
      if (typeof message === "object" && message !== null && "type" in message && message.type === "health_ok" && "requestId" in message && message.requestId === requestId) {
        finish("incompatible");
        return;
      }
      finish("unreachable");
    }, () => finish("unreachable"));
    socket.on("connect", onConnect);
    socket.on("error", onError);
    socket.on("data", reader);
    const timeout = setTimeout(() => finish("unreachable"), 1e3);
  });
}
function acquireSpawnLock() {
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      writeFileSync2(BROKER_SPAWN_LOCK, `${process.pid}
${Date.now()}
`, {
        flag: "wx",
        mode: INTERCOM_RUNTIME_FILE_MODE
      });
      restrictIntercomRuntimeFile(BROKER_SPAWN_LOCK);
      return true;
    } catch (error2) {
      if (!(error2 instanceof Error) || error2.code !== "EEXIST") {
        throw error2;
      }
      if (isSpawnLockStale()) {
        try {
          unlinkSync(BROKER_SPAWN_LOCK);
        } catch {
        }
        continue;
      }
      return false;
    }
  }
  return false;
}
function isSpawnLockStale() {
  if (!existsSync2(BROKER_SPAWN_LOCK)) {
    return false;
  }
  try {
    const [pidLine = "", createdAtLine = "0"] = readFileSync3(BROKER_SPAWN_LOCK, "utf-8").trim().split("\n");
    const pid = Number.parseInt(pidLine, 10);
    const createdAt = Number.parseInt(createdAtLine, 10);
    const ageMs = Date.now() - createdAt;
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
    }
    return !Number.isFinite(createdAt) || ageMs > 1e4;
  } catch {
    return true;
  }
}
function releaseSpawnLock() {
  try {
    unlinkSync(BROKER_SPAWN_LOCK);
  } catch {
  }
}
async function waitForBroker(timeoutMs = 5e3) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkSocketConnectable()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Broker failed to start within timeout");
}

// config.ts
import { existsSync as existsSync3, readFileSync as readFileSync4 } from "fs";
import { join as join4, resolve as resolve2 } from "path";
import { homedir as homedir2 } from "os";
var DEFAULT_ASK_TIMEOUT_MS = 45 * 1e3;
var MAX_ASK_TIMEOUT_MS = 120 * 1e3;
function validateAskTimeoutMs(value, name = "timeout_ms") {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  if (value > MAX_ASK_TIMEOUT_MS) {
    throw new Error(`${name} must be ${MAX_ASK_TIMEOUT_MS} ms or less; use intercom_send plus intercom_pending for longer-running work`);
  }
  return value;
}
function getAskTimeoutMs() {
  const raw = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  if (raw === void 0 || raw.trim() === "") {
    return DEFAULT_ASK_TIMEOUT_MS;
  }
  const value = Number(raw);
  return validateAskTimeoutMs(value, "PI_INTERCOM_ASK_TIMEOUT_MS");
}
function getConfigPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR ? resolve2(process.env.PI_CODING_AGENT_DIR) : join4(homedir2(), ".pi", "agent");
  return join4(agentDir, "intercom", "config.json");
}
var defaults = {
  brokerCommand: "npx",
  brokerArgs: ["--no-install", "tsx"],
  confirmSend: false,
  enabled: true,
  replyHint: true,
  inboundForkHandlers: {
    enabled: true,
    when: "auto",
    notify: "summary",
    triggerParentOnSummary: "auto"
  }
};
function loadConfig() {
  const configPath = getConfigPath();
  if (!existsSync3(configPath)) {
    return { ...defaults };
  }
  try {
    const raw = readFileSync4(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }
    const parsedConfig = parsed;
    const config = { ...defaults };
    if (Object.hasOwn(parsedConfig, "brokerCommand")) {
      if (typeof parsedConfig.brokerCommand !== "string") {
        throw new Error(`"brokerCommand" must be a string`);
      }
      const brokerCommand = parsedConfig.brokerCommand.trim();
      if (!brokerCommand) {
        throw new Error(`"brokerCommand" must not be empty`);
      }
      config.brokerCommand = brokerCommand;
    }
    if (Object.hasOwn(parsedConfig, "brokerArgs")) {
      if (!Array.isArray(parsedConfig.brokerArgs)) {
        throw new Error(`"brokerArgs" must be an array`);
      }
      const brokerArgs = [];
      for (const arg of parsedConfig.brokerArgs) {
        if (typeof arg !== "string") {
          throw new Error(`"brokerArgs" items must be strings`);
        }
        brokerArgs.push(arg);
      }
      config.brokerArgs = brokerArgs;
    }
    if (Object.hasOwn(parsedConfig, "confirmSend")) {
      if (typeof parsedConfig.confirmSend !== "boolean") {
        throw new Error(`"confirmSend" must be a boolean`);
      }
      config.confirmSend = parsedConfig.confirmSend;
    }
    if (Object.hasOwn(parsedConfig, "enabled")) {
      if (typeof parsedConfig.enabled !== "boolean") {
        throw new Error(`"enabled" must be a boolean`);
      }
      config.enabled = parsedConfig.enabled;
    }
    if (Object.hasOwn(parsedConfig, "replyHint")) {
      if (typeof parsedConfig.replyHint !== "boolean") {
        throw new Error(`"replyHint" must be a boolean`);
      }
      config.replyHint = parsedConfig.replyHint;
    }
    if (Object.hasOwn(parsedConfig, "status")) {
      if (typeof parsedConfig.status !== "string") {
        throw new Error(`"status" must be a string`);
      }
      config.status = parsedConfig.status;
    }
    if (Object.hasOwn(parsedConfig, "inboundForkHandlers")) {
      if (typeof parsedConfig.inboundForkHandlers !== "object" || parsedConfig.inboundForkHandlers === null || Array.isArray(parsedConfig.inboundForkHandlers)) {
        throw new Error(`"inboundForkHandlers" must be an object`);
      }
      const forkConfig = parsedConfig.inboundForkHandlers;
      config.inboundForkHandlers = { ...defaults.inboundForkHandlers };
      if (Object.hasOwn(forkConfig, "enabled")) {
        if (typeof forkConfig.enabled !== "boolean") throw new Error(`"inboundForkHandlers.enabled" must be a boolean`);
        config.inboundForkHandlers.enabled = forkConfig.enabled;
      }
      if (Object.hasOwn(forkConfig, "when")) {
        if (forkConfig.when !== "auto" && forkConfig.when !== "busy" && forkConfig.when !== "always") throw new Error(`"inboundForkHandlers.when" must be "auto", "busy", or "always"`);
        config.inboundForkHandlers.when = forkConfig.when;
      }
      if (Object.hasOwn(forkConfig, "notify")) {
        if (forkConfig.notify !== "ack-and-summary" && forkConfig.notify !== "summary" && forkConfig.notify !== "none") throw new Error(`"inboundForkHandlers.notify" must be "ack-and-summary", "summary", or "none"`);
        config.inboundForkHandlers.notify = forkConfig.notify;
      }
      if (Object.hasOwn(forkConfig, "piCommand")) {
        if (typeof forkConfig.piCommand !== "string") throw new Error(`"inboundForkHandlers.piCommand" must be a string`);
        const piCommand = forkConfig.piCommand.trim();
        if (piCommand) config.inboundForkHandlers.piCommand = piCommand;
      }
      if (Object.hasOwn(forkConfig, "triggerParentOnSummary")) {
        const triggerParentOnSummary = forkConfig.triggerParentOnSummary;
        if (typeof triggerParentOnSummary !== "boolean" && triggerParentOnSummary !== "auto") {
          throw new Error(`"inboundForkHandlers.triggerParentOnSummary" must be a boolean or "auto"`);
        }
        config.inboundForkHandlers.triggerParentOnSummary = triggerParentOnSummary;
      }
    }
    return config;
  } catch (error2) {
    console.error(`Failed to load intercom config at ${configPath}:`, error2);
    return { ...defaults };
  }
}

// codex/team.ts
import { readFile } from "node:fs/promises";
import { join as join5 } from "node:path";
var LIVE_STATES = /* @__PURE__ */ new Set(["provisioning", "running", "idle", "needs_attention", "stopping"]);
var stringValue = (value) => typeof value === "string" && value.trim() ? value.trim() : void 0;
var connectedTo = (sessions, target) => {
  const normalized = target.toLowerCase();
  return sessions.some((session) => session.id === target || session.name?.toLowerCase() === normalized);
};
async function readWorkers(agentDir) {
  try {
    const parsed = JSON.parse(await readFile(join5(agentDir, "intercom", "orchestrator", "workers.json"), "utf8"));
    return Array.isArray(parsed.workers) ? parsed.workers : [];
  } catch {
    return [];
  }
}
async function resolveIntercomTeam(input) {
  const env = input.env ?? process.env;
  const workers = await readWorkers(input.agentDir ?? getAgentDirPath());
  const workerId = stringValue(env.AGENT_INTERCOM_WORKER_ID);
  const runId = stringValue(env.AGENT_INTERCOM_RUN_ID);
  const current = workerId ? workers.find((worker) => stringValue(worker.id) === workerId && (!runId || stringValue(worker.runId) === runId)) : void 0;
  const managerTarget = stringValue(current?.managerSessionId) ?? stringValue(env.AGENT_INTERCOM_MANAGER_TARGET) ?? stringValue(env.AGENT_INTERCOM_MANAGER_SESSION_ID);
  const teamId = managerTarget ?? input.selfId;
  const coworkers = workers.filter((worker) => worker.owned === true).filter((worker) => stringValue(worker.managerSessionId) === teamId).filter((worker) => LIVE_STATES.has(stringValue(worker.state) ?? "")).filter((worker) => stringValue(worker.id) !== workerId).map((worker) => {
    const id = stringValue(worker.id);
    if (!id) return void 0;
    const target = stringValue(worker.intercomTarget) ?? id;
    return { id, target, ...stringValue(worker.harness) ? { harness: stringValue(worker.harness) } : {}, ...stringValue(worker.role) ? { role: stringValue(worker.role) } : {}, ...stringValue(worker.state) ? { state: stringValue(worker.state) } : {}, connected: connectedTo(input.sessions, target) };
  }).filter((member) => Boolean(member));
  return { teamId, self: { id: input.selfId, ...workerId ? { workerId } : {}, isManager: !managerTarget }, manager: managerTarget ? { target: managerTarget, connected: connectedTo(input.sessions, managerTarget) } : { target: input.selfId, connected: true }, coworkers };
}
function formatIntercomTeam(team) {
  const lines = [`Manager: ${team.manager ? `${team.manager.target} [${team.manager.connected ? "connected" : "not connected"}]` : "unknown"}`, `You: ${team.self.workerId ?? team.self.id}${team.self.isManager ? " [manager]" : ""}`];
  if (!team.coworkers.length) lines.push("Coworkers: none");
  else {
    lines.push("Coworkers:");
    for (const coworker of team.coworkers) {
      const metadata = [coworker.harness, coworker.role, coworker.state].filter(Boolean).join(", ");
      lines.push(`- ${coworker.id} target=${coworker.target}${metadata ? ` (${metadata})` : ""} [${coworker.connected ? "connected" : "not connected"}]`);
    }
  }
  return lines.join("\n");
}

// codex/runtime.ts
function matchesPendingSender(entry, to) {
  return entry.from.id === to || entry.from.name?.toLowerCase() === to.toLowerCase() || entry.from.id.startsWith(to);
}
function selectPendingAsk(entries, to, which) {
  const sorted = [...entries].sort((a, b) => a.receivedAt - b.receivedAt);
  if (sorted.length === 0) throw new Error("No matching pending ask. Call intercom_pending to inspect unresolved asks.");
  const matches = to ? sorted.filter((entry) => matchesPendingSender(entry, to)) : sorted;
  if (matches.length === 0) throw new Error(`No pending ask from "${to}".`);
  if (matches.length === 1) return matches[0];
  if (!to && new Set(matches.map((entry) => entry.from.id)).size > 1) {
    throw new Error("Multiple pending asks \u2014 specify `to` using a sender from intercom_pending.");
  }
  if (!which) {
    const sender = to ? ` from "${to}"` : "";
    throw new Error(`Multiple pending asks${sender} \u2014 specify \`which\` as \`oldest\` or \`latest\`.`);
  }
  return which === "oldest" ? matches[0] : matches[matches.length - 1];
}
function pendingSelector(entries, entry) {
  const sameSender = entries.filter((candidate) => candidate.from.id === entry.from.id);
  if (sameSender.length <= 1) return void 0;
  const index = sameSender.findIndex((candidate) => candidate.message.id === entry.message.id);
  if (index === 0) return "oldest";
  if (index === sameSender.length - 1) return "latest";
  return "queued";
}
function publicPendingEntry(entry, selector) {
  return {
    from: { id: entry.from.id, name: entry.from.name },
    received_at: entry.receivedAt,
    read: entry.read,
    text: entry.message.content.text,
    attachments: entry.message.content.attachments,
    expects_reply: entry.message.expectsReply,
    ...selector ? { selector } : {}
  };
}
function shortHash(value) {
  return createHash2("sha256").update(value).digest("hex").slice(0, 8);
}
function buildCodexRuntimeIdentity(env = process.env, cwd = env.PWD || processCwd(), pid = process.pid) {
  const sessionId = env.CODEX_INTERCOM_SESSION_ID?.trim() || env.CODEX_PEER_ID?.trim() || `codex-${pid}-${shortHash(cwd)}`;
  const cwdName = basename(cwd) || "workspace";
  const name = env.CODEX_INTERCOM_NAME?.trim() || env.CODEX_PEER_NAME?.trim() || `codex-${cwdName}-${pid}`;
  return {
    sessionId,
    name,
    cwd,
    model: env.CODEX_INTERCOM_MODEL?.trim() || env.CODEX_MODEL?.trim() || "codex",
    startedAt: Date.now()
  };
}
function formatAttachments(attachments) {
  if (!attachments?.length) return "";
  return attachments.map((attachment) => {
    if (attachment.language) {
      return `

---
Attachment: ${attachment.name}
~~~${attachment.language}
${attachment.content}
~~~`;
    }
    return `

---
Attachment: ${attachment.name}
${attachment.content}`;
  }).join("");
}
function resolveSessionTarget(sessions, nameOrId) {
  const byId = sessions.find((session) => session.id === nameOrId);
  if (byId) return byId.id;
  const lowerName = nameOrId.toLowerCase();
  const byName = sessions.filter((session) => session.name?.toLowerCase() === lowerName);
  if (byName.length > 1) {
    throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
  }
  if (byName[0]) return byName[0].id;
  if (nameOrId.length >= 4) {
    const byPrefix = sessions.filter((session) => session.id.startsWith(nameOrId));
    if (byPrefix.length > 1) {
      throw new Error(`Multiple sessions match the ID prefix "${nameOrId}". Use the full session ID or a unique name.`);
    }
    if (byPrefix[0]) return byPrefix[0].id;
  }
  return null;
}
function formatSessionList(sessions, currentSessionId, currentCwd) {
  if (!sessions.length) return "No intercom sessions connected.";
  return sessions.map((session) => {
    const tags = [
      session.id === currentSessionId ? "self" : void 0,
      session.cwd === currentCwd ? "same cwd" : void 0,
      session.status
    ].filter((tag) => Boolean(tag));
    const suffix = tags.length ? ` [${tags.join(", ")}]` : "";
    return `- ${session.name || "unnamed"} (${session.id.slice(0, 8)}) - ${session.cwd} (${session.model})${suffix}`;
  }).join("\n");
}
function detectGitRoot(cwd) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}
function textResult(text, structuredContent, isError = false) {
  return {
    content: [{ type: "text", text }],
    ...structuredContent ? { structuredContent } : {},
    ...isError ? { isError: true } : {}
  };
}
var CodexIntercomRuntime = class {
  client = null;
  connectPromise = null;
  reconnectTimer = null;
  reconnectAttempt = 0;
  reconnectEnabled = true;
  identity;
  unread = [];
  unresolvedAsks = /* @__PURE__ */ new Map();
  replyWaiters = /* @__PURE__ */ new Map();
  clientFactory;
  prepareConnection;
  reconnectDelays;
  constructor(identity = buildCodexRuntimeIdentity(), options = {}) {
    this.identity = identity;
    this.clientFactory = options.clientFactory ?? (() => new IntercomClient());
    this.prepareConnection = options.prepareConnection ?? (async () => {
      const config = loadConfig();
      if (!config.enabled) throw new Error("Intercom disabled");
      await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
    });
    this.reconnectDelays = options.reconnectDelays?.length ? options.reconnectDelays : [250, 500, 1e3, 2e3, 5e3];
  }
  getIdentity() {
    return this.identity;
  }
  async connect() {
    this.reconnectEnabled = true;
    this.clearReconnectTimer();
    if (this.client?.isConnected()) return this.client;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectOnce();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }
  async connectOnce() {
    await this.prepareConnection();
    const client = this.clientFactory();
    client.on("message", (from, message, deliveryId) => {
      this.handleIncomingMessage(from, message);
      client.acknowledgeMessage(deliveryId);
    });
    client.on("disconnected", (error2) => {
      for (const waiter of this.replyWaiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.reject(new Error(`Disconnected while waiting for reply: ${error2.message}`, { cause: error2 }));
      }
      this.replyWaiters.clear();
      if (this.client === client) this.client = null;
      this.scheduleReconnect();
    });
    await client.connect({
      name: this.identity.name,
      cwd: this.identity.cwd,
      model: this.identity.model,
      pid: process.pid,
      startedAt: this.identity.startedAt,
      lastActivity: Date.now(),
      status: "idle"
    }, this.identity.sessionId);
    this.client = client;
    this.reconnectAttempt = 0;
    return client;
  }
  scheduleReconnect() {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    const delay = this.reconnectDelays[Math.min(this.reconnectAttempt, this.reconnectDelays.length - 1)];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().then((client) => {
        if (!client.isConnected()) {
          this.reconnectAttempt += 1;
          this.scheduleReconnect();
        }
      }).catch(() => {
        this.reconnectAttempt += 1;
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }
  clearReconnectTimer() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  async disconnect() {
    this.reconnectEnabled = false;
    this.clearReconnectTimer();
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
      }
    }
    const client = this.client;
    this.client = null;
    if (client) await client.disconnect();
  }
  handleIncomingMessage(from, message) {
    const waiter = this.replyWaiters.get(message.replyTo ?? "");
    if (waiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === waiter.from.toLowerCase() || from.id === waiter.from;
      if (fromMatches) {
        this.replyWaiters.delete(waiter.replyTo);
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.resolve(message);
        return;
      }
    }
    const entry = { from, message, receivedAt: Date.now(), read: false };
    this.unread.push(entry);
    if (message.expectsReply) {
      this.unresolvedAsks.set(message.id, entry);
    }
  }
  waitForReply(from, replyTo, timeoutMs = getAskTimeoutMs(), signal) {
    return new Promise((resolve3, reject) => {
      if (signal?.aborted) {
        reject(new Error("intercom_ask cancelled"));
        return;
      }
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        this.replyWaiters.delete(replyTo);
        cleanup();
        void this.client?.cancelAsk(replyTo);
        reject(new Error("intercom_ask cancelled"));
      };
      timeout = setTimeout(() => {
        this.replyWaiters.delete(replyTo);
        void this.client?.deferAsk(replyTo);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`No reply from "${from}" within ${Math.round(timeoutMs / 1e3)} seconds`));
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.replyWaiters.set(replyTo, { from, replyTo, resolve: resolve3, reject, timeout, cleanup });
    });
  }
  async resolveTarget(to) {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return resolveSessionTarget(sessions, to) ?? to;
  }
  async whoami() {
    const client = await this.connect();
    const sessionId = client.sessionId ?? this.identity.sessionId;
    return textResult(
      `session_id: ${sessionId}
name: ${this.identity.name}
cwd: ${this.identity.cwd}`,
      { session_id: sessionId, name: this.identity.name, cwd: this.identity.cwd, model: this.identity.model }
    );
  }
  async team() {
    const client = await this.connect();
    const sessions = await client.listSessions();
    const team = await resolveIntercomTeam({ selfId: client.sessionId ?? this.identity.sessionId, sessions });
    return textResult(formatIntercomTeam(team), team);
  }
  async status() {
    const client = await this.connect();
    const sessions = await client.listSessions();
    return textResult(
      `Connected: ${client.isConnected() ? "Yes" : "No"}
Session ID: ${client.sessionId ?? "unknown"}
Active sessions: ${sessions.length}
Unread messages: ${this.unread.filter((entry) => !entry.read).length}
Pending asks: ${this.unresolvedAsks.size}`,
      {
        connected: client.isConnected(),
        session_id: client.sessionId,
        active_sessions: sessions.length,
        unread_messages: this.unread.filter((entry) => !entry.read).length,
        pending_asks: this.unresolvedAsks.size
      }
    );
  }
  async list(scope = "machine", includeSelf = false) {
    const client = await this.connect();
    let sessions = await client.listSessions();
    if (scope === "directory") {
      sessions = sessions.filter((session) => session.cwd === this.identity.cwd);
    } else if (scope === "repo") {
      const currentRoot = detectGitRoot(this.identity.cwd);
      sessions = currentRoot ? sessions.filter((session) => detectGitRoot(session.cwd) === currentRoot) : [];
    }
    if (!includeSelf) {
      sessions = sessions.filter((session) => session.id !== client.sessionId);
    }
    return textResult(formatSessionList(sessions, client.sessionId, this.identity.cwd), { sessions });
  }
  async setSummary(summary) {
    const client = await this.connect();
    client.updatePresence({ status: summary.trim() || "idle" });
    return textResult("Summary updated.", { ok: true, summary });
  }
  async send(to, message, attachments, replyTo) {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const result = await client.send(sendTo, { text: message, attachments, replyTo });
    if (!result.delivered) {
      return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
    }
    if (replyTo) this.unresolvedAsks.delete(replyTo);
    return textResult(`Message sent to ${to}.`, { ok: true, message_id: result.id, to });
  }
  async ask(to, message, attachments, timeoutMs = getAskTimeoutMs(), signal) {
    const client = await this.connect();
    const sendTo = await this.resolveTarget(to);
    const questionId = randomUUID4();
    const replyPromise = this.waitForReply(sendTo, questionId, timeoutMs, signal);
    void replyPromise.catch(() => void 0);
    try {
      const result = await client.send(sendTo, {
        messageId: questionId,
        text: message,
        attachments,
        expectsReply: true
      });
      if (!result.delivered) {
        this.replyWaiters.get(questionId)?.reject(new Error(result.reason ?? "Session may not exist or has disconnected."));
        this.replyWaiters.delete(questionId);
        client.cancelAsk(questionId);
        return textResult(`Message to "${to}" was not delivered: ${result.reason ?? "Session may not exist or has disconnected."}`, { ok: false, message_id: result.id, reason: result.reason }, true);
      }
      const reply = await replyPromise;
      const replyText = `${reply.content.text}${formatAttachments(reply.content.attachments)}`;
      return textResult(`Reply from ${to}:
${replyText}`, { ok: true, message_id: result.id, reply });
    } catch (error2) {
      client.cancelAsk(questionId);
      return textResult(error2 instanceof Error ? error2.message : String(error2), { ok: false }, true);
    }
  }
  async pending(markRead = false) {
    const unreadMessages = this.unread.filter((entry) => !entry.read);
    if (markRead) {
      for (const entry of unreadMessages) entry.read = true;
    }
    const pendingAsks = Array.from(this.unresolvedAsks.values()).sort((a, b) => a.receivedAt - b.receivedAt);
    const lines = [
      unreadMessages.length ? unreadMessages.map((entry) => `- ${entry.from.name || entry.from.id}: ${entry.message.content.text}${formatAttachments(entry.message.content.attachments)}`).join("\n") : "No unread messages.",
      pendingAsks.length ? `
Pending asks:
${pendingAsks.map((entry) => {
        const selector = pendingSelector(pendingAsks, entry);
        return `- ${entry.from.name || entry.from.id}${selector ? ` [${selector}]` : ""}: ${entry.message.content.text}`;
      }).join("\n")}` : ""
    ].filter(Boolean);
    return textResult(lines.join("\n"), {
      unread_messages: unreadMessages.map((entry) => publicPendingEntry(entry)),
      pending_asks: pendingAsks.map((entry) => publicPendingEntry(entry, pendingSelector(pendingAsks, entry)))
    });
  }
  async reply(message, to, which) {
    let target;
    try {
      target = selectPendingAsk(Array.from(this.unresolvedAsks.values()), to, which);
    } catch (error2) {
      return textResult(error2 instanceof Error ? error2.message : String(error2), { ok: false }, true);
    }
    const result = await this.send(target.from.id, message, void 0, target.message.id);
    if (!result.isError) {
      this.unresolvedAsks.delete(target.message.id);
    }
    return result;
  }
};

// codex/mcp-protocol.ts
var inflightToolCalls = /* @__PURE__ */ new Map();
function asString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}
function asBoolean(value, defaultValue) {
  return typeof value === "boolean" ? value : defaultValue;
}
function asOptionalPositiveInteger(value, name) {
  if (value === void 0) return void 0;
  return validateAskTimeoutMs(value, name);
}
function asAttachmentArray(value) {
  if (value === void 0) return void 0;
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`attachments[${index}] must be an object`);
    const raw = item;
    const type = raw.type;
    if (type !== "file" && type !== "snippet" && type !== "context") throw new Error(`attachments[${index}].type must be file, snippet, or context`);
    const name = asString(raw.name, `attachments[${index}].name`);
    const content = asString(raw.content, `attachments[${index}].content`);
    if (raw.language !== void 0 && typeof raw.language !== "string") throw new Error(`attachments[${index}].language must be a string`);
    const language = typeof raw.language === "string" ? raw.language : void 0;
    return { type, name, content, ...language ? { language } : {} };
  });
}
var attachmentsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["file", "snippet", "context"] },
      name: { type: "string" },
      content: { type: "string" },
      language: { type: "string" }
    },
    required: ["type", "name", "content"],
    additionalProperties: false
  }
};
function buildToolDefinitions(runtime2) {
  return [
    {
      name: "intercom_whoami",
      description: "Return this Codex session's intercom identity for reliable targeting.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => runtime2.whoami()
    },
    {
      name: "intercom_team",
      description: "Show your current manager and the live coworkers owned by that manager. No arguments are required.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => runtime2.team()
    },
    {
      name: "intercom_status",
      description: "Show intercom connection status, active sessions, unread messages, and pending asks.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => runtime2.status()
    },
    {
      name: "intercom_list",
      description: "List intercom-connected Pi or Codex sessions on this machine.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["machine", "directory", "repo"], default: "machine" },
          include_self: { type: "boolean", default: false }
        },
        additionalProperties: false
      },
      handler: async (args) => runtime2.list(
        args.scope === "directory" || args.scope === "repo" ? args.scope : "machine",
        asBoolean(args.include_self, false)
      )
    },
    {
      name: "intercom_set_summary",
      description: "Publish a short status summary so other sessions can discover what this Codex session is doing.",
      inputSchema: {
        type: "object",
        properties: { summary: { type: "string", maxLength: 400 } },
        required: ["summary"],
        additionalProperties: false
      },
      handler: async (args) => runtime2.setSummary(asString(args.summary, "summary"))
    },
    {
      name: "intercom_send",
      description: "Send a non-blocking direct message to another intercom session by name, full ID, or unique ID prefix.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          message: { type: "string" },
          attachments: attachmentsSchema
        },
        required: ["to", "message"],
        additionalProperties: false
      },
      handler: async (args) => runtime2.send(asString(args.to, "to"), asString(args.message, "message"), asAttachmentArray(args.attachments))
    },
    {
      name: "intercom_ask",
      description: "Ask another intercom session a question only when the next step depends on its reply. Use intercom_send for assignments, progress/status checkpoints, and notifications.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          message: { type: "string" },
          attachments: attachmentsSchema,
          timeout_ms: { type: "integer", minimum: 1, maximum: 12e4, description: "Maximum time to wait for a reply before returning an error. Use intercom_send plus intercom_pending for longer work." }
        },
        required: ["to", "message"],
        additionalProperties: false
      },
      handler: async (args, signal) => runtime2.ask(
        asString(args.to, "to"),
        asString(args.message, "message"),
        asAttachmentArray(args.attachments),
        asOptionalPositiveInteger(args.timeout_ms, "timeout_ms"),
        signal
      )
    },
    {
      name: "intercom_pending",
      description: "Read unread inbound messages and unresolved asks for this Codex session.",
      inputSchema: {
        type: "object",
        properties: { mark_read: { type: "boolean", default: false } },
        additionalProperties: false
      },
      handler: async (args) => runtime2.pending(asBoolean(args.mark_read, false))
    },
    {
      name: "intercom_reply",
      description: "Reply to a pending inbound ask. Use to plus which=oldest/latest when one sender has multiple unresolved asks.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
          to: { type: "string", description: "Optional sender/session selector; never a message or thread ID." },
          which: { type: "string", enum: ["oldest", "latest"], description: "Select the oldest or latest ask from the chosen sender." }
        },
        required: ["message"],
        additionalProperties: false
      },
      handler: async (args) => runtime2.reply(asString(args.message, "message"), typeof args.to === "string" ? args.to : void 0, args.which === "oldest" || args.which === "latest" ? args.which : void 0)
    }
  ];
}
function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function error(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
async function handleMcpRequest(request, runtime2) {
  if (!request.method) {
    return error(request.id, -32600, "Invalid request");
  }
  if (request.method === "notifications/cancelled") {
    const requestId = request.params?.requestId;
    if (typeof requestId === "string" || typeof requestId === "number") {
      inflightToolCalls.get(requestId)?.abort();
    }
    return void 0;
  }
  if (request.id === void 0 && request.method.startsWith("notifications/")) {
    return void 0;
  }
  const tools = buildToolDefinitions(runtime2);
  switch (request.method) {
    case "initialize":
      return ok(request.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "codex-intercom", version: "0.1.0" }
      });
    case "ping":
      return ok(request.id, {});
    case "tools/list":
      return ok(request.id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
      });
    case "tools/call": {
      const name = request.params?.name;
      const args = request.params?.arguments;
      if (typeof name !== "string") return error(request.id, -32602, "tools/call requires params.name");
      if (args !== void 0 && (!args || typeof args !== "object" || Array.isArray(args))) {
        return error(request.id, -32602, "tools/call params.arguments must be an object");
      }
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) return error(request.id, -32602, `Unknown tool: ${name}`);
      const requestId = request.id;
      const abortController = typeof requestId === "string" || typeof requestId === "number" ? new AbortController() : null;
      if (abortController && requestId !== void 0) inflightToolCalls.set(requestId, abortController);
      try {
        return ok(request.id, await tool.handler(args ?? {}, abortController?.signal));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return ok(request.id, { content: [{ type: "text", text: message }], isError: true });
      } finally {
        if (abortController && requestId !== void 0) inflightToolCalls.delete(requestId);
      }
    }
    default:
      return error(request.id, -32601, `Method not found: ${request.method}`);
  }
}

// codex/server.ts
var runtime = new CodexIntercomRuntime();
var rl = readline.createInterface({
  input: stdin,
  crlfDelay: Infinity
});
var shuttingDown = false;
var pendingRequests = 0;
function writeResponse(response) {
  if (!response) return;
  stdout.write(`${JSON.stringify(response)}
`);
}
function maybeShutdown() {
  if (!shuttingDown || pendingRequests > 0) return;
  void runtime.disconnect().finally(() => process.exit(0));
}
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  pendingRequests += 1;
  void (async () => {
    try {
      const request = JSON.parse(trimmed);
      writeResponse(await handleMcpRequest(request, runtime));
    } catch (error2) {
      writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error2 instanceof Error ? error2.message : String(error2)
        }
      });
    }
  })().finally(() => {
    pendingRequests -= 1;
    maybeShutdown();
  });
});
var shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  rl.close();
  maybeShutdown();
};
rl.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("disconnect", shutdown);
