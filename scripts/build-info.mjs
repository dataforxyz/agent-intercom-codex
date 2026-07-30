import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const RUNTIME_ROOTS = [
  "broker",
  "codex",
];
const RUNTIME_FILES = [
  "config.ts",
  "boss-control-outbox.ts",
  "durable-json.ts",
  "outbound-outbox.ts",
  "package.json",
  "scripts/build-info.mjs",
  "scripts/build.mjs",
  "types.ts",
];

async function runtimeFiles(root) {
  const files = [];
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile() && !entry.name.endsWith(".test.ts")) {
        files.push(child);
      }
    }
  }
  for (const directory of RUNTIME_ROOTS) await walk(join(root, directory));
  for (const file of RUNTIME_FILES) files.push(join(root, file));
  return files.sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
}

export async function computeRuntimeSourceSha256(root = process.cwd()) {
  const resolvedRoot = resolve(root);
  const hash = createHash("sha256");
  for (const path of await runtimeFiles(resolvedRoot)) {
    const name = relative(resolvedRoot, path).replaceAll("\\", "/");
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function buildIdentityLine({ packageName, version, target, sourceSha256 }) {
  return `[agent-intercom-build] package=${packageName} version=${version} target=${target} sourceSha256=${sourceSha256}`;
}

export function buildBanner(identity, shebang = "") {
  const prefix = shebang ? `${shebang}\n` : "";
  return `${prefix}process.stderr.write(${JSON.stringify(`${buildIdentityLine(identity)}\n`)});`;
}
