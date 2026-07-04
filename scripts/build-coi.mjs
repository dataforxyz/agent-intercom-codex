import { chmod } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["codex/coi.ts"],
  outfile: "dist/coi.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  external: ["codex"],
});

await chmod("dist/coi.mjs", 0o755);
