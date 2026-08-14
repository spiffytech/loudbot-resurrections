// Loudness filter — ported from the original LOUDBOT::Filter.
//
// The original used two criteria contexts: a loose "reply" gate (does the
// bot respond to this?) and a strict "db" gate (is this worth storing?).
// A fresh corpus could not bootstrap under the strict gate — typical short
// shouts passed "reply" but never "learn", so nothing was ever stored.
//
// Now there is a single "reply" gate. A message gets both a reply and a
// spot in the corpus iff it is loud enough to be shouted. Literal "RAGE"
// and any all-caps message trigger it; short bursts ("NO", "WTF") and
// mixed-case lines do not.

/** True when a line is loud enough to reply (and be remembered). */
export function isLoud(line: string, debug = false): boolean {
	if (line === 'RAGE') return true;

	const criteria = [
		{ id: 'length > 6', pred: (l: string) => l.length > 6 },
		{ id: 'caps-to-space ratio', pred: (l: string) => count(l, /\p{Lu}/gu) > count(l, /\s/gu) * 2 },
		{ id: 'less than 2 lowercase', pred: (l: string) => count(l, /\p{Ll}/gu) < 2 },
		{ id: 'caps-or-space density > 0.85', pred: (l: string) => l.length > 0 && count(l, /(?:\p{Lu}|\s)/gu) / l.length > 0.85 },
	];

	for (const c of criteria) {
		const ok = c.pred(line);
		if (debug) console.log(`${c.id}: ${ok ? 'OK' : 'FAIL'}`);
		if (!ok) return false;
	}
	return true;
}

// Count of characters matching a regex (the Perl `()=` trick).
function count(line: string, regex: RegExp): number {
	const matches = line.match(regex);
	return matches ? matches.length : 0;
}