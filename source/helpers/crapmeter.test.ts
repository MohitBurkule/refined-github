import {expect, test} from 'vitest';

import {cleanFilename, isPythonFile, parseTouchedLines} from './crapmeter-parse.js';

test('parseTouchedLines returns nothing without a patch', () => {
	expect(parseTouchedLines(undefined)).toStrictEqual([]);
	expect(parseTouchedLines('')).toStrictEqual([]);
});

test('parseTouchedLines numbers added lines from the hunk header', () => {
	const patch = [
		'@@ -1,3 +1,4 @@',
		' import os',
		'+import sys',
		' ',
		' x = 1',
	].join('\n');
	expect(parseTouchedLines(patch)).toStrictEqual([2]);
});

test('parseTouchedLines skips removed lines without advancing the cursor', () => {
	const patch = [
		'@@ -10,4 +10,3 @@',
		' keep',
		'-gone',
		'-also gone',
		'+replacement',
	].join('\n');
	expect(parseTouchedLines(patch)).toStrictEqual([11]);
});

test('parseTouchedLines handles several hunks', () => {
	const patch = [
		'@@ -1,2 +1,3 @@',
		' a',
		'+b',
		'@@ -50,2 +51,3 @@',
		' c',
		'+d',
	].join('\n');
	expect(parseTouchedLines(patch)).toStrictEqual([2, 52]);
});

test('parseTouchedLines handles a single-line hunk header', () => {
	expect(parseTouchedLines('@@ -0,0 +7 @@\n+new line')).toStrictEqual([7]);
});

test('parseTouchedLines ignores the no-newline marker', () => {
	const patch = '@@ -1 +1,2 @@\n a\n+b\n\\ No newline at end of file';
	expect(parseTouchedLines(patch)).toStrictEqual([2]);
});

test('isPythonFile', () => {
	expect(isPythonFile('src/pkg/mod.py')).toBe(true);
	expect(isPythonFile('readme.md')).toBe(false);
	expect(isPythonFile('mod.pyi')).toBe(false);
	expect(isPythonFile('.python')).toBe(false);
});

test('cleanFilename strips the bidi marks GitHub wraps diff file names in', () => {
	// Exactly what the Files tab renders: U+200E on both sides
	expect(cleanFilename('‎fc_api/modules/abac/resources_team.py‎'))
		.toBe('fc_api/modules/abac/resources_team.py');
});

test('cleanFilename leaves a plain name alone', () => {
	expect(cleanFilename('src/pkg/mod.py')).toBe('src/pkg/mod.py');
});

test('cleanFilename passes nothing through as undefined', () => {
	expect(cleanFilename(undefined)).toBe(undefined);
});

test('a bidi-wrapped name is only Python once cleaned', () => {
	const raw = '‎resources_team.py‎';
	expect(isPythonFile(raw)).toBe(false);
	expect(isPythonFile(cleanFilename(raw)!)).toBe(true);
});
