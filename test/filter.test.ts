import { describe, expect, test } from 'bun:test';
import { isLoud } from '../src/lib/filter.ts';

describe('isLoud', () => {
	test('literal RAGE always triggers', () => {
		expect(isLoud('RAGE')).toBe(true);
	});

	test('an all-caps sentence triggers', () => {
		expect(isLoud('THIS IS VERY LOUD INDEED')).toBe(true);
	});

	test('all-caps with few words and short words triggers', () => {
		expect(isLoud('THIS ANNOYS ME')).toBe(true);
	});

	test('short all-caps bursts do not trigger', () => {
		expect(isLoud('NO')).toBe(false);
		expect(isLoud('WTF')).toBe(false);
	});

	test('lowercase sentence does not trigger', () => {
		expect(isLoud('this is a quiet sentence')).toBe(false);
	});

	test('mixed case with low caps density does not trigger', () => {
		expect(isLoud('This is Mostly Quiet Text')).toBe(false);
	});

	test('all-caps with a lowercase word does not trigger', () => {
		expect(isLoud('THIS IS LOUD with a whisper')).toBe(false);
	});
});