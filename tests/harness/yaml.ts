/**
 * The YAML the harness reads and writes, shaped like Obsidian's.
 *
 * Obsidian's `parseYaml` and `stringifyYaml` are js-yaml underneath, but
 * js-yaml may not appear in a plugin's package.json: the community
 * directory's review flags it, because a plugin should use Obsidian's copy.
 * The harness has no Obsidian, so it uses the `yaml` package and bends its
 * output towards what js-yaml writes: single quotes, no line folding, block
 * sequences indented under their key. What matters is that a note the
 * harness writes reads back identically; the tests that pin exact text pin
 * the plugin's own serialisers, not this file.
 */
import { parse, stringify } from "yaml";

export function load(text: string): unknown {
	return parse(text, { schema: "core" });
}

export function dump(value: unknown): string {
	return stringify(value, {
		lineWidth: 0,
		singleQuote: true,
		indent: 2,
		indentSeq: true,
		nullStr: "null",
		defaultKeyType: "PLAIN",
		defaultStringType: "PLAIN",
	});
}
