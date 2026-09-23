/**
 * Keeps manifest.json and versions.json in step with package.json.
 *
 * Runs from `npm version x.y.z`: npm bumps package.json first, then calls this
 * through the "version" script, which also stages the two files so they land
 * in the same commit and under the same tag. Obsidian reads the version from
 * manifest.json and the tag must match it exactly, so the three cannot drift.
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.npm_package_version;
if (!version) {
	console.error("Run this through `npm version`, not by hand.");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

console.log(`manifest.json and versions.json now say ${version}`);
