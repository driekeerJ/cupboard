/**
 * Takes the README screenshots from a throwaway vault.
 *
 * Never from the real vault: that one is full of a family, their shops and a
 * year of groceries. The sample notes under `demo/` are copied to
 * `~/Obsidian/pantry-demo` together with the plugin build, and Obsidian itself
 * is then driven over the Chrome DevTools Protocol: open each screen, call
 * `Page.captureScreenshot`. No `screencapture`, so no screen-recording
 * permission and no other window sliding in front.
 *
 * That needs Obsidian running with `--remote-debugging-port`. The script quits
 * a running Obsidian, starts it again with that flag, and restarts it normally
 * at the end. Obsidian remembers which vaults were open by itself.
 *
 *   npm run build && node scripts/screenshots.mjs
 *
 * Set PANTRY_DEMO_VAULT to put the demo vault somewhere else.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VAULT = process.env.PANTRY_DEMO_VAULT ?? join(homedir(), "Obsidian", "pantry-demo");
const OUT = join(ROOT, "docs", "screenshots");
const PORT = 9222;
const MARKER = ".pantry-demo-vault";

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const ID = manifest.id;

// ---------- 1. The vault ----------

function buildVault() {
	// Only delete what we made ourselves: the path is configurable and a typo
	// must never wipe a real vault.
	if (existsSync(VAULT) && !existsSync(join(VAULT, MARKER))) {
		throw new Error(`${VAULT} exists but is not a demo vault (no ${MARKER}); stopping.`);
	}
	rmSync(VAULT, { recursive: true, force: true });
	cpSync(join(ROOT, "demo"), VAULT, {
		recursive: true,
		filter: (src) => !src.includes(join("demo", ".pantry-demo")) && !src.endsWith("README.md"),
	});
	writeFileSync(join(VAULT, MARKER), "Made by scripts/screenshots.mjs. Safe to delete.\n");

	const config = join(VAULT, ".obsidian");
	const pluginDir = join(config, "plugins", ID);
	mkdirSync(pluginDir, { recursive: true });
	for (const name of ["main.js", "manifest.json", "styles.css"]) {
		const from = join(ROOT, name);
		if (!existsSync(from)) throw new Error(`${name} is missing — run npm run build first.`);
		cpSync(from, join(pluginDir, name));
	}
	cpSync(join(ROOT, "demo", ".pantry-demo", "data.json"), join(pluginDir, "data.json"));

	writeFileSync(join(config, "community-plugins.json"), JSON.stringify([ID]));
	writeFileSync(join(config, "appearance.json"), JSON.stringify({ theme: "moonstone", baseFontSize: 16 }));
	writeFileSync(join(config, "app.json"), JSON.stringify({ showInlineTitle: true }));
	writeFileSync(join(config, "workspace.json"), JSON.stringify(LAYOUT));
}

/** One empty tab, sidebars closed: the clean start every shot begins from. */
const LAYOUT = {
	main: { id: "main", type: "split", children: [{ id: "tabs", type: "tabs", children: [{ id: "leaf", type: "leaf", state: { type: "empty", state: {} } }] }], direction: "vertical" },
	left: { id: "left", type: "split", children: [{ id: "ltabs", type: "tabs", children: [{ id: "lleaf", type: "leaf", state: { type: "file-explorer", state: {} } }] }], direction: "horizontal", width: 260, collapsed: true },
	right: { id: "right", type: "split", children: [{ id: "rtabs", type: "tabs", children: [{ id: "rleaf", type: "leaf", state: { type: "backlink", state: {} } }] }], direction: "horizontal", width: 260, collapsed: true },
	active: "leaf",
};

// ---------- 2. Obsidian with a debug port ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targets() {
	try {
		const response = await fetch(`http://localhost:${PORT}/json`);
		return await response.json();
	} catch {
		return null;
	}
}

function obsidianRunning() {
	return spawnSync("pgrep", ["-x", "Obsidian"]).status === 0;
}

/**
 * On startup Obsidian opens every vault in its own list that has `open: true`.
 * Registering the demo vault there is more reliable than the
 * `obsidian://open?path=` URI, which an app that has just started ignores.
 */
function registerVault() {
	const file = join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json");
	const config = JSON.parse(readFileSync(file, "utf8"));
	config.vaults ??= {};
	const known = Object.entries(config.vaults).find(([, v]) => v.path === VAULT);
	const id = known ? known[0] : Math.random().toString(16).slice(2, 18).padEnd(16, "0");
	config.vaults[id] = { path: VAULT, ts: Date.now(), open: true };
	writeFileSync(file, JSON.stringify(config));
}

async function quitObsidian() {
	if (!obsidianRunning()) return;
	execFileSync("osascript", ["-e", 'quit app "Obsidian"']);
	for (let i = 0; i < 60 && obsidianRunning(); i++) await sleep(500);
}

async function startDebugObsidian() {
	registerVault();
	execFileSync("open", ["-a", "Obsidian", "--args", `--remote-debugging-port=${PORT}`]);
	for (let i = 0; i < 60; i++) {
		if (await targets()) return;
		await sleep(500);
	}
	throw new Error("Obsidian does not answer on the debug port.");
}

async function restartObsidianNormally() {
	await quitObsidian();
	execFileSync("open", ["-a", "Obsidian"]);
}

async function demoTarget() {
	const wanted = VAULT.split("/").pop();
	for (let i = 0; i < 60; i++) {
		const list = (await targets()) ?? [];
		const hit = list.find((t) => t.type === "page" && t.title.includes(wanted));
		if (hit) return hit;
		await sleep(500);
	}
	throw new Error("The demo vault window did not appear.");
}

