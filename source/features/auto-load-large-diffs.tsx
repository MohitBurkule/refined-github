import * as pageDetect from 'github-url-detection';

import features from '../feature-manager.js';
import observe from '../helpers/selector-observer.js';

// GitHub hides diffs above a size threshold behind this button instead of rendering them
const loadDiffButtonSelector = '[class*="HiddenDiffPatch-module__gridColumnTemplate"] button';

function init(signal: AbortSignal): void {
	observe(loadDiffButtonSelector, button => {
		button.click();
	}, {signal});
}

void features.add(import.meta.url, {
	include: [
		pageDetect.hasFiles,
		pageDetect.isPRCommit,
	],
	init,
});

/*

Test URLs:

https://github.com/refined-github/refined-github/pull/6674/files

*/
