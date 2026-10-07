/**
 * End-to-end checks in a real Obsidian, emulating a phone.
 *
 *   npm run e2e
 *
 * Wat de harnastests niet kunnen zien — een tik die afvinkt, vasthouden dat
 * bewerkt, een knop die onder de systeembalk valt — zit in de DOM van een
 * echte Obsidian. Dit script start daarvoor een *tweede* Obsidian met een
 * eigen gebruikersmap (`--user-data-dir`) en een debugpoort, met alleen een
 * wegwerpkluis erin. De Obsidian waar je zelf in werkt merkt er niets van:
 * Electron houdt één instantie per gebruikersmap, niet per app.
 *
 * Die tweede Obsidian draait in Obsidians eigen telefoonmodus (`EmulateMobile`
 * in zijn localStorage, venster 390×844). Obsidian zet daarin
 * `--safe-area-inset-*` zoals een iPhone; dit script zet ze op wat een
 * Android-telefoon met drieknopsnavigatie meldt: 24px statusbalk, 48px
 * navigatiebalk. `env(safe-area-inset-*)` blijft hier 0, net als in Android's
 * WebView. Een sheet die op `env()` leunde, zakt dus voor de insettest —
 * precies de bug uit #2. Gecontroleerd: de build van vóór de fix zakt.
 *
 * Kliks en vasthouden gaan als echte muisgebeurtenissen over CDP, scrollen
 * als een echte aanraakveeg (`Input.synthesizeScrollGesture`): de handlers
 * zien hetzelfde als op een toestel. Wat dit níet test: het gevoel van een
 * animatie, iOS' eigen lang-drukmenu, en Android's WebView zelf.
 *
 * Bij een mislukte check komt er een screenshot in `tests/e2e-out/`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORK = join(tmpdir(), "cupboard-e2e");
const VAULT = join(WORK, "vault");
const USER_DATA = join(WORK, "obsidian");
const OUT = join(ROOT, "tests", "e2e-out");
const PORT = Number(process.env.CUPBOARD_E2E_PORT ?? 9333);
const ID = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")).id;
const PHONE = { width: 390, height: 844 };
/** What an Android phone with three-button navigation reports (#2). */
const ANDROID = { top: 24, bottom: 48 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 1. The vault: demo/, moved to this week ----------

const DEMO_MONDAY = "2026-09-21"; // demo week 39

function isoDate(date) {
	return date.toISOString().slice(0, 10);
}

function mondayOf(date) {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
	return d;
}

function isoWeek(iso) {
	const d = new Date(`${iso}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
	const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
	firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
	const week = 1 + Math.round((d - firstThursday) / (7 * 864e5));
	return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Every demo date moves by whole weeks, so demo week 39 becomes this week. */
const SHIFT = Math.round((mondayOf(new Date()) - new Date(`${DEMO_MONDAY}T00:00:00Z`)) / 864e5);
const shiftDate = (iso) => {
	const d = new Date(`${iso}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + SHIFT);
	return isoDate(d);
};
const shiftAll = (text) => text.replace(/\b20\d\d-\d\d-\d\d\b/g, shiftDate);

function buildVault() {
	rmSync(WORK, { recursive: true, force: true });
	cpSync(join(ROOT, "demo"), VAULT, {
		recursive: true,
		filter: (src) => !src.includes(".pantry-demo") && !src.endsWith("README.md"),
	});

	for (const folder of ["Meal plans", "Cupboard/Shopping", "Products"]) {
		const dir = join(VAULT, folder);
		for (const name of readdirSync(dir)) {
			let text = shiftAll(readFileSync(join(dir, name), "utf8"));
			let renamed = shiftAll(name);
			const week = text.match(/^weekStart: (\S+)$/m);
			if (week) {
				const [oldWeek] = text.match(/\d{4}-W\d\d/);
				const newWeek = isoWeek(week[1]);
				text = text.replaceAll(oldWeek, newWeek).replace(/week \d+/, `week ${Number(newWeek.slice(6))}`);
				renamed = `${newWeek}.md`;
			}
			rmSync(join(dir, name));
			writeFileSync(join(dir, renamed), text);
		}
	}

	const config = join(VAULT, ".obsidian");
	const pluginDir = join(config, "plugins", ID);
	mkdirSync(pluginDir, { recursive: true });
	for (const name of ["main.js", "manifest.json", "styles.css"]) {
		if (!existsSync(join(ROOT, name))) throw new Error(`${name} is missing — run the build first.`);
		cpSync(join(ROOT, name), join(pluginDir, name));
	}
	cpSync(join(ROOT, "demo", ".pantry-demo", "settings.json"), join(pluginDir, "data.json"));
	writeFileSync(join(config, "community-plugins.json"), JSON.stringify([ID]));
	writeFileSync(join(config, "app.json"), JSON.stringify({ showInlineTitle: true }));

	mkdirSync(USER_DATA, { recursive: true });
	writeFileSync(
		join(USER_DATA, "obsidian.json"),
		JSON.stringify({ vaults: { cupboarde2e00001: { path: VAULT, ts: Date.now(), open: true } } })
	);
}

// ---------- 2. A second Obsidian ----------

async function targets() {
	try {
		return await (await fetch(`http://localhost:${PORT}/json`)).json();
	} catch {
		return null;
	}
}

async function pageTarget() {
	for (let i = 0; i < 120; i++) {
		const hit = ((await targets()) ?? []).find((t) => t.type === "page" && t.title.includes("vault"));
		if (hit) return hit;
		await sleep(500);
	}
	throw new Error("The test vault window did not appear.");
}

function launch() {
	if (spawnSync("lsof", ["-ti", `tcp:${PORT}`]).stdout.length > 0) {
		throw new Error(`Port ${PORT} is in use; set CUPBOARD_E2E_PORT.`);
	}
	execFileSync("open", ["-n", "-g", "-a", "Obsidian", "--args", `--user-data-dir=${USER_DATA}`, `--remote-debugging-port=${PORT}`]);
}

/** Only ever our own instance: matched on its private user-data-dir. */
function killOurs() {
	spawnSync("pkill", ["-f", `user-data-dir=${USER_DATA}`]);
}

// ---------- 3. A thin CDP layer ----------

class Session {
	constructor(ws) {
		this.ws = ws;
		this.next = 1;
		this.pending = new Map();
		this.errors = [];
		ws.addEventListener("message", (event) => {
			const msg = JSON.parse(event.data);
			if (msg.method === "Runtime.exceptionThrown") {
				this.errors.push(msg.params.exceptionDetails.exception?.description ?? "exception");
			}
			if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
				this.errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
			}
			const waiter = this.pending.get(msg.id);
			if (!waiter) return;
			this.pending.delete(msg.id);
			if (msg.error) waiter.reject(new Error(msg.error.message));
			else waiter.resolve(msg.result);
		});
	}

	static async connect(url) {
		const ws = new WebSocket(url);
		await new Promise((resolve, reject) => {
			ws.addEventListener("open", resolve, { once: true });
			ws.addEventListener("error", reject, { once: true });
		});
		const session = new Session(ws);
		await session.send("Runtime.enable");
		await session.send("Page.enable");
		return session;
	}

	send(method, params = {}) {
		const id = this.next++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	async run(expression) {
		const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) {
			throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
		}
		return result.result.value;
	}

	async shot(name) {
		const { data } = await this.send("Page.captureScreenshot", { format: "png" });
		mkdirSync(OUT, { recursive: true });
		writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
	}

	close() {
		this.ws.close();
	}
}

