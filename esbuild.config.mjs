import esbuild from "esbuild";
import process from "process";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

function buildStamp() {
  const { version } = JSON.parse(readFileSync("manifest.json", "utf8"));
  let commit = "";
  try {
    commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    // No git (a source tarball): the version alone still tells devices apart.
  }
  return commit ? `${version} (${commit})` : version;
}

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    // Preventief: zonder deze lijst bundelt esbuild bij een toekomstige
    // editor-extensie een tweede kopie van CodeMirror naast die van Obsidian.
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  // Which build a device runs is shown in the settings tab: Obsidian only
  // picks up a new main.js after a full restart, and Sync does not carry it
  // to the phone, so "it does not work" is usually "old build". The stamp is
  // the version plus the commit, never the clock: the community directory
  // rebuilds the release from source and expects a byte-identical main.js.
  define: {
    PANTRY_BUILD: JSON.stringify(buildStamp()),
  },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
