/*
The title link of every pull request row, whatever its state.

`openPrsListLink` in `github-helpers/selectors.ts` matches on the open and draft state
icons by design, so it skips merged and closed rows. These match the row itself and let
the state be whatever it is.
*/
const prListLink = [
	// React view
	'li[role="listitem"] h3 a[data-hovercard-url*="/pull"]',

	// Legacy view
	'.js-issue-row a.js-navigation-open[href*="/pull/"]',
] as unknown as Array<'a'>;

export default prListLink;
