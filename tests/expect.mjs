// A minimal expect() over node:assert, so the tests read like the usual
// matcher style without pulling a test framework into this repository.
import assert from 'node:assert/strict';

const matchers = (actual, negate) => {
	const check = (ok, message) => assert.ok(negate ? !ok : ok, negate ? `not: ${message}` : message);
	return {
		toBe: (want) => check(Object.is(actual, want), `expected ${JSON.stringify(actual)} to be ${JSON.stringify(want)}`),
		toEqual: (want) => {
			if (negate) assert.notDeepStrictEqual(actual, want);
			else assert.deepStrictEqual(actual, want);
		},
		toContain: (part) => check(actual.includes(part), `expected value to contain ${JSON.stringify(part)}`),
		toMatch: (re) => check(re.test(actual), `expected value to match ${re}`),
		toBeDefined: () => check(actual !== undefined, 'expected value to be defined'),
		toBeGreaterThan: (n) => check(actual > n, `expected ${actual} > ${n}`),
		toBeLessThan: (n) => check(actual < n, `expected ${actual} < ${n}`),
		toBeLessThanOrEqual: (n) => check(actual <= n, `expected ${actual} <= ${n}`),
		toMatchObject: (want) => {
			for (const [k, v] of Object.entries(want)) assert.deepStrictEqual(actual[k], v, `field ${k}`);
		},
	};
};

export const expect = (actual) => ({ ...matchers(actual, false), not: matchers(actual, true) });
