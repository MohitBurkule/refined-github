import './crapmeter-scores.css';

import batchedFunction from 'batched-function';
import cx from 'clsx';
import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import {$$optional, $optional, closestElementOptional} from 'select-dom';
import {CachedFunction} from 'webext-storage-cache';

import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import {getRepo} from '../github-helpers/index.js';
import {commitHashLinkInLists} from '../github-helpers/selectors.js';
import {statusBadgeSelector} from './jump-to-conversation-close-event.js';
import {
	type CrapmeterFunctionDetail,
	type CrapmeterResult,
	type CrapmeterSummary,
	analyze,
	cleanFilename,
	getServerUrl,
	isPythonFile,
	parseTouchedLines,
} from '../helpers/crapmeter.js';
import onetime from '../helpers/onetime.js';
import prListLink from '../helpers/pr-list-rows.js';
import observe from '../helpers/selector-observer.js';
import {withTooltipRef} from '../components/tooltip.js';

/*
The scores come from a local `crapmeter --serve`; see `helpers/crapmeter.ts` for why it
can't run in the page. Everything measured here is keyed by a sha, which is what makes
the cache safe to keep for a long time: a commit's content never changes, so neither
does its score. A miss costs one API call per changed Python file, so the cache is doing
most of the work — on a second visit to a PR nothing is fetched or measured at all.
*/

/** One API call per file adds up; a diff past this is summarised from its first files */
const maxFiles = 20;

type FileChange = {
	filename: string;
	status: string;
	patch?: string;
	sha: string;
};

/** `'no-python'` means "measured, and there was no Python in it" */
type Measurement = CrapmeterResult | 'no-python';

class ServerUnreachable extends Error {}

/*
A closed pull request whose branch was deleted still lists its files, but the blobs
behind them may no longer resolve. That is a fact about the pull request, not a bug, so
it gets its own chip rather than an error report.
*/
class SourceUnavailable extends Error {}

const warnOnce = onetime(async () => {
	console.warn(
		`Refined GitHub: crapmeter-scores found no server at ${await getServerUrl()}.`,
		'Start it with `crapmeter --serve`, or set the address in the Options page.',
	);
});

/*
Gating on the repo rather than the diff: a badge saying "n/a" on every commit of a Go
repo is noise, but the same badge on the one non-Python commit in a Python repo is
information.
*/
const repoUsesPython = new CachedFunction('crapmeter-repo-python', {
	async updater(_nameWithOwner: string): Promise<boolean> {
		const languages = await api.v3('languages');
		return Object.keys(languages).includes('Python');
	},
	maxAge: {days: 7},
	staleWhileRevalidate: {days: 30},
});

async function fetchSource(filename: string, ref: string): Promise<string> {
	const path = filename.split('/').map(segment => encodeURIComponent(segment)).join('/');
	const response = await api.v3(
		`contents/${path}?ref=${ref}`,
		{
			responseFormat: 'text',
			headers: {accept: 'application/vnd.github.raw'},
			ignoreHttpStatus: 404,
		},
	);
	if (response.httpStatus === 404) {
		throw new SourceUnavailable(`${filename} no longer resolves at ${ref}`);
	}

	return response.content as string;
}

/** Measures the Python among `changes`, reading each file as of `ref` */
async function measure(changes: FileChange[], ref: string): Promise<Measurement> {
	const python = changes
		.filter(change => isPythonFile(change.filename) && change.status !== 'removed')
		.slice(0, maxFiles);

	if (python.length === 0) {
		return 'no-python';
	}

	const sources = await Promise.all(
		python.map(async change => [change.filename, await fetchSource(change.filename, ref)] as const),
	);

	const result = await analyze({
		files: Object.fromEntries(sources),
		touched: Object.fromEntries(
			python.map(change => [change.filename, parseTouchedLines(change.patch)]),
		),
	});

	// Not cached: the server being down is a state of this machine, not of this commit
	if (!result) {
		throw new ServerUnreachable('crapmeter server did not answer');
	}

	return result;
}

