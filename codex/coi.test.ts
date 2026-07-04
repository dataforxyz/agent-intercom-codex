import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupOldCoiStateFiles, createDefaultIdentity, hasCodexHelpOrVersion, parseCoiArgs, sanitizeSegment, splitCodexResumeArgs } from "./coi.ts";

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

test("hasCodexHelpOrVersion detects commands that should not force resume", () => {
  assert.equal(hasCodexHelpOrVersion(["--help"]), true);
  assert.equal(hasCodexHelpOrVersion(["--profile", "cliproxy"]), false);
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
