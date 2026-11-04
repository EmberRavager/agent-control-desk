import { build } from "esbuild";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const outdir = fileURLToPath(new URL("../dist/runtime", import.meta.url));
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: { cli: "apps/cli/main.ts", server: "packages/core/server.ts" },
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  platform: "node",
  target: "node22.13",
  format: "esm",
  packages: "external",
  banner: {
    js: 'import { createRequire as __acdCreateRequire } from "node:module"; const require = __acdCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});

const icon = await readFile(
  new URL("../apps/desktop/assets/app-icon.svg", import.meta.url),
  "utf8",
);
await writeFile(
  new URL("../dist/app-icon.png", import.meta.url),
  new Resvg(icon).render().asPng(),
);
