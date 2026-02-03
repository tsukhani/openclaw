import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

const env = {
  NODE_ENV: "production",
};

const define = {
  __OPENCLAW_VERSION__: JSON.stringify(pkg.version),
};

export default defineConfig([
  {
    entry: "src/index.ts",
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/entry.ts",
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
  {
    dts: true,
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/extensionAPI.ts",
    env,
    define,
    fixedExtension: false,
    platform: "node",
  },
]);