/** Keyed by sha alone: the same commit scores the same wherever it's shown */
const commitScore = new CachedFunction('crapmeter-commit', {
	async updater(commitSha: string): Promise<Measurement> {
		const {files} = await api.v3(`commits/${commitSha}`);
		return measure((files ?? []) as FileChange[], commitSha);
	},
	maxAge: {days: 100},
});

/** Keyed by head sha, so a push invalidates it without any expiry logic */
const pullRequestScore = new CachedFunction('crapmeter-pr', {
	async updater(_headSha: string, pullNumber: number): Promise<Measurement> {
		const files = await api.v3(`pulls/${pullNumber}/files?per_page=100`) as unknown as FileChange[];
		return measure(files, _headSha);
	},
	cacheKey: ([headSha]) => headSha,
	maxAge: {days: 100},
});

/*
The score is keyed by head sha, but a list row only knows the PR number, and finding the
head sha costs the very request the cache is meant to avoid. This mirror is written
after a successful measurement so that a revisit to the list is free; it is deliberately
short-lived, because unlike a sha a PR number does not identify a fixed diff.
*/
const pullRequestScoreByNumber = new CachedFunction('crapmeter-pr-number', {
	async updater(_pullNumber: number): Promise<Measurement> {
		throw new Error('Only ever read from cache');
	},
	maxAge: {hours: 12},
});

/** Keyed by blob sha, which is the content: a perfect cache key */
const fileScore = new CachedFunction('crapmeter-file', {
	async updater(blobSha: string, filename: string, ref: string): Promise<Measurement> {
		return measure([{filename, status: 'modified', sha: blobSha}], ref);
	},
	cacheKey: ([blobSha]) => blobSha,
	maxAge: {days: 100},
});

/*
A grade for one function. The server grades a whole payload from its highest-ranked
finding, which says nothing about an individual function, so this reads the one number
that is per-function and comparable: CRAP. The boundaries are crap4j's own - 30 is the
threshold the metric was published with - not invented here.
*/
function gradeFunction(function_: CrapmeterFunctionDetail): CrapmeterSummary['grade'] {
	if (function_.crap <= 10) {
		return 'A';
	}

	if (function_.crap <= 30) {
		return 'B';
	}

	if (function_.crap <= 60) {
		return 'C';
	}

	return function_.crap <= 100 ? 'D' : 'F';
}

function describeFunction(function_: CrapmeterFunctionDetail): string {
	return [
		`${function_.qualname} — CRAP ${function_.crap}`,
		`cyclomatic ${function_.cyclomatic}, cognitive ${function_.cognitive}, nesting ${function_.max_nesting}`,
		`${function_.length} statements, ${function_.arg_count} argument(s)`,
	].join('\n');
}

/*
The line-number cell for a line of the *new* file.

The React diff labels its cells `new-diff-line-number` / `old-diff-line-number`, which
answers the question outright. The legacy diff has no such class and simply puts the old
number before the new one, so there the last of the two is the new one.
*/
function newFileLineCell(container: Element, line: number): Element | undefined {
	// Optional: a function whose signature sits outside the shown hunks has no cell here
	const cells = $$optional(`[data-line-number="${line}"]`, container);
	return cells.find(cell => cell.classList.contains('new-diff-line-number')) ?? cells.at(-1);
}

/** Marks each measured function at its `def` line, where the diff shows that line */
function annotateFunctions(container: Element, functions: CrapmeterFunctionDetail[]): void {
	for (const function_ of functions) {
		const cell = newFileLineCell(container, function_.line);
		// Absent whenever the function's signature is outside the shown hunks
		if (!cell || cell.classList.contains('rgh-crapmeter-marked')) {
			continue;
		}

		cell.classList.add('rgh-crapmeter-marked');
		// `parentElement` is null only for the document root, which a line cell never is
		const row = closestElementOptional('tr', cell) ?? cell.parentElement!;
		row.classList.add('rgh-crapmeter-fn-row', `rgh-crapmeter-fn-${gradeFunction(function_)}`);

		// The code cell, so the marker sits beside the signature rather than the gutter
		// The code is the one cell in the row that isn't a line-number gutter
		const codeCell = $optional([
			'.blob-code', // Legacy view
			'td:not([data-line-number]):last-child', // React view
		], row) ?? cell;
		codeCell.append(
			<span
				ref={withTooltipRef(describeFunction(function_))}
				className={cx('rgh-crapmeter-fn', `rgh-crapmeter-${gradeFunction(function_)}`)}
			>
				{gradeFunction(function_)} · cc {function_.cyclomatic}
			</span>,
		);
	}
}

