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
//
// Emoji are tolerated like spaces: they are stripped from the line before
// loudness is judged (so "THIS IS AMAZING 🔥🔥" is judged as "THIS IS
// AMAZING" and stays loud), but a message with too many emoji — more than
// one per five characters — is spam, not shouting, and stays quiet.
//
// Emoji are detected with Unicode character classes, not a lookup table:
//   \p{Extended_Pictographic}            — visual emoji, incl. skin tones
//   \p{Regional_Indicator}{2}            — flag pairs (🇺🇸)
//   \p{Emoji_Keycap_Sequence}            — keycaps (#️⃣)
//   ZWJ sequences                        — family/role clusters (👨👩👧)
// The alternatives in a cluster are checked as a union so a match consumes
// the whole visual emoji as one unit (no over-counting components).

// Matches one complete "visual emoji unit":
//   - a base pictograph (optionally with skin-tone modifiers / VS16),
//   - a flag pair,
//   - a keycap sequence,
//   - or a ZWJ-joined run of the above.
const EMOJI_UNIT =
	/(?:\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)?|\p{Regional_Indicator}{2}|\p{Emoji_Keycap_Sequence})(?:\u200D(?:\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\uFE0F)?|\p{Regional_Indicator}{2}|\p{Emoji_Keycap_Sequence}))*/gv;

/** True when a line is loud enough to reply (and be remembered). */
export function isLoud(line: string, debug = false): boolean {
	if (line === 'RAGE') return true;

	const emoji = line.match(EMOJI_UNIT) ?? [];
	const emojiCount = emoji.length;
	// Emoji are tolerated like spaces: strip them before judging the text,
	// so they neither help nor hurt the shout signal.
	const text = line.replace(EMOJI_UNIT, '');
	const caps = count(text, /\p{Lu}/gu);
	const spaces = count(text, /\s/gu);
	const lower = count(text, /\p{Ll}/gu);

	const criteria = [
		{ id: 'length > 6', pred: (l: string) => l.length > 6 },
		// Caps must dominate spaces (2:1), like the original ratio.
		{ id: 'caps-to-space ratio', pred: (l: string) => caps > spaces * 2 },
		// Few lowercase letters.
		{ id: 'less than 2 lowercase', pred: (l: string) => lower < 2 },
		// Caps-or-space density (calculated on stripped text, but the strip
		// already removed emoji, so this is the pure-text density).
		{ id: 'caps-or-space density > 0.85', pred: (l: string) => l.length > 0 && (caps + spaces) / l.length > 0.85 },
	];

	for (const c of criteria) {
		const ok = c.pred(text);
		if (debug) console.log(`${c.id}: ${ok ? 'OK' : 'FAIL'}`);
		if (!ok) return false;
	}

	// Not too many emoji (judged on the ORIGINAL line): >1 per 5 chars
	// (ratio 0.2) is spam, not loud.
	const emojiOk = line.length > 0 && emojiCount / line.length <= 0.2;
	if (debug) console.log(`emoji ratio <= 0.2: ${emojiOk ? 'OK' : 'FAIL'}`);
	return emojiOk;
}

// Count of characters matching a regex (the Perl `()=` trick).
function count(line: string, regex: RegExp): number {
	const matches = line.match(regex);
	return matches ? matches.length : 0;
}
