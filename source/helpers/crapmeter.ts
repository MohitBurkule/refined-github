/*
Talks to a local `crapmeter --serve` instance.

crapmeter is a Python tool that parses Python with Python's own `ast`; there is no
faithful way to run it in a content script. So it runs on the user's machine and this
is the wire to it. The request goes through the background worker because github.com's
CSP blocks a page-context fetch to localhost, and because the extension's host
permission is what lets it skip CORS.

Everything here degrades to `undefined` rather than throwing: the server not running is
the normal case, not an error.
*/

import {messageRuntime} from 'webext-msg';

import optionsStorage from '../options-storage.js';

export type CrapmeterFinding = {
	rule: string;
	severity: 'FAIL' | 'WARN' | 'INFO';
	file: string;
	line: number;
	subject: string;
	detail: string;
	score: number;
};

export type CrapmeterFunction = {
	file: string;
	line: number;
	qualname: string;
	crap: number;
	cyclomatic: number;
	length: number;
};

/** Every function the server measured, not just the worst few in the summary */
export type CrapmeterFunctionDetail = CrapmeterFunction & {
	end_line: number;
	cognitive: number;
	max_nesting: number;
	arg_count: number;
	is_test: boolean;
};

export type CrapmeterResult = {
	summary: CrapmeterSummary;
	functions: CrapmeterFunctionDetail[];
};

export type CrapmeterSummary = {
	files: number;
	functions: number;
	classes: number;
	medianCc: number;
	maxCc: number;
	maxCrap: number;
	counts: {FAIL: number; WARN: number; INFO: number};
	topScore: number;
	grade: 'A' | 'B' | 'C' | 'D' | 'F';
	worstFunctions: CrapmeterFunction[];
	topFindings: CrapmeterFinding[];
};

export type AnalyzeRequest = {
	files: Record<string, string>;
	touched?: Record<string, number[]>;
};

/** What the background worker sends back: never throws across the message boundary */
export type CrapmeterResponse =
	| ({ok: true} & CrapmeterResult)
	| {ok: false; error: string};

export const defaultServerUrl = 'http://127.0.0.1:8731';

export async function getServerUrl(): Promise<string> {
	const {crapmeterUrl} = await optionsStorage.getAll();
	return (crapmeterUrl || defaultServerUrl).replace(/\/$/, '');
}

/** `undefined` when the server isn't running or the payload was rejected */
export async function analyze(request: AnalyzeRequest): Promise<CrapmeterResult | undefined> {
	if (Object.keys(request.files).length === 0) {
		return undefined;
	}

	const response: CrapmeterResponse = await messageRuntime({crapmeterAnalyze: request});
	if (!response.ok) {
		// Distinguishes "server is down" from "server rejected this payload", which
		// otherwise both render as nothing at all
		console.warn('Refined GitHub: crapmeter server said:', response.error);
		return undefined;
	}

	return {summary: response.summary, functions: response.functions};
}

export async function isServerReachable(): Promise<boolean> {
	const response: {ok: boolean} = await messageRuntime({crapmeterHealth: {}});
	return response.ok;
}

export {cleanFilename, isPythonFile, parseTouchedLines} from './crapmeter-parse.js';