// ---------- 4. Helpers that run inside Obsidian ----------

const HELPERS = `
window.e2e = {
	plugin: () => app.plugins.plugins[${JSON.stringify(ID)}],
	all: (sel) => Array.from(document.querySelectorAll(sel)),
	visible: (el) => !!el && el.getClientRects().length > 0,
	/** Scrolls the element into view and returns its centre, for a real click. */
	point(el) {
		el.scrollIntoView({ block: "center" });
		const r = el.getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	},
	byText(sel, text) {
		return e2e.all(sel).find((el) => el.textContent.trim() === text && e2e.visible(el)) ?? null;
	},
	rows: () => e2e.all(".pantry-buy-row:not(.is-quiet):not(.is-extra)").filter(e2e.visible),
	row: (key) => document.querySelector('.pantry-buy-row[data-flip="' + CSS.escape(key) + '"]'),
	/** Position of a row among the rows of its own shelf block. */
	index(key) {
		const row = e2e.row(key);
		return row ? Array.from(row.parentElement.children).indexOf(row) : -1;
	},
	modal: () => document.querySelector(".modal-container .modal"),
	read: (path) => app.vault.adapter.read(path),
	exists: (path) => app.vault.adapter.exists(path),
	inset(side) {
		return parseFloat(getComputedStyle(document.body).getPropertyValue("--safe-area-inset-" + side)) || 0;
	},
};
true;
`;

