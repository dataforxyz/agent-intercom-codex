import { chmod } from "node:fs/promises";
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["codex/server.ts"],
    outfile: "dist/codex-server.mjs",
    banner: { js: "#!/usr/bin/env node" },
  }),
  build({
    ...common,
    entryPoints: ["broker/broker.ts"],
    outfile: "dist/broker.mjs",
  }),
  build({
    ...common,
    entryPoints: ["codex/bridge-daemon.ts"],
    outfile: "dist/bridge-daemon.mjs",
    banner: { js: "#!/usr/bin/env node" },
  }),
  build({
    ...common,
    entryPoints: ["codex/coi.ts"],
    outfile: "dist/coi.mjs",
    banner: { js: "#!/usr/bin/env node" },
    external: ["codex"],
  }),
]);

await Promise.all([
  chmod("dist/codex-server.mjs", 0o755),
  chmod("dist/bridge-daemon.mjs", 0o755),
  chmod("dist/coi.mjs", 0o755),
]);