// ---------- 3. A thin CDP layer ----------

class Session {
	constructor(ws) {
		this.ws = ws;
		this.next = 1;
		this.pending = new Map();
		ws.addEventListener("message", (event) => {
			const msg = JSON.parse(event.data);
			const waiter = this.pending.get(msg.id);
			if (!waiter) return;
			this.pending.delete(msg.id);
			if (msg.error) waiter.reject(new Error(`${msg.error.message}`));
			else waiter.resolve(msg.result);
		});
	}

	static async connect(url) {
		const ws = new WebSocket(url);
		await new Promise((resolve, reject) => {
			ws.addEventListener("open", resolve, { once: true });
			ws.addEventListener("error", reject, { once: true });
		});
		return new Session(ws);
	}

	send(method, params = {}) {
		const id = this.next++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	/** Runs JavaScript inside the Obsidian window and waits for a returned promise. */
	async run(expression) {
		const result = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
		}
		return result.result.value;
	}

	async shot(name) {
		const { data } = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true });
		mkdirSync(OUT, { recursive: true });
		writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
		console.log(`  ${name}.png`);
	}

	close() {
		this.ws.close();
	}
}

// ---------- 4. The shots ----------

async function main() {
	// Quit first: on the way out Obsidian saves the workspace of a demo vault
	// it still had open, and that would land on top of the clean one.
	console.log("Restarting Obsidian with a debug port…");
	await quitObsidian();
	buildVault();
	console.log(`Vault: ${VAULT}`);
	await startDebugObsidian();
	const target = await demoTarget();
	const s = await Session.connect(target.webSocketDebuggerUrl);

	// A vault that opens for the first time asks whether to trust its plugins.
	for (let i = 0; i < 40; i++) {
		const clicked = await s.run(`(() => {
			const button = Array.from(document.querySelectorAll(".modal button"))
				.find((b) => /trust/i.test(b.textContent));
			if (button) { button.click(); return true; }
			return false;
		})()`);
		if (clicked) break;
		await sleep(250);
	}

	// Wait for the plugin to load and fill its indexes.
	for (let i = 0; i < 80; i++) {
		const ready = await s.run(`!!(app.plugins?.plugins?.[${JSON.stringify(ID)}]) && app.workspace.layoutReady`);
		if (ready) break;
		await sleep(250);
	}
	await sleep(1500);

	// Electron's own window handle: CDP's Browser domain is not exposed here.
	async function size(width, height) {
		await s.run(`require("@electron/remote").getCurrentWindow().setContentSize(${width}, ${height})`);
		await sleep(700);
	}

	async function escape() {
		for (const type of ["keyDown", "keyUp"]) {
			await s.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		}
		await sleep(300);
	}

	const plugin = `app.plugins.plugins[${JSON.stringify(ID)}]`;
	const command = (name) => `app.commands.executeCommandById(${JSON.stringify(`${ID}:${name}`)})`;
	const list = JSON.stringify("Pantry/Shopping/2026-09-23 Supermarket.md");

	// Wrapped so nothing DOM-shaped travels back over the wire: CDP refuses to
	// serialise a returned view or modal ("object reference chain is too long").
	const quietly = (expression) => `(async () => { await (${expression}); })()`;

	// Every shot starts from one empty tab: no pile of tabs from earlier shots,
	// and no status bar with a sync icon in the corner.
	await s.run(quietly(`(() => {
		const style = document.createElement("style");
		style.textContent = ".status-bar { display: none !important; }";
		document.head.appendChild(style);
	})()`));

	// `changeLayout` rather than detaching leaves: since Obsidian 1.14 the
	// root iteration skips deferred tabs, so detaching left the rest standing.
	async function screen(name, expression, settle = 900) {
		await s.run(quietly(`app.workspace.changeLayout(${JSON.stringify(LAYOUT)})`));
		await sleep(300);
		await s.run(quietly(expression));
		await sleep(settle);
		await s.shot(name);
	}

	console.log("Desktop:");
	await size(1280, 820);
	await screen("home", command("open-home"));
	await screen("planner", command("open-planner"), 1400);
	await screen("shopping-lists", command("open-shopping-lists"));
	await screen("list-stock", `${plugin}.openList(${list}, "stock")`, 1200);
	await screen("list-shop", `${plugin}.openList(${list}, "shop")`, 1200);
	await screen("stock", command("open-stock"));
	await screen("products", command("open-products"));
	await screen("shelves", command("open-shelves"));
	await screen("cleanup", command("open-cleanup"));
	await screen("cook", `${plugin}.openCook("Chickpea curry")`, 1400);
	const openNote = (path) =>
		`app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(${JSON.stringify(path)}), { state: { mode: "preview" } })`;
	await screen("recipe-note", openNote("Recipes/Chickpea curry.md"), 1200);
	await screen("plan-note", openNote("Meal plans/2026-W39.md"), 1400);
	await screen("list-note", openNote("Pantry/Shopping/2026-09-23 Supermarket.md"), 1200);
	await screen("setup", `${plugin}.runSetup()`, 800);
	await escape();

	console.log("Narrow:");
	await size(430, 860);
	await screen("narrow-home", command("open-home"));
	await screen("narrow-list-shop", `${plugin}.openList(${list}, "shop")`, 1200);
	await screen("narrow-cook", `${plugin}.openCook("Chickpea curry")`, 1400);

	await size(1280, 820);
	s.close();
	console.log(`\nDone: ${OUT}`);
	console.log("Restarting Obsidian without the debug port…");
	await restartObsidianNormally();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
