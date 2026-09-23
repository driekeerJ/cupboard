/**
 * Cuts a release: one version number in four files, one commit, one tag.
 *
 *   node scripts/release.mjs 1.0.2
 *   git push origin main 1.0.2
 *
 * Obsidian reads `version` from manifest.json and downloads the release whose
 * tag equals it, without a `v`. package.json and its lockfile carry the same
 * number so nothing drifts, and versions.json maps the version to the
 * minimum Obsidian it needs. Not `npm version`: its "version" hook did not
 * fire here, which left manifest.json behind twice, and the tag guard in the
 * release workflow then refused the build.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
	console.error("Usage: node scripts/release.mjs <x.y.z>");
	process.exit(1);
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

if (git("status", "--porcelain")) {
	console.error("The working tree is not clean; commit or stash first.");
	process.exit(1);
}
if (git("tag", "--list", version)) {
	console.error(`Tag ${version} already exists.`);
	process.exit(1);
}

function edit(name, transform, indent) {
	const path = join(ROOT, name);
	const json = JSON.parse(readFileSync(path, "utf8"));
	transform(json);
	writeFileSync(path, JSON.stringify(json, null, indent) + "\n");
	console.log(`  ${name}`);
}

edit("package.json", (json) => { json.version = version; }, "  ");
edit("package-lock.json", (json) => {
	json.version = version;
	if (json.packages?.[""]) json.packages[""].version = version;
}, "  ");
let minAppVersion = "";
edit("manifest.json", (json) => {
	json.version = version;
	minAppVersion = json.minAppVersion;
}, "\t");
edit("versions.json", (json) => { json[version] = minAppVersion; }, "\t");

git("add", "package.json", "package-lock.json", "manifest.json", "versions.json");
git("commit", "-q", "-m", `Release ${version}`);
git("tag", version);

console.log(`\nCommitted and tagged ${version}. Publish with:\n  git push origin main ${version}`);
