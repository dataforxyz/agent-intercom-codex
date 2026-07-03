import test from "node:test";
import assert from "node:assert/strict";
import { defaultServerRequestResponse } from "./app-server-client.ts";

test("defaultServerRequestResponse denies command approvals", () => {
  assert.deepEqual(defaultServerRequestResponse("item/commandExecution/requestApproval"), { decision: "decline" });
  assert.deepEqual(defaultServerRequestResponse("execCommandApproval"), { decision: "denied" });
});

test("defaultServerRequestResponse declines interactive requests", () => {
  assert.deepEqual(defaultServerRequestResponse("item/tool/requestUserInput"), { answers: {} });
  assert.deepEqual(defaultServerRequestResponse("mcpServer/elicitation/request"), { action: "decline", content: null, _meta: null });
});

test("defaultServerRequestResponse rejects unknown requests", () => {
  assert.throws(() => defaultServerRequestResponse("unknown/request"), /Unsupported app-server request/);
});
