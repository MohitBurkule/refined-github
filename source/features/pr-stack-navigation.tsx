import React from 'dom-chef';
import * as pageDetect from 'github-url-detection';
import {$$} from 'select-dom';

import features from '../feature-manager.js';
import api from '../github-helpers/api.js';
import {parseReferenceRaw} from '../github-helpers/pr-branches.js';
import observe from '../helpers/selector-observer.js';
import {stateIcon} from './show-associated-branch-prs-on-fork.js';

type StackedPr = {number: number; url: string; state: keyof typeof stateIcon};

const stateColor = {
	/* eslint-disable @typescript-eslint/naming-convention -- The same case as in the API response */
	OPEN: 'color-fg-success',
	CLOSED: 'color-fg-danger',
	MERGED: 'color-fg-done',
	DRAFT: '',
	/* eslint-enable @typescript-eslint/naming-convention */
};

function toStackedPr(pr: AnyObject): StackedPr {
	const state: keyof typeof stateIcon = pr.merged_at
		? 'MERGED'
		: (pr.draft && pr.state === 'open' ? 'DRAFT' : pr.state.toUpperCase());
	return {number: pr.number, url: pr.html_url as string, state};
}

// The base branch is always in the repo being viewed, so this never needs an owner prefix
async function findPrsByBase(branch: string): Promise<StackedPr[]> {
	/* eslint-disable-next-line @typescript-eslint/naming-convention -- Required by the GitHub REST API */
	const query = new URLSearchParams({base: branch, state: 'open', per_page: '10'});
	const prs = await api.v3(`pulls?${query}`) as any as AnyObject[];
	return prs.map(pr => toStackedPr(pr));
}

// The head branch's owner can differ on fork PRs, so it travels with the branch name
async function findPrsByHead(owner: string, branch: string): Promise<StackedPr[]> {
	/* eslint-disable-next-line @typescript-eslint/naming-convention -- Required by the GitHub REST API */
	const query = new URLSearchParams({head: `${owner}:${branch}`, state: 'all', per_page: '5'});
	const prs = await api.v3(`pulls?${query}`) as any as AnyObject[];
	return prs.map(pr => toStackedPr(pr));
}

// Not a JSX component: dom-chef calls those without props
function buildStackLink(pr: StackedPr): React.JSX.Element {
	const StateIcon = stateIcon[pr.state];
	return (
		<a
			data-issue-and-pr-hovercards-enabled
			href={pr.url}
			className="btn btn-sm ml-2 tmp-ml-2 rgh-pr-stack-navigation"
			data-hovercard-type="pull_request"
			data-hovercard-url={pr.url + '/hovercard'}
		>
			<StateIcon className={stateColor[pr.state]} /> <span>#{pr.number}</span>
		</a>
	);
}

function parseBranchAnchor(anchor: HTMLElement): ReturnType<typeof parseReferenceRaw> {
	return parseReferenceRaw(anchor.title || anchor.nextElementSibling!.textContent, anchor.textContent);
}

async function addStackLinks(summaryRow: HTMLElement): Promise<void> {
	const [baseAnchor, headAnchor] = $$('a[class^="PullRequestBranchName"]', summaryRow);
	if (!baseAnchor || !headAnchor) {
		return;
	}

	const base = parseBranchAnchor(baseAnchor);
	const head = parseBranchAnchor(headAnchor);

	const [parentPrs, childPrs] = await Promise.all([
		findPrsByHead(base.owner, base.branch),
		findPrsByBase(head.branch),
	]);

	// A base branch can have more than one PR pointing at it over time (closed, reopened…);
	// the currently open one is the actual parent, otherwise fall back to the most recent
	const parentPr = parentPrs.find(pr => pr.state === 'OPEN') ?? parentPrs[0];
	if (parentPr) {
		baseAnchor.after(buildStackLink(parentPr));
	}

	// Multiple PRs can be stacked on top of the same branch
	if (childPrs.length > 0) {
		headAnchor.after(...childPrs.map(pr => buildStackLink(pr)));
	}
}

async function init(signal: AbortSignal): Promise<void> {
	observe('.d-flex[class*="PullRequestHeaderSummary"]', addStackLinks, {signal});
}

void features.add(import.meta.url, {
	include: [
		pageDetect.isPR,
	],
	requiresToken: true,
	init,
});

/*

Test URLs:

https://github.com/refined-github/refined-github/pull/9913

*/