// -- rendering -----------------------------------------------------------

function describe(summary: CrapmeterSummary): string {
	const {counts, worstFunctions} = summary;
	const lines = [
		`crapmeter ${summary.grade} · ${summary.functions} function(s) in ${summary.files} file(s)`,
		`max cc ${summary.maxCc}, median cc ${summary.medianCc}, worst CRAP ${summary.maxCrap}`,
		`${counts.FAIL} FAIL, ${counts.WARN} WARN, ${counts.INFO} INFO`,
	];

	if (worstFunctions.length > 0) {
		const worst = worstFunctions[0];
		lines.push(`Worst: ${worst.qualname} (CRAP ${worst.crap}, cc ${worst.cyclomatic}) ${worst.file}:${worst.line}`);
	}

	for (const finding of summary.topFindings.slice(0, 3)) {
		lines.push(`${finding.severity} ${finding.rule} — ${finding.file}:${finding.line}`);
	}

	return lines.join('\n');
}

/*
Commit lists put one of these on every row, so they get the grade alone; everywhere else
there is a single chip and room to say what it is. The tooltip carries the detail in
both cases, so nothing is lost by the short form.
*/
type Size = 'compact' | 'full';

// Not a JSX component: dom-chef calls those without props
function buildChip(measurement: Measurement, size: Size): React.JSX.Element {
	if (measurement === 'no-python') {
		return (
			<span
				ref={withTooltipRef('crapmeter measures Python; this change has none')}
				className="rgh-crapmeter rgh-crapmeter-na"
			>
				{size === 'compact' ? '–' : 'crapmeter n/a'}
			</span>
		);
	}

	const {summary} = measurement;
	return (
		<span
			ref={withTooltipRef(describe(summary))}
			className={cx('rgh-crapmeter', `rgh-crapmeter-${summary.grade}`)}
		>
			{size === 'compact' ? summary.grade : `crapmeter ${summary.grade}`}
			{size === 'full' && <span className="rgh-crapmeter-detail">cc {summary.maxCc}</span>}
		</span>
	);
}

function buildPendingChip(size: Size): React.JSX.Element {
	return (
		<span
			ref={withTooltipRef('crapmeter is measuring this change…')}
			className="rgh-crapmeter rgh-crapmeter-pending"
		>
			{size === 'compact' ? '…' : 'crapmeter …'}
		</span>
	);
}

function buildErrorChip(reason: string): React.JSX.Element {
	return (
		<span ref={withTooltipRef(reason)} className="rgh-crapmeter rgh-crapmeter-error">
			crapmeter ✕
		</span>
	);
}

/*
Renders once per element, and shows its work: a pending chip goes in immediately and is
swapped for the result. Measuring a commit costs an API call per changed Python file
plus the analysis, so without this the row simply looks like the feature is off.
*/
async function place(
	anchor: Element,
	get: () => Promise<Measurement>,
	insert: (chip: React.JSX.Element) => void,
	size: Size = 'full',
): Promise<void> {
	if (anchor.classList.contains('rgh-crapmeter-done')) {
		return;
	}

	anchor.classList.add('rgh-crapmeter-done');
	const pending = buildPendingChip(size);
	insert(pending);

	try {
		pending.replaceWith(buildChip(await get(), size));
	} catch (error) {
		if (error instanceof SourceUnavailable) {
			pending.replaceWith(buildErrorChip(`crapmeter could not read this diff: ${error.message}`));
			return;
		}

		if (!(error instanceof ServerUnreachable)) {
			pending.replaceWith(buildErrorChip(`crapmeter failed: ${String(error)}`));
			throw error;
		}

		void warnOnce();
		pending.replaceWith(buildErrorChip(
			'No crapmeter server. Start it with `crapmeter --serve`, or set the address in the Options page.',
		));
	}
}

