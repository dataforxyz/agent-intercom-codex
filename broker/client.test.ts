import test from "node:test";
import assert from "node:assert/strict";
import { IntercomClient } from "./client.ts";
import { INTERCOM_PROTOCOL_NAME, INTERCOM_PROTOCOL_VERSION } from "./paths.ts";

function decodeWrittenFrame(frame: Buffer): Record<string, unknown> {
  const length = frame.readUInt32BE(0);
  return JSON.parse(frame.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>;
}

test("cancelAsk ignores synchronous socket write failures", () => {
  const client = new IntercomClient();
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write() {
      throw new Error("write failed");
    },
  };

  assert.doesNotThrow(() => client.cancelAsk("ask-1"));
});

test("cancelAsk sends the protocol-v2 request id", () => {
  const client = new IntercomClient();
  let written: Record<string, unknown> | undefined;
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write(frame: Buffer) {
      written = decodeWrittenFrame(frame);
      return true;
    },
  };

  client.cancelAsk("ask-1");
  assert.equal(written?.type, "cancel_ask");
  assert.equal(written?.messageId, "ask-1");
  assert.equal(typeof written?.requestId, "string");
});

test("registration errors preserve the broker's protocol mismatch message", () => {
  const client = new IntercomClient();
  let received: (Error & { code?: string }) | undefined;
  client.once("_registration_error", (error) => {
    received = error;
  });

  (client as any).handleBrokerMessage({
    type: "error",
    code: "PROTOCOL_MISMATCH",
    error: "Unsupported intercom protocol",
  });

  assert.equal(received?.message, "Unsupported intercom protocol");
  assert.equal(received?.code, "PROTOCOL_MISMATCH");
});

test("registered messages accept protocol v2 and legacy brokers", () => {
  const v2 = new IntercomClient();
  (v2 as any).handleBrokerMessage({
    type: "registered",
    sessionId: "v2-session",
    protocol: INTERCOM_PROTOCOL_NAME,
    version: INTERCOM_PROTOCOL_VERSION,
  });
  assert.equal(v2.sessionId, "v2-session");

  const legacy = new IntercomClient();
  (legacy as any).handleBrokerMessage({ type: "registered", sessionId: "legacy-session" });
  assert.equal(legacy.sessionId, "legacy-session");
});

test("protocol-v2 inbound messages are acknowledged", () => {
  const client = new IntercomClient();
  let written: Record<string, unknown> | undefined;
  let receivedText = "";
  (client as any)._sessionId = "session-1";
  (client as any).socket = {
    destroyed: false,
    writableEnded: false,
    writable: true,
    write(frame: Buffer) {
      written = decodeWrittenFrame(frame);
      return true;
    },
  };
  client.on("message", (_from, message) => {
    receivedText = message.content.text;
  });

  (client as any).handleBrokerMessage({
    type: "message",
    deliveryId: "delivery-1",
    from: {
      id: "sender",
      name: "sender",
      cwd: "/tmp",
      model: "pi",
      pid: 1,
      startedAt: 1,
      lastActivity: 1,
    },
    message: {
      id: "message-1",
      timestamp: 1,
      content: { text: "hello" },
    },
  });

  assert.equal(receivedText, "hello");
  assert.deepEqual(written, { type: "message_received", deliveryId: "delivery-1" });
});