// ---------- 5. The checks ----------

const results = [];
let s;

async function check(name, body) {
	try {
		await body();
		results.push({ name, ok: true });
		console.log(`  ✓ ${name}`);
	} catch (error) {
		results.push({ name, ok: false, error: error.message });
		console.log(`  ✗ ${name}\n      ${error.message}`);
		await s.shot(name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()).catch(() => undefined);
	}
	await escapeAll();
}

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

async function until(expression, message, timeout = 3000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await s.run(expression)) return;
		await sleep(50);
	}
	throw new Error(message);
}

async function mouse(type, x, y) {
	await s.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1 });
}

/**
 * Where to click, once the element holds still. A modal on a phone slides up
 * when it opens; a position read halfway through that animation sends the
 * click to where the button is about to be, not where it is.
 */
async function at(selectorExpression) {
	let last = null;
	for (let i = 0; i < 40; i++) {
		const point = await s.run(`(() => { const el = ${selectorExpression}; return el ? e2e.point(el) : null; })()`);
		if (point && last && Math.abs(point.x - last.x) < 0.5 && Math.abs(point.y - last.y) < 0.5) return point;
		last = point;
		await sleep(60);
	}
	if (!last) throw new Error(`nothing to click: ${selectorExpression}`);
	return last;
}

async function tap(selectorExpression) {
	const { x, y } = await at(selectorExpression);
	await mouse("mouseMoved", x, y);
	await mouse("mousePressed", x, y);
	await sleep(40);
	await mouse("mouseReleased", x, y);
}

async function hold(selectorExpression, ms = 700) {
	const { x, y } = await at(selectorExpression);
	await mouse("mouseMoved", x, y);
	await mouse("mousePressed", x, y);
	await sleep(ms);
	await mouse("mouseReleased", x, y);
}

/** Types into whatever has focus, once something editable has it. */
async function type(text) {
	await until(`document.activeElement?.matches("input, textarea")`, "no text field has focus", 1500);
	await s.send("Input.insertText", { text });
}

async function key(name, code, keyCode) {
	for (const kind of ["keyDown", "keyUp"]) {
		await s.send("Input.dispatchKeyEvent", { type: kind, key: name, code, windowsVirtualKeyCode: keyCode });
	}
}

async function escapeAll() {
	for (let i = 0; i < 4; i++) {
		if (!(await s.run(`!!e2e.modal() || !!document.querySelector(".mod-settings")`))) return;
		await key("Escape", "Escape", 27);
		await sleep(200);
	}
}

const plugin = "e2e.plugin()";
const command = (id) => `app.commands.executeCommandById(${JSON.stringify(`${ID}:${id}`)})`;
const quietly = (expression) => `(async () => { await (${expression}); return true; })()`;