/*
A pull request list is the expensive surface: each uncached row costs a `pulls/N`, a
`pulls/N/files`, and one content request per changed Python file. So rows are measured
only once they scroll into view, a few at a time, and rows already in the cache render
without a single request.
*/
const listConcurrency = 3;
let activeRequests = 0;
const waitingForSlot: Array<() => void> = [];

async function withSlot<T>(run: () => Promise<T>): Promise<T> {
	if (activeRequests >= listConcurrency) {
		await new Promise<void>(resolve => {
			waitingForSlot.push(resolve);
		});
	}

	activeRequests++;
	try {
		return await run();
	} finally {
		activeRequests--;
		waitingForSlot.shift()?.();
	}
}

async function whenVisible(element: Element, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const observer = new IntersectionObserver(entries => {
			if (entries.every(entry => !entry.isIntersecting)) {
				return;
			}

			observer.disconnect();
			resolve();
		});
		observer.observe(element);
		signal.addEventListener('abort', () => {
			observer.disconnect();
		}, {once: true});
	});
}

// -- surfaces ------------------------------------------------------------

function shaOf(link: HTMLAnchorElement): string | undefined {
	const sha = link.pathname.split('/').pop() ?? '';
	return /^[\da-f]{40}$/.test(sha) ? sha : undefined;
}

async function addToCommitRows(links: HTMLAnchorElement[]): Promise<void> {
	await Promise.all(links.map(async link => {
		const sha = shaOf(link);
		if (!sha) {
			return;
		}

		const row = closestElementOptional('.text-right', link) ?? link;

		await place(link, async () => commitScore.get(sha), chip => {
			row.before(chip);
		}, 'compact');
	}));
}

async function addToCommitPage(container: HTMLElement): Promise<void> {
	const sha = location.pathname.split('/').pop()!;
	await place(container, async () => commitScore.get(sha), chip => {
		container.append(chip);
	});
}

async function addToPullRequest(stateLabel: HTMLElement): Promise<void> {
	const number = Number(location.pathname.split('/', 5)[4]);
	const {head} = await api.v3(`pulls/${number}`);
	await place(stateLabel, async () => pullRequestScore.get(head.sha, number), chip => {
		stateLabel.after(chip);
	});
}

/*
The Files tab needs the head sha and the file list, and it needs them once for the page
rather than once per file header. `onetime` makes the first header pay for all of them.
*/
const currentPullRequest = onetime(async () => {
	const number = Number(location.pathname.split('/', 5)[4]);
	const [{head}, files] = await Promise.all([
		api.v3(`pulls/${number}`),
		api.v3(`pulls/${number}/files?per_page=100`) as unknown as Promise<FileChange[]>,
	]);
	return {number, headSha: head.sha as string, files};
});

/** The Files tab: a chip per file header, and a marker on every function in its diff */
async function addToFileHeader(header: HTMLElement): Promise<void> {
	// `data-path` is absent in the React view, where the name is only in the header text
	const nameElement = $optional([
		'[class^="DiffFileHeader-module__file-name"]', // React view
		'.file-info a', // Legacy view
	], header);
	// Null while the diff is still streaming in, and on headers for non-file rows
	const filename = cleanFilename(header.dataset.path ?? nameElement?.textContent ?? undefined);
	if (!filename || !isPythonFile(filename)) {
		return;
	}

	const {headSha, files} = await currentPullRequest();
	const change = files.find(file => file.filename === filename);
	if (!change) {
		return;
	}

	// The whole file, not just its hunks: the diff container holds both
	const fileContainer = closestElementOptional(
		['[class*="DiffFileHeader-module"]', '.file', '.js-file'].join(','),
		header,
	) ?? header.parentElement;

	await place(header, async () => {
		const measurement = await fileScore.get(change.sha, filename, headSha);
		if (measurement !== 'no-python' && fileContainer) {
			annotateFunctions(fileContainer, measurement.functions);
		}

		return measurement;
	}, chip => {
		header.append(chip);
	});
}

