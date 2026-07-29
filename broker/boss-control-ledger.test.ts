import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BossControlResultLedger,
  bossControlAcceptedRecoveryFrames,
  bossControlReplayFrames,
  parseBossControlAck,
  parseBossControlResult,
  rebindBossControlResult,
} from "./boss-control-ledger.ts";

const scope = "a".repeat(64);
const fingerprint = "b".repeat(64);
const delivered = {
  type: "boss_control_result" as const,
  requestId: "request-1",
  messageId: "request-1",
  idempotencyKey: "operation-1",
  status: "delivered" as const,
  delivered: true as const,
  deliveryId: "delivery-1",
};

test("Boss ledger durably persists accepted before terminal and rebinds replay to a new caller message", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-control-ledger-"));
  try {
    const path = join(dir, "ledger.json");
    const ledger = new BossControlResultLedger(path, () => 100);
    assert.throws(() => ledger.recordTerminal(scope, fingerprint, delivered), /requires the matching durable accepted state/);
    ledger.recordAccepted(scope, fingerprint, "delivery-1");
    assert.deepEqual(new BossControlResultLedger(path, () => 150).lookup(scope, fingerprint), {
      status: "accepted",
      deliveryId: "delivery-1",
    });
    ledger.recordTerminal(scope, fingerprint, delivered);
    const reloaded = new BossControlResultLedger(path, () => 200);
    const replay = reloaded.lookup(scope, fingerprint);
    assert.equal(replay.status, "replay");
    if (replay.status === "replay") {
      assert.deepEqual(rebindBossControlResult(replay.result, "request-2"), {
        ...delivered,
        requestId: "request-2",
        messageId: "request-2",
      });
      const frames = bossControlReplayFrames(replay.result, "request-2");
      assert.deepEqual(frames.map((frame) => frame.type), ["boss_control_ack", "boss_control_result"]);
      assert.equal(frames[0].deliveryId, "delivery-1");
      assert.equal(frames[1].messageId, "request-2");
    }
    assert.deepEqual(reloaded.lookup(scope, "c".repeat(64)), { status: "conflict" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Boss result-order probes reject mismatched delivery and post-accept failures without deliveryId", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-control-order-"));
  try {
    const ledger = new BossControlResultLedger(join(dir, "ledger.json"), () => 100);
    ledger.recordAccepted(scope, fingerprint, "delivery-1");
    assert.throws(() => ledger.recordTerminal(scope, fingerprint, { ...delivered, deliveryId: "delivery-2" }), /matching durable accepted state/);
    assert.throws(() => ledger.recordTerminal(scope, fingerprint, {
      type: "boss_control_result",
      requestId: "request-1",
      messageId: "request-1",
      idempotencyKey: "operation-1",
      status: "rejected",
      delivered: false,
      code: "DELIVERY_TIMEOUT",
      reason: "timeout",
    }), /must carry the accepted deliveryId/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Boss accepted and terminal bindings survive more than ten minutes offline and broker restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-control-retention-"));
  try {
    const path = join(dir, "ledger.json");
    new BossControlResultLedger(path, () => 100).recordAccepted(scope, fingerprint, "delivery-1");

    const afterAcceptedOffline = new BossControlResultLedger(path, () => 100 + 11 * 60 * 1000);
    assert.deepEqual(afterAcceptedOffline.lookup(scope, fingerprint), {
      status: "accepted",
      deliveryId: "delivery-1",
    });
    afterAcceptedOffline.recordTerminal(scope, fingerprint, delivered);

    const afterTerminalOffline = new BossControlResultLedger(path, () => 100 + 22 * 60 * 1000);
    assert.equal(afterTerminalOffline.lookup(scope, fingerprint).status, "replay");
    assert.deepEqual(afterTerminalOffline.lookup(scope, "c".repeat(64)), { status: "conflict" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expired version-2 Boss records migrate without pruning", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-control-migrate-"));
  try {
    const path = join(dir, "ledger.json");
    const acceptedScope = "d".repeat(64);
    writeFileSync(path, JSON.stringify({
      version: 2,
      entries: [
        {
          scope,
          fingerprint,
          expiresAt: 200,
          state: "terminal",
          result: delivered,
        },
        {
          scope: acceptedScope,
          fingerprint,
          expiresAt: 200,
          state: "accepted",
          deliveryId: "delivery-2",
        },
      ],
    }));

    const migrated = new BossControlResultLedger(path, () => 100 + 11 * 60 * 1000);
    assert.equal(migrated.lookup(scope, fingerprint).status, "replay");
    assert.deepEqual(migrated.lookup(acceptedScope, fingerprint), {
      status: "accepted",
      deliveryId: "delivery-2",
    });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      version: 3,
      entries: [
        { scope, fingerprint, state: "terminal", result: delivered },
        { scope: acceptedScope, fingerprint, state: "accepted", deliveryId: "delivery-2" },
      ],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepted recovery denial emits the stable ACK before its terminal result", () => {
  const result = {
    type: "boss_control_result" as const,
    requestId: "request-2",
    messageId: "request-2",
    idempotencyKey: "operation-1",
    status: "rejected" as const,
    delivered: false as const,
    code: "SESSION_NOT_FOUND" as const,
    reason: "target disappeared",
    deliveryId: "delivery-1",
  };
  const frames = bossControlAcceptedRecoveryFrames(result);
  assert.deepEqual(frames.map((frame) => frame.type), ["boss_control_ack", "boss_control_result"]);
  assert.equal(frames[0].deliveryId, "delivery-1");
  assert.equal(frames[1], result);
  assert.throws(() => bossControlAcceptedRecoveryFrames({ ...result, deliveryId: undefined }));
});

test("Boss result and ACK schemas reject contradictory extras, unknown codes, descriptors, prototypes, symbols, and proxies", () => {
  const ack = {
    type: "boss_control_ack",
    requestId: "request-1",
    messageId: "request-1",
    idempotencyKey: "operation-1",
    status: "accepted",
    deliveryId: "delivery-1",
  };
  assert.deepEqual(parseBossControlAck(ack), ack);
  assert.deepEqual(parseBossControlResult(delivered), delivered);
  assert.throws(() => parseBossControlResult({ ...delivered, code: "POLICY_DENIED" }), /discriminant/);
  assert.throws(() => parseBossControlResult({ ...delivered, extra: true }), /discriminant/);
  assert.throws(() => parseBossControlResult({
    type: "boss_control_result",
    requestId: "request-1",
    messageId: "request-1",
    idempotencyKey: "operation-1",
    status: "rejected",
    delivered: false,
    code: "ATTACKER_CODE",
    reason: "no",
  }), /discriminant/);
  assert.throws(() => parseBossControlResult({
    type: "boss_control_result",
    requestId: "request-1",
    messageId: "request-1",
    idempotencyKey: "operation-1",
    status: "rejected",
    delivered: false,
    code: "POLICY_DENIED",
    reason: "no",
    deliveryId: undefined,
  }), /discriminant/);
  assert.throws(() => parseBossControlAck({ ...ack, delivered: true }), /discriminant/);

  const hostile: unknown[] = [];
  hostile.push(Object.assign(Object.create({ inherited: true }), ack));
  const symbol = { ...ack };
  Object.defineProperty(symbol, Symbol("hidden"), { value: true });
  hostile.push(symbol);
  const nonEnumerable = { ...ack };
  Object.defineProperty(nonEnumerable, "status", { value: "accepted", enumerable: false });
  hostile.push(nonEnumerable);
  const accessor = { ...ack };
  Object.defineProperty(accessor, "status", { get: () => "accepted", enumerable: true });
  hostile.push(accessor);
  for (const value of hostile) assert.throws(() => parseBossControlAck(value));

  let trapCount = 0;
  const proxy = new Proxy(ack, {
    get() { trapCount += 1; throw new Error("trap"); },
    ownKeys() { trapCount += 1; throw new Error("trap"); },
    getOwnPropertyDescriptor() { trapCount += 1; throw new Error("trap"); },
    getPrototypeOf() { trapCount += 1; throw new Error("trap"); },
  });
  assert.throws(() => parseBossControlAck(proxy), /proxies are not supported/);
  assert.equal(trapCount, 0);
});

test("corrupt Boss ledger is quarantined and fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "boss-control-corrupt-"));
  try {
    const path = join(dir, "ledger.json");
    writeFileSync(path, "{not-json");
    assert.throws(() => new BossControlResultLedger(path, () => 123), /corrupt and quarantined/);
    assert.deepEqual(readdirSync(dir), ["ledger.json.corrupt-123"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
