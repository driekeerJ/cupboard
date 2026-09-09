import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

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
  // Het bouwtijdstip staat in de plugin (Settings → Pantry), zodat je op elk
  // apparaat kunt zien of het de laatste build draait. Obsidian pakt een
  // nieuwe main.js pas op na een volledige herstart, en Sync brengt hem niet
  // vanzelf naar de telefoon — "werkt niet" is meestal "oude build".
  define: {
    PANTRY_BUILD: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ")),
  },
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