/** One compact chip per row on a pull request list, measured lazily */
function addToPrListRow(link: HTMLAnchorElement, signal: AbortSignal): void {
	const number = Number(link.pathname.split('/', 5)[4]);
	if (!Number.isSafeInteger(number)) {
		return;
	}

	void place(link, async () => {
		const cached = await pullRequestScoreByNumber.getCached(number);
		if (cached) {
			return cached;
		}

		await whenVisible(link, signal);
		return withSlot(async () => {
			const {head} = await api.v3(`pulls/${number}`);
			const summary = await pullRequestScore.get(head.sha, number);
			await pullRequestScoreByNumber.setCached(summary, number);
			return summary;
		});
	}, chip => {
		link.after(chip);
	}, 'compact');
}

/*
A compact grade beside each Python file in the Files tab's tree.

The row's `id` is the file's full repo path, so there is no need to reassemble one from
the visible labels - which cannot tell two `database.py` rows apart anyway.
*/
async function addToFileTreeItem(item: HTMLElement): Promise<void> {
	const filename = item.id;
	if (!filename || !isPythonFile(filename)) {
		return;
	}

	const {headSha, files} = await currentPullRequest();
	const change = files.find(file => file.filename === filename);
	if (!change) {
		return;
	}

	// Beside the name, inside the row's content cell: the row itself is a CSS grid, and
	// anything appended straight to it lands in an unplaced area and gets clipped
	const nameCell = $optional('[class*="TreeViewItemContent-"]', item) ?? item;
	await place(item, async () => fileScore.get(change.sha, filename, headSha), chip => {
		nameCell.append(chip);
	}, 'compact');
}

async function init(signal: AbortSignal): Promise<void> {
	const repo = getRepo();
	if (!repo) {
		return;
	}

	if (!await repoUsesPython.get(repo.nameWithOwner)) {
		console.warn(`Refined GitHub: crapmeter-scores is off, ${repo.nameWithOwner} reports no Python.`);
		return;
	}

	if (pageDetect.isPRFiles()) {
		observe(
			[
				'[class^="DiffFileHeader-module__diff-file-header"]',
				'.file-header',
			],
			addToFileHeader,
			{signal},
		);

		// Leaf entries only: a folder's `textContent` is every name beneath it
		observe('[role="treeitem"]:not(:has([role="treeitem"]))', addToFileTreeItem, {signal});

		// The whole-PR chip belongs at the top of this page too, not just the conversation
		observe(statusBadgeSelector, addToPullRequest, {signal});
		return;
	}

	if (pageDetect.isCommit()) {
		observe(
			[
				'[class*="__CommitAttributionContainer"] + .text-mono', // React view
				'.commit-meta', // Legacy view
			],
			addToCommitPage,
			{signal},
		);
		return;
	}

	if (pageDetect.isPRConversation()) {
		// The PR's own state label ("Open"/"Merged"), the one anchor both PR views share
		observe(statusBadgeSelector, addToPullRequest, {signal});
	}

	if (pageDetect.isPRList()) {
		observe(prListLink, link => {
			addToPrListRow(link, signal);
		}, {signal});
		return;
	}

	observe(commitHashLinkInLists, batchedFunction(addToCommitRows, {delay: 100}), {signal});
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isPRConversation,
		pageDetect.isPRCommitList,
		pageDetect.isPRCommit,
		pageDetect.isPRFiles,
		pageDetect.isCommitList,
		pageDetect.isCommit,
		pageDetect.isPRList,
	],
	requiresToken: true,
	init,
});

/*

Test URLs:

- isPRConversation: https://github.com/psf/requests/pull/6731
- isPRFiles: https://github.com/psf/requests/pull/6731/files
- isPRCommitList: https://github.com/psf/requests/pull/6731/commits
- isCommitList: https://github.com/psf/requests/commits/main
- isCommit: https://github.com/psf/requests/commit/0e322af87745eff34caffe4df68456ebc20d9068
- Non-Python repo (feature stays off): https://github.com/refined-github/refined-github/pull/9523

*/
