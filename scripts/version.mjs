/**
 * Keeps manifest.json and versions.json in step with package.json.
 *
 * Runs from `npm version x.y.z`: npm bumps package.json first, then calls this
 * through the "version" script, which also stages the two files so they land
 * in the same commit and under the same tag. Obsidian reads the version from
 * manifest.json and the tag must match it exactly, so the three cannot drift.
 * The tag carries no `v` (see .npmrc): Obsidian compares it literally.
 */
import { readFileSync, writeFileSync } from "node:fs";

// From package.json on disk, not `npm_package_version`: npm fills that
// environment variable when it starts, so during `npm version` it still
// holds the old number.
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
manifest.version = version;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[version] = manifest.minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

console.log(`manifest.json and versions.json now say ${version}`);
