import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ASK_TIMEOUT_MS, MAX_ASK_TIMEOUT_MS, getAskTimeoutMs, validateAskTimeoutMs } from "../config.ts";

test("getAskTimeoutMs defaults to a short bounded wait", () => {
  const previous = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  try {
    delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
    assert.equal(getAskTimeoutMs(), DEFAULT_ASK_TIMEOUT_MS);
    assert.equal(DEFAULT_ASK_TIMEOUT_MS, 45000);
  } finally {
    if (previous === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
    else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = previous;
  }
});

test("validateAskTimeoutMs rejects waits above the interactive maximum", () => {
  assert.equal(validateAskTimeoutMs(MAX_ASK_TIMEOUT_MS), MAX_ASK_TIMEOUT_MS);
  assert.throws(() => validateAskTimeoutMs(MAX_ASK_TIMEOUT_MS + 1), /intercom_send plus intercom_pending/);
});

test("getAskTimeoutMs validates environment overrides", () => {
  const previous = process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
  try {
    process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "60000";
    assert.equal(getAskTimeoutMs(), 60000);
    process.env.PI_INTERCOM_ASK_TIMEOUT_MS = "600000";
    assert.throws(() => getAskTimeoutMs(), /PI_INTERCOM_ASK_TIMEOUT_MS must be 120000 ms or less/);
  } finally {
    if (previous === undefined) delete process.env.PI_INTERCOM_ASK_TIMEOUT_MS;
    else process.env.PI_INTERCOM_ASK_TIMEOUT_MS = previous;
  }
});
