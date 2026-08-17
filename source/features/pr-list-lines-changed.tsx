import batchedFunction from 'batched-function';
import * as pageDetect from 'github-url-detection';
import {objectEntries} from 'ts-extras';

import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import prListLink from '../helpers/pr-list-rows.js';
import observe from '../helpers/selector-observer.js';
import {buildDiffStat} from './pr-commit-lines-changed.js';

/*
The same diffstat `pr-commit-lines-changed` puts on commits, on the rows of a pull
request list. Every row on the page is resolved by a single GraphQL query, so the whole
list costs one request no matter how long it is.
*/

type Changes = [additions: number, deletions: number, updatedAt: string];

async function fetchChanges(numbers: number[]): Promise<Map<number, Changes>> {
	const {repository} = await api.v4(`
		repository() {
			${
				numbers.map(number => `
					${api.escapeKey(number)}: pullRequest(number: ${number}) {
						additions
						deletions
						updatedAt
					}
				`).join('\n')
			}
		}
	`);

	const changes = new Map<number, Changes>();
	for (const [key, pullRequest] of objectEntries(repository as AnyObject)) {
		// A pull request resolves to null when it's been deleted or moved
		if (pullRequest) {
			changes.set(Number(key.slice(1)), [
				pullRequest.additions,
				pullRequest.deletions,
				pullRequest.updatedAt,
			]);
		}
	}

	return changes;
}

function numberOf(link: HTMLAnchorElement): number | undefined {
	const number = Number(link.pathname.split('/', 5)[4]);
	return Number.isSafeInteger(number) ? number : undefined;
}

async function addDiffStats(links: HTMLAnchorElement[]): Promise<void> {
	const rows = links
		.map(link => ({link, number: numberOf(link)}))
		.filter((row): row is {link: HTMLAnchorElement; number: number} => row.number !== undefined);

	if (rows.length === 0) {
		return;
	}

	const changes = await fetchChanges([...new Set(rows.map(row => row.number))]);
	for (const {link, number} of rows) {
		const change = changes.get(number);
		if (change) {
			const [additions, deletions, updatedAt] = change;
			link.after(buildDiffStat(additions, deletions, updatedAt, 'd-md-inline-block d-none'));
		}
	}
}

function init(signal: AbortSignal): void {
	observe(prListLink, batchedFunction(addDiffStats, {delay: 100}), {signal});
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isRepoPRList,
	],
	requiresToken: true,
	init,
});

/*

Test URLs:

- isRepoPRList: https://github.com/refined-github/refined-github/pulls

*/
