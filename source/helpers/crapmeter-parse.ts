/*
The parts of the crapmeter helper that touch nothing but their arguments.

Split out from `crapmeter.ts` so that tests (and any other caller) can use them without
importing `options-storage.js`, which needs a live `chrome` global at module load.
*/

/** Added line numbers, per file, from a unified diff hunk header */
export function parseTouchedLines(patch: string | undefined): number[] {
	if (!patch) {
		return [];
	}

	const lines: number[] = [];
	let cursor = 0;
	for (const line of patch.split('\n')) {
		const header = /^@@ -\S+ \+(?<start>\d+)(?:,\d+)? @@/.exec(line);
		if (header) {
			cursor = Number(header.groups!.start);
			continue;
		}

		if (line.startsWith('+') && !line.startsWith('+++')) {
			lines.push(cursor);
			cursor++;
		} else if (!line.startsWith('-') && !line.startsWith('\\')) {
			cursor++;
		}
	}

	return lines;
}

export function isPythonFile(filename: string): boolean {
	return filename.endsWith('.py');
}

/*
GitHub wraps a diff's file name in bidi isolation marks so that a right-to-left path
cannot reorder the surrounding UI. They are invisible, they survive `trim()`, and they
leave the name ending in U+200E rather than `.py` - which silently fails every extension
check here.
*/
export function cleanFilename(raw: string | undefined): string | undefined {
	// Undefined whenever the header has no name element yet
	if (raw === undefined) {
		return undefined;
	}

	return raw.replaceAll(/[\u{200B}-\u{200F}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]/gu, '').trim();
}
