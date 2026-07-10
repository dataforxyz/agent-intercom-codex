import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexAppServerArgs, buildCoiTuiArgs, cleanupOldCoiStateFiles, createDefaultIdentity, deriveBridgeAgentRuntimeConfig, hasCodexHelpOrVersion, parseCoiArgs, resolveCoiResumeRequest, sanitizeSegment, splitCodexResumeArgs } from "./coi.ts";
import { filterAltIInput, TuiInputDecoder } from "./tui-input.ts";

test("sanitizeSegment keeps readable safe ids", () => {
  assert.equal(sanitizeSegment("Codex:Repo Main#123"), "codex:repo-main-123");
  assert.equal(sanitizeSegment(""), "codex");
});

test("createDefaultIdentity derives readable per-process defaults", () => {
  const identity = createDefaultIdentity({
    cwd: "/home/me/src/project",
    pid: 1234,
    gitRoot: "/home/me/src/project",
    branch: "main",
  });
  assert.match(identity.id, /^codex-project-main-[a-f0-9]{8}-1234$/);
  assert.equal(identity.name, "codex:project:main#1234");
});

test("parseCoiArgs consumes sidecar options and passes codex args through", () => {
  const parsed = parseCoiArgs([
    "--name", "worker",
    "--id=worker-1",
    "--no-tui",
    "--profile", "cliproxy",
    "-m", "gpt-test",
  ], {});

  assert.equal(parsed.name, "worker");
  assert.equal(parsed.id, "worker-1");
  assert.equal(parsed.noTui, true);
  assert.equal(parsed.copyShortcut, true);
  assert.deepEqual(parsed.codexArgs, ["--profile", "cliproxy", "-m", "gpt-test"]);
});

test("parseCoiArgs leaves everything after separator for codex", () => {
  const parsed = parseCoiArgs([
    "--intercom-name", "sidecar",
    "--",
    "--name", "not-sidecar",
  ], {});

  assert.equal(parsed.name, "sidecar");
  assert.deepEqual(parsed.codexArgs, ["--name", "not-sidecar"]);
});

test("parseCoiArgs supports disabling the Alt+I terminal shortcut", () => {
  assert.equal(parseCoiArgs(["--no-intercom-shortcut"], {}).copyShortcut, false);
  assert.equal(parseCoiArgs([], { CODEX_INTERCOM_SHORTCUT: "off" }).copyShortcut, false);
  assert.equal(parseCoiArgs(["--intercom-shortcut"], { CODEX_INTERCOM_SHORTCUT: "off" }).copyShortcut, true);
});

test("splitCodexResumeArgs keeps options before the resumed thread id", () => {
  assert.deepEqual(splitCodexResumeArgs(["--profile", "cliproxy", "-m", "gpt-test", "hello there"]), {
    optionArgs: ["--profile", "cliproxy", "-m", "gpt-test"],
    promptArgs: ["hello there"],
  });
});

test("splitCodexResumeArgs respects explicit separator", () => {
  assert.deepEqual(splitCodexResumeArgs(["--no-alt-screen", "--", "--literal-prompt"]), {
    optionArgs: ["--no-alt-screen"],
    promptArgs: ["--literal-prompt"],
  });
});

test("resolveCoiResumeRequest reuses an explicitly requested Codex thread", () => {
  assert.deepEqual(resolveCoiResumeRequest(["--profile", "work", "resume", "thread-123", "continue this"]), {
    optionArgs: ["--profile", "work"],
    threadId: "thread-123",
    promptArgs: ["continue this"],
  });
});

test("buildCoiTuiArgs opens a fresh remote TUI without resuming an empty sidecar thread", () => {
  assert.deepEqual(buildCoiTuiArgs("unix:///tmp/coi.sock", ["--profile", "work"], "thread-sidecar", [], false), [
    "--remote", "unix:///tmp/coi.sock", "--profile", "work",
  ]);
  assert.deepEqual(buildCoiTuiArgs("unix:///tmp/coi.sock", [], "thread-requested", ["continue"], true), [
    "resume", "--remote", "unix:///tmp/coi.sock", "thread-requested", "continue",
  ]);
});

test("buildCodexAppServerArgs forwards only app-server-compatible config options", () => {
  assert.deepEqual(
    buildCodexAppServerArgs([
      "--dangerously-bypass-approvals-and-sandbox",
      "--profile", "cliproxy",
      "-c", 'model_provider="cliproxy"',
      "--enable", "multi_agent",
      "hello there",
    ], "/tmp/coi.sock"),
    [
      "app-server",
      "-c", 'model_provider="cliproxy"',
      "--enable", "multi_agent",
      "--listen", "unix:///tmp/coi.sock",
    ],
  );
});

test("filterAltIInput removes legacy and enhanced Alt+I press encodings", () => {
  assert.deepEqual(filterAltIInput("before\x1biafter\x1b[105;3:1u!"), {
    forwarded: "beforeafter!",
    pending: "",
    altICount: 2,
    altMCount: 0,
  });
  assert.deepEqual(filterAltIInput("\x1b[27;3;105~"), {
    forwarded: "",
    pending: "",
    altICount: 1,
    altMCount: 0,
  });
});

