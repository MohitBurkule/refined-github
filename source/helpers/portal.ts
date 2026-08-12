import type {Action} from 'svelte/action';

// On pages with heavier React re-rendering (e.g. the newer Issue UI), one microtask
// isn't always enough for `node` to land in the document, so this retries across a
// few animation frames before giving up.
const maxAttempts = 10;

const portal: Action<HTMLElement, () => Element> = (node, getTarget) => {
	let destroyed = false;

	function move(attempt: number): void {
		if (destroyed) {
			return;
		}

		if (!node.isConnected) {
			if (attempt < maxAttempts) {
				requestAnimationFrame(() => {
					move(attempt + 1);
				});
				return;
			}

			// This is a requirement for `tool-tip`
			// https://github.com/refined-github/refined-github/pull/9668
			throw new Error('The element was not added to the document in time');
		}

		getTarget().append(node);
	}

	if (node.isConnected) {
		move(maxAttempts);
	} else {
		queueMicrotask(() => {
			move(0);
		});
	}

	return {
		destroy() {
			destroyed = true;
			node.remove();
		},
	};
};

export default portal;