async function openShop() {
	const path = await s.run(`${plugin}.lists.all().map((l) => l.path).find((p) => p.includes("Supermarket"))`);
	expect(path, "no Supermarket list in the vault");
	await s.run(quietly(`${plugin}.openList(${JSON.stringify(path)}, "shop")`));
	await until(`e2e.rows().length >= 4`, "the shopping list shows fewer than four rows");
	await sleep(300);
	return path;
}

/** Open product rows, in screen order, as their data-flip keys. */
const openRows = () => s.run(`e2e.rows().filter((r) => !r.classList.contains("is-done")).map((r) => r.dataset.flip)`);

async function main() {
	console.log("Building the test vault…");
	buildVault();
	console.log(`  ${VAULT} (dates moved ${SHIFT} days)`);

	console.log("Starting a separate Obsidian…");
	launch();
	let target = await pageTarget();
	s = await Session.connect(target.webSocketDebuggerUrl);

	// A vault that opens for the first time asks whether to trust its plugins.
	for (let i = 0; i < 40; i++) {
		const clicked = await s.run(`(() => {
			const b = Array.from(document.querySelectorAll(".modal button")).find((b) => /trust/i.test(b.textContent));
			if (b) { b.click(); return true; } return false; })()`);
		if (clicked) break;
		await sleep(250);
	}

	// Phone mode: a narrow window plus Obsidian's own mobile emulation, which
	// reloads the window.
	await s.run(`(() => { const w = require("@electron/remote").getCurrentWindow();
		w.setContentSize(${PHONE.width}, ${PHONE.height}); localStorage.EmulateMobile = 1; return true; })()`);
	await s.run(`setTimeout(() => location.reload(), 50); true`);
	s.close();
	await sleep(2500);
	target = await pageTarget();
	s = await Session.connect(target.webSocketDebuggerUrl);
	for (let i = 0; i < 120; i++) {
		if (await s.run(`!!(app?.plugins?.plugins?.[${JSON.stringify(ID)}]) && app.workspace.layoutReady`).catch(() => false)) break;
		await sleep(250);
	}
	await sleep(1500);
	await s.run(HELPERS);
	await s.run(`document.body.style.setProperty("--safe-area-inset-top", "${ANDROID.top}px");
		document.body.style.setProperty("--safe-area-inset-bottom", "${ANDROID.bottom}px"); true`);
	const phone = await s.run(`document.body.classList.contains("is-phone") && document.body.classList.contains("emulate-mobile")`);
	console.log(`  phone emulation: ${phone ? "on" : "OFF"}, insets top ${await s.run(`e2e.inset("top")`)}px / bottom ${await s.run(`e2e.inset("bottom")`)}px`);
	s.errors.length = 0;

	console.log("\nA. Shopping list (#3)");
	let listPath = "";

	await check("tapping a name ticks the row at once", async () => {
		listPath = await openShop();
		const [first] = await openRows();
		await tap(`e2e.row(${JSON.stringify(first)}).querySelector(".pantry-buy-main")`);
		await until(`e2e.row(${JSON.stringify(first)})?.classList.contains("is-done")`, "row not struck through", 400);
		expect(await s.run(`e2e.row(${JSON.stringify(first)}).querySelector(".pantry-tick").getAttribute("aria-pressed") === "true"`), "tick not pressed");
		expect(!(await s.run(`!!e2e.modal()`)), "a tap opened a modal");
	});

	await check("a ticked row stays put, then sinks below the open rows", async () => {
		await openShop();
		const rows = await openRows();
		const row = rows[0];
		const before = await s.run(`e2e.index(${JSON.stringify(row)})`);
		await tap(`e2e.row(${JSON.stringify(row)}).querySelector(".pantry-buy-main")`);
		await sleep(450);
		expect((await s.run(`e2e.index(${JSON.stringify(row)})`)) === before, "the row moved before the pause was over");
		await sleep(1200);
		// Done rows sink to the end of their own shelf, not of the whole shop:
		// walk down until the next shelf heading.
		const sunk = await s.run(`(() => { let el = e2e.row(${JSON.stringify(row)}).nextElementSibling;
			for (; el && !el.classList.contains("pantry-shelf"); el = el.nextElementSibling) {
				if (el.matches(".pantry-buy-row:not(.is-extra)") && !el.classList.contains("is-done")) return false;
			}
			return true; })()`);
		expect(sunk, "an open row of the same shelf still sits below the ticked one");
		expect(await s.run(`${plugin}.lists.all().find((l) => l.path === ${JSON.stringify(listPath)}).basket.has(${JSON.stringify(row)})`), "not in the basket");
	});

	await check("three quick taps sink together after the last one", async () => {
		await openShop();
		const keys = (await openRows()).slice(0, 3);
		expect(keys.length === 3, "fewer than three open rows left");
		const before = await s.run(`${JSON.stringify(keys)}.map((k) => e2e.index(k))`);
		for (const k of keys) {
			await tap(`e2e.row(${JSON.stringify(k)}).querySelector(".pantry-buy-main")`);
			await sleep(250);
		}
		await sleep(300);
		const during = await s.run(`${JSON.stringify(keys)}.map((k) => e2e.index(k))`);
		expect(JSON.stringify(during) === JSON.stringify(before), `rows moved while still settling: ${before} -> ${during}`);
		await sleep(1400);
		expect(await s.run(`${JSON.stringify(keys)}.every((k) => e2e.row(k).classList.contains("is-done"))`), "not all three are ticked");
	});

	await check("tapping a ticked row unticks it and it slides back", async () => {
		await openShop();
		const done = await s.run(`e2e.rows().filter((r) => r.classList.contains("is-done")).map((r) => r.dataset.flip)`);
		expect(done.length > 0, "nothing ticked to untick");
		const row = done[0];
		await tap(`e2e.row(${JSON.stringify(row)}).querySelector(".pantry-buy-main")`);
		await until(`!e2e.row(${JSON.stringify(row)})?.classList.contains("is-done")`, "still ticked", 1500);
		expect(!(await s.run(`${plugin}.lists.all().find((l) => l.path === ${JSON.stringify(listPath)}).basket.has(${JSON.stringify(row)})`)), "still in the basket");
	});

	await check("holding a name opens the product, without ticking", async () => {
		await openShop();
		const [row] = await openRows();
		const name = await s.run(`e2e.row(${JSON.stringify(row)}).querySelector(".pantry-buy-name").textContent`);
		await hold(`e2e.row(${JSON.stringify(row)}).querySelector(".pantry-buy-main")`);
		await until(`e2e.modal()?.querySelector(".pantry-sheet-name")?.textContent === ${JSON.stringify(name)}`, "no product sheet for the held row", 1500);
		await key("Escape", "Escape", 27);
		await sleep(300);
		expect(!(await s.run(`e2e.row(${JSON.stringify(row)}).classList.contains("is-done")`)), "holding also ticked the row");
	});

	await check("a touch scroll over the names ticks nothing", async () => {
		await openShop();
		const before = await s.run(`e2e.rows().filter((r) => r.classList.contains("is-done")).length`);
		const { x, y } = await at(`e2e.rows()[1].querySelector(".pantry-buy-main")`);
		await s.send("Input.synthesizeScrollGesture", { x, y, yDistance: -250, gestureSourceType: "touch", speed: 600 });
		await sleep(1300);
		const after = await s.run(`e2e.rows().filter((r) => r.classList.contains("is-done")).length`);
		expect(after === before, `scrolling ticked ${after - before} row(s)`);
		expect(!(await s.run(`!!e2e.modal()`)), "scrolling opened a modal");
	});

	await check("the round tick button still ticks", async () => {
		await openShop();
		const [row] = await openRows();
		await tap(`e2e.row(${JSON.stringify(row)}).querySelector(".pantry-tick")`);
		await until(`e2e.row(${JSON.stringify(row)})?.classList.contains("is-done")`, "tick button did nothing", 600);
	});

	await check("the amount button opens the stepper, not a tick", async () => {
		await openShop();
		const [row] = await openRows();
		await tap(`e2e.row(${JSON.stringify(row)}).querySelector("button.pantry-quantity")`);
		await until(`!!e2e.row(${JSON.stringify(row)})?.querySelector(".pantry-quantity-edit")`, "no stepper", 800);
		expect(!(await s.run(`e2e.row(${JSON.stringify(row)}).classList.contains("is-done")`)), "the amount button ticked the row");
	});

	await check("a loose item: tap ticks it off, hold edits it", async () => {
		await openShop();
		for (const name of ["Batteries", "Flowers"]) {
			await tap(`e2e.byText("button", "Add item")`);
			await until(`!!e2e.modal()?.querySelector("input")`, "Add item form did not open", 1500);
			await sleep(200);
			await type(name);
			await tap(`e2e.byText(".modal button", "Add")`);
			await until(`!e2e.modal()`, "the form did not close", 1500);
		}
		const extra = (name) => `e2e.all(".pantry-buy-row.is-extra").find((r) => r.textContent.includes(${JSON.stringify(name)}))`;
		await until(`!!(${extra("Batteries")}) && !!(${extra("Flowers")})`, "loose items not on the list", 1500);
		await tap(`${extra("Batteries")}.querySelector(".pantry-buy-main")`);
		await until(`${extra("Batteries")}?.classList.contains("is-done")`, "loose item not struck through", 400);
		await until(`!(${extra("Batteries")})`, "ticked loose item did not go away", 2500);
		await hold(`${extra("Flowers")}.querySelector(".pantry-buy-main")`);
		await until(`e2e.modal()?.querySelector(".pantry-sheet-name")?.textContent === "Flowers"`, "holding did not open the edit form", 1500);
	});

	console.log("\nB. Buttons clear the system bars (#2)");

	async function clearsBars(label, open) {
		await check(`${label}: buttons above the bottom bar, head below the top bar`, async () => {
			await open();
			await until(`!!e2e.modal()?.querySelector(".pantry-sheet-foot")`, "the sheet did not open", 2000);
			await sleep(400);
			const m = await s.run(`(() => {
				const foot = e2e.modal().querySelector(".pantry-sheet-foot");
				const lowest = Math.max(...Array.from(foot.querySelectorAll("button")).map((b) => b.getBoundingClientRect().bottom));
				const head = e2e.modal().querySelector(".pantry-sheet-head").getBoundingClientRect().top;
				return { lowest, head, height: window.innerHeight, bottom: e2e.inset("bottom"), top: e2e.inset("top") };
			})()`);
			expect(m.bottom > 0, "no bottom inset to test against (phone emulation off?)");
			expect(m.lowest <= m.height - m.bottom + 0.5, `lowest button ends at ${m.lowest}px; the bar starts at ${m.height - m.bottom}px`);
			expect(m.head >= m.top - 0.5, `head starts at ${m.head}px, under the ${m.top}px status bar`);
		});
	}

	await clearsBars("Add item", async () => {
		await openShop();
		await tap(`e2e.byText("button", "Add item")`);
	});
	await clearsBars("New product", () => s.run(quietly(command("new-product"))));
	await clearsBars("Product sheet", async () => {
		await openShop();
		const [row] = await openRows();
		await hold(`e2e.row(${JSON.stringify(row)}).querySelector(".pantry-buy-main")`);
	});

	console.log("\nC. Adding shops and recipes (#1)");

	await check("+ Shop on Shelves adds a shop and switches to it", async () => {
		await s.run(quietly(command("open-shelves")));
		await until(`!!document.querySelector("button.pantry-segment-item.is-add")`, "no + Shop chip", 2000);
		await tap(`document.querySelector("button.pantry-segment-item.is-add")`);
		await until(`!!e2e.modal()?.querySelector(".pantry-ask-input")`, "no name prompt", 1500);
		expect(await s.run(`e2e.byText(".modal button", "Add shop").disabled`), "Add shop is enabled while empty");
		await type("Bakery");
		await tap(`e2e.byText(".modal button", "Add shop")`);
		await until(`e2e.exists("Shops/Bakery.md")`, "Shops/Bakery.md was not created", 2000);
		// The shop chips are the row that holds "+ Shop"; the first row is the mode.
		await until(`document.querySelector("button.pantry-segment-item.is-add")?.parentElement.querySelector(".is-active")?.textContent === "Bakery"`, "Shelves did not switch to Bakery", 2000);
	});

	await check("cancelling the shop prompt creates nothing", async () => {
		const before = await s.run(`app.vault.getMarkdownFiles().length`);
		await tap(`document.querySelector("button.pantry-segment-item.is-add")`);
		await until(`!!e2e.modal()?.querySelector(".pantry-ask-input")`, "no name prompt", 1500);
		await type("Nope");
		await tap(`e2e.byText(".modal button", "Cancel")`);
		await sleep(400);
		expect((await s.run(`app.vault.getMarkdownFiles().length`)) === before, "a note appeared anyway");
	});

	await check("New recipe in the planner's picker writes and opens a recipe note", async () => {
		await s.run(quietly(command("open-planner")));
		await until(`!!document.querySelector(".pantry-slot-add")`, "no + in the planner", 3000);
		await tap(`document.querySelector(".pantry-slot-add")`);
		await until(`!!document.querySelector(".pantry-pick-modal button.pantry-new-recipe")`, "no New recipe in the picker", 1500);
		await tap(`document.querySelector(".pantry-pick-modal button.pantry-new-recipe")`);
		await until(`!document.querySelector(".pantry-pick-modal") && !!e2e.modal()?.querySelector(".pantry-ask-input")`, "picker did not hand over to the name prompt", 1500);
		await type("Test soup");
		await key("Enter", "Enter", 13);
		await until(`e2e.exists("Recipes/Test soup.md")`, "Recipes/Test soup.md was not created", 2000);
		const text = await s.run(`e2e.read("Recipes/Test soup.md")`);
		expect(/^servings:\s*$/m.test(text), "servings is not left empty");
		expect(text.includes("## Ingredients") && text.includes("## Method"), "headings missing");
		await until(`app.workspace.getActiveFile()?.path === "Recipes/Test soup.md"`, "the new recipe did not open", 2000);
	});

	await check("New recipe with an existing name opens it, no duplicate", async () => {
		const before = await s.run(`app.vault.getMarkdownFiles().length`);
		await s.run(quietly(command("open-home")));
		await s.run(`${command("new-recipe")}; true`);
		await until(`!!e2e.modal()?.querySelector(".pantry-ask-input")`, "no name prompt", 1500);
		await type("Test soup");
		await key("Enter", "Enter", 13);
		await until(`app.workspace.getActiveFile()?.path === "Recipes/Test soup.md"`, "the existing recipe did not open", 2000);
		expect((await s.run(`app.vault.getMarkdownFiles().length`)) === before, "a duplicate appeared");
	});

	await check("New shop and New recipe are commands", async () => {
		const ids = await s.run(`Object.keys(app.commands.commands)`);
		for (const id of ["new-shop", "new-recipe"]) expect(ids.includes(`${ID}:${id}`), `${id} missing`);
	});

	console.log("\nD. Tick boxes on the right (#3)");

	await check("the setting moves the tick to the right edge and back", async () => {
		await s.run(`app.setting.open(); app.setting.openTabById(${JSON.stringify(ID)}); true`);
		const toggle = `e2e.all(".setting-item").find((el) => el.querySelector(".setting-item-name")?.textContent === "Tick boxes on the right")?.querySelector(".checkbox-container")`;
		await until(`!!(${toggle})`, "no 'Tick boxes on the right' in the settings", 2000);
		await tap(toggle);
		await until(`${plugin}.settings.tickRight === true`, "the toggle did not save", 1500);
		await s.run(`app.setting.close(); true`);
		await openShop();
		const side = () => s.run(`(() => { const r = e2e.rows()[0];
			return r.querySelector(".pantry-tick").getBoundingClientRect().left > r.querySelector(".pantry-buy-main").getBoundingClientRect().left ? "right" : "left"; })()`);
		expect((await side()) === "right", "the tick is not on the right");
		await s.run(`${plugin}.settings.tickRight = false; ${plugin}.refreshViews(); true`);
		await sleep(300);
		expect((await side()) === "left", "the tick did not go back to the left");
	});

	console.log("\nE. To check and explanations (#3)");

	await check("To check lists never-counted products", async () => {
		await s.run(quietly(command("open-stock")));
		await until(`!!e2e.byText("button.pantry-segment-item", "To check")`, "no To check filter", 2000);
		await tap(`e2e.byText("button.pantry-segment-item", "To check")`);
		await sleep(500);
		const names = await s.run(`e2e.all(".pantry-stock-name").map((el) => el.textContent.trim())`);
		for (const name of ["Salt", "Black pepper"]) {
			expect(names.some((n) => n.startsWith(name)), `${name} is not in To check (saw: ${names.slice(0, 8).join(", ")})`);
		}
	});

	await check("Package size explains itself and follows the toggle", async () => {
		await s.run(quietly(command("new-product")));
		await until(`!!e2e.modal()?.querySelector(".pantry-sheet-hint")`, "no hint under Package size", 1500);
		const hint = () => s.run(`e2e.modal().querySelector(".pantry-sheet-hint").textContent`);
		expect(/package/i.test(await hint()), "the hint does not talk about packages");
		await tap(`e2e.byText(".modal button", "Amount does not matter")`);
		await sleep(200);
		expect(/salt/i.test(await hint()), "the hint did not change with the toggle");
	});

	await check("a new product note explains its fields in English", async () => {
		await s.run(quietly(command("new-product")));
		await until(`!!e2e.modal()?.querySelector("input")`, "New product did not open", 1500);
		await sleep(200);
		await type("Testmeel");
		await tap(`e2e.byText(".modal button", "Add")`);
		await until(`e2e.exists("Products/Testmeel.md")`, "Products/Testmeel.md was not created", 2000);
		const text = await s.run(`e2e.read("Products/Testmeel.md")`);
		expect(text.includes("What the fields mean"), "no English legend");
		expect(!/Wat staat hier|Deze tekst is van jou/.test(text), "Dutch text in the note");
	});

	await check("the plan block's comment is English", async () => {
		await s.run(quietly(command("open-planner")));
		await until(`!!document.querySelector(".pantry-slot-add")`, "no + in the planner", 3000);
		await tap(`document.querySelector(".pantry-slot-add")`);
		await until(`!!document.querySelector(".pantry-pick-modal .pantry-recipe-card")`, "no recipes in the picker", 1500);
		await tap(`document.querySelector(".pantry-pick-modal .pantry-recipe-card")`);
		await sleep(800);
		const notes = await s.run(`Promise.all(app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("Meal plans/")).map((f) => app.vault.read(f)))`);
		expect(notes.some((t) => t.includes("# Cupboard rewrites this block on every change.")), "no plan note with the English comment");
		expect(!notes.some((t) => t.includes("herschrijft")), "a plan note still has the Dutch comment");
	});

	console.log("\nF. Console");
	await check("no errors from Cupboard in the console", async () => {
		const ours = s.errors.filter((e) => /cupboard|pantry/i.test(e));
		expect(ours.length === 0, ours.slice(0, 3).join("\n      "));
	});

	s.close();
	killOurs();

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
	if (failed.length > 0) {
		console.log(`Screenshots of the failures: ${OUT}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	killOurs();
	process.exit(1);
});