test("filterAltIInput consumes repeat and release events without retriggering", () => {
  assert.deepEqual(filterAltIInput("\x1b[105;3:1u\x1b[105;3:2u\x1b[105;3:3u"), {
    forwarded: "",
    pending: "",
    altICount: 1,
    altMCount: 0,
  });
});

test("filterAltIInput accepts lock modifiers and alternate keyboard layouts", () => {
  assert.deepEqual(filterAltIInput("\x1b[105;67u\x1b[1080::105;3u"), {
    forwarded: "",
    pending: "",
    altICount: 2,
    altMCount: 0,
  });
});

test("filterAltIInput preserves Alt+Shift+I and other modified keys", () => {
  const input = "\x1b[105;4u\x1b[105;7u\x1b[106;3u";
  assert.deepEqual(filterAltIInput(input), {
    forwarded: input,
    pending: "",
    altICount: 0,
    altMCount: 0,
  });
});

test("filterAltIInput carries split escape sequences between chunks", () => {
  const first = filterAltIInput("hello\x1b[105;");
  assert.deepEqual(first, { forwarded: "hello", pending: "\x1b[105;", altICount: 0, altMCount: 0 });
  assert.deepEqual(filterAltIInput("3:1uworld", first.pending), {
    forwarded: "world",
    pending: "",
    altICount: 1,
    altMCount: 0,
  });
});

test("filterAltIInput preserves unrelated terminal escape sequences", () => {
  assert.deepEqual(filterAltIInput("\x1b[A\x1b[200~paste\x1b[201~"), {
    forwarded: "\x1b[A\x1b[200~paste\x1b[201~",
    pending: "",
    altICount: 0,
    altMCount: 0,
  });
});

test("filterAltIInput also extracts Alt+M intercom shortcut encodings", () => {
  assert.deepEqual(filterAltIInput("before\x1bmafter\x1b[109;3:1u"), {
    forwarded: "beforeafter",
    pending: "",
    altICount: 0,
    altMCount: 2,
  });
});

test("TuiInputDecoder preserves UTF-8 split across terminal chunks", () => {
  const decoder = new TuiInputDecoder();
  const bytes = Buffer.from("a🙂b");
  const first = decoder.write(bytes.subarray(0, 3));
  const second = decoder.write(bytes.subarray(3));
  const ended = decoder.end();
  assert.equal(first.forwarded + second.forwarded + ended.forwarded, "a🙂b");
  assert.equal(first.altICount + second.altICount + ended.altICount, 0);
});

test("TuiInputDecoder carries and flushes partial escape sequences", () => {
  const decoder = new TuiInputDecoder();
  assert.deepEqual(decoder.write(Buffer.from("hello\x1b[105;")), { forwarded: "hello", altICount: 0, altMCount: 0 });
  assert.equal(decoder.hasPendingEscape(), true);
  assert.deepEqual(decoder.write(Buffer.from("3:1u")), { forwarded: "", altICount: 1, altMCount: 0 });
  assert.equal(decoder.hasPendingEscape(), false);
  decoder.write(Buffer.from("\x1b"));
  assert.equal(decoder.flushPendingEscape(), "\x1b");
});

test("hasCodexHelpOrVersion detects commands that should not force resume", () => {
  assert.equal(hasCodexHelpOrVersion(["--help"]), true);
  assert.equal(hasCodexHelpOrVersion(["--profile", "cliproxy"]), false);
});

test("deriveBridgeAgentRuntimeConfig carries workspace-write sandbox roots", () => {
  assert.deepEqual(deriveBridgeAgentRuntimeConfig([
    "--sandbox", "workspace-write",
    "--add-dir", "../shared",
    "--ask-for-approval=on-request",
  ], "/tmp/project"), {
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/tmp/project", "/tmp/shared"],
      networkAccess: false,
    },
  });
});

test("deriveBridgeAgentRuntimeConfig supports short and bypass flags", () => {
  assert.deepEqual(deriveBridgeAgentRuntimeConfig(["-s=read-only", "-a", "never"], "/tmp/project"), {
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });

  assert.deepEqual(deriveBridgeAgentRuntimeConfig(["--dangerously-bypass-approvals-and-sandbox"], "/tmp/project"), {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
});

test("cleanupOldCoiStateFiles removes only stale coi state files", () => {
  const dir = mkdtempSync(join(tmpdir(), "coi-cleanup-"));
  try {
    const stale = join(dir, "coi-old-state.json");
    const fresh = join(dir, "coi-fresh-state.json");
    const other = join(dir, "other-state.json");
    writeFileSync(stale, "{}");
    writeFileSync(fresh, "{}");
    writeFileSync(other, "{}");
    const now = Date.now();
    utimesSync(stale, new Date(now - 20000), new Date(now - 20000));
    cleanupOldCoiStateFiles(dir, now, 10000);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(other), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
