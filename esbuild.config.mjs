import esbuild from "esbuild";
import process from "process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

/**
 * A release build is stamped with the version alone. The community directory
 * rebuilds main.js from a source archive without git history and expects a
 * byte-identical file, so nothing that varies per checkout or per clock may
 * end up in it. A dev build adds the time: those are the ones where "is this
 * the latest build?" is the actual question.
 */
function buildStamp() {
  const { version } = JSON.parse(readFileSync("manifest.json", "utf8"));
  if (prod) return version;
  return `${version} dev ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
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
  // to the phone, so "it does not work" is usually "old build".
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
