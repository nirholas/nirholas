// Coding-activity analytics for the personal GitHub profile.
//
// Two halves. `collectActivity` reads real data from GitHub: the contribution
// calendar (every commit the account made, private repos included, as counts
// only) and, for every public repo, each of the owner's commits with its
// timestamp and added and deleted lines. `summarizeActivity` is a pure function
// over that data, so it is tested without the network and the visuals only ever
// draw numbers computed here.
//
// Honest limits, repeated in the chart captions:
//   - Lines and time come from public repositories only. Private work shows up
//     in the commit and streak counts (the calendar) and nowhere else.
//   - Commits that change more than BULK_LINES lines are treated as bulk
//     imports or generated output and left out of the line totals, so a
//     regenerated lockfile or vendored folder cannot fake a record day.
//   - "Hours" is not a stopwatch. It counts the distinct clock hours of a day in
//     which at least one commit landed, so a day can never exceed 24 and a
//     single push never counts as more than the hour it was made in.
//   - Hours and weekdays are UTC.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const BULK_LINES = 20000;
const DAY = 86400000;
const CONCURRENCY = 6;
// Every FULL_EVERY_DAYS the whole history is read again, so commits a rebase or
// force-push rewrote drop out of the cache instead of being counted twice.
const FULL_EVERY_DAYS = 7;
// An incremental read starts this far before the newest cached commit, so a
// commit made earlier and pushed later is still picked up.
const OVERLAP = 7 * DAY;

const HISTORY_QUERY = `query($owner:String!,$name:String!,$id:ID!,$since:GitTimestamp,$until:GitTimestamp,$first:Int!){
  repository(owner:$owner,name:$name){
    defaultBranchRef{target{... on Commit{history(first:$first,since:$since,until:$until,author:{id:$id}){
      nodes{oid committedDate additions deletions}
    }}}}
  }
}`;

const CALENDAR_QUERY = `query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){contributionsCollection(from:$from,to:$to){
    contributionCalendar{weeks{contributionDays{date contributionCount}}}
  }}
}`;

function salvage(stdout) {
	try {
		const body = JSON.parse(stdout);
		return body?.data ? body : null;
	} catch {
		return null;
	}
}

async function ghJson(args, attempts = 6) {
	for (let attempt = 0; ; attempt++) {
		try {
			const { stdout } = await run('gh', args, { maxBuffer: 1 << 28 });
			return JSON.parse(stdout);
		} catch (err) {
			// A commit too large for GitHub to diff makes gh exit non-zero while the
			// body still carries every other commit, with a null in the failed slot.
			const partial = salvage(err.stdout);
			if (partial) return partial;
			if (attempt >= attempts - 1) throw err;
			await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
		}
	}
}

const gql = (query, vars, attempts) =>
	ghJson(['api', 'graphql', '-f', `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => [typeof v === 'number' ? '-F' : '-f', `${k}=${v}`])], attempts);

async function pool(items, size, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

/**
 * Read one repo's history newest first, walking back with an `until` date
 * instead of a cursor. A cursor makes GitHub skip over every earlier commit on
 * each page, which times out (502) deep into a repo with thousands of commits;
 * a date bound does not. Pages overlap by the boundary second, so commits are
 * deduped by oid.
 *
 * GitHub also 502s when diffing a full page of large commits deep in a long
 * history, and repeating that request fails the same way every time. So a
 * failed page is retried at half the size, down to a single commit, and later
 * pages stay at the size that worked. Only a one-commit page that still fails
 * is an error.
 *
 * `since` limits the read to commits at or after that ISO time. Rows are
 * [time, added, deleted, oid], newest first.
 */
export async function repoCommits(owner, name, userId, { since = null, query = (vars) => gql(HISTORY_QUERY, vars, 2) } = {}) {
	const rows = [];
	const seen = new Set();
	let until = null;
	let first = 100;
	for (;;) {
		const vars = { owner, name, id: userId, first };
		if (since) vars.since = since;
		if (until) vars.until = until;
		let res;
		try {
			res = await query(vars);
		} catch (err) {
			if (first === 1) throw err;
			first = Math.ceil(first / 2);
			continue;
		}
		const nodes = res.data?.repository?.defaultBranchRef?.target?.history?.nodes;
		if (!nodes?.length) break;
		let fresh = 0;
		for (const n of nodes) {
			if (!n || seen.has(n.oid)) continue;
			seen.add(n.oid);
			fresh += 1;
			rows.push([Date.parse(n.committedDate), n.additions, n.deletions, n.oid]);
		}
		if (nodes.length < first) break;
		const oldest = Date.parse(nodes.findLast(Boolean).committedDate);
		until = new Date(fresh ? oldest : oldest - 1000).toISOString();
	}
	return rows;
}

/**
 * Decide how to refresh one repo from its cached entry. A repo GitHub reports
 * no push for since the last run is reused as is; a pushed repo is read from
 * OVERLAP before its newest cached commit; anything else is read in full.
 */
export function planRepo(prev, pushedAt, full) {
	if (full || !prev) return { since: null };
	if (prev.pushedAt === pushedAt) return { reuse: true };
	if (!prev.commits.length) return { since: null };
	const newest = prev.commits.reduce((m, r) => Math.max(m, r[0]), 0);
	return { since: new Date(newest - OVERLAP).toISOString() };
}

/** Union of cached and freshly read rows, deduped by oid, newest first. */
export function mergeRows(cached, fresh) {
	const byOid = new Map(cached.map((r) => [r[3], r]));
	for (const r of fresh) byOid.set(r[3], r);
	return [...byOid.values()].sort((a, b) => b[0] - a[0]);
}

function readCache(cacheFile, owner) {
	if (!cacheFile || !existsSync(cacheFile)) return null;
	try {
		const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
		return cache.owner === owner && cache.version === 2 && cache.repos ? cache : null;
	} catch {
		return null;
	}
}

/**
 * Fetch the raw activity. `repos` are the public, non-fork repositories to read
 * history from, as { name, pushedAt }. With a `cacheFile` the per-repo commits
 * of the previous run are kept there, so a daily run only reads the repos that
 * were pushed since, and only their recent commits. The file is rewritten after
 * every successful read.
 */
export async function collectActivity({ owner, repos, now = new Date(), cacheFile = null, log = () => {} }) {
	const cache = readCache(cacheFile, owner);
	const full = !cache || now - Date.parse(cache.fullAt) >= FULL_EVERY_DAYS * DAY;
	const user = await ghJson(['api', `users/${owner}`]);
	const created = new Date(user.created_at);

	const calendar = [];
	const years = [];
	for (let y = created.getUTCFullYear(); y <= now.getUTCFullYear(); y++) years.push(y);
	await pool(years, 3, async (y) => {
		const res = await gql(CALENDAR_QUERY, { login: owner, from: `${y}-01-01T00:00:00Z`, to: `${y}-12-31T23:59:59Z` });
		for (const w of res.data.user.contributionsCollection.contributionCalendar.weeks)
			for (const d of w.contributionDays) calendar.push([d.date, d.contributionCount]);
	});
	calendar.sort((a, b) => (a[0] < b[0] ? -1 : 1));

	let read = 0;
	const perRepo = await pool(repos, CONCURRENCY, async ({ name, pushedAt }) => {
		const prev = cache?.repos[name];
		const plan = planRepo(prev, pushedAt, full);
		if (plan.reuse) return [name, pushedAt, prev.commits];
		const fresh = await repoCommits(owner, name, user.node_id, { since: plan.since });
		if (++read % 50 === 0) log(`activity: ${read} repos read`);
		return [name, pushedAt, plan.since ? mergeRows(prev.commits, fresh) : fresh];
	});
	log(`activity: ${full ? 'full' : 'incremental'} read, ${read} of ${repos.length} repos fetched, ${repos.length - read} unchanged`);

	const commits = {};
	const cached = {};
	for (const [name, pushedAt, rows] of perRepo) {
		cached[name] = { pushedAt, commits: rows };
		if (rows.length) commits[name] = rows;
	}
	if (cacheFile) writeFileSync(cacheFile, JSON.stringify({ owner, version: 2, fullAt: full ? now.toISOString() : cache.fullAt, repos: cached }));
	return { owner, fetchedAt: now.toISOString(), calendar, commits };
}

const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Turn raw activity into the numbers the charts draw. Pure: same input, same output.
 * `allow` is an optional Set of repo names that may be named in the output; a repo
 * outside it still counts toward every total but is never listed by name.
 */
export function summarizeActivity(data, { now = new Date(), allow = null } = {}) {
	const calendar = new Map(data.calendar);
	const today = dayKey(now.getTime());

	// Every commit across public repos, one flat list, bulk commits flagged.
	const flat = [];
	const byRepo = new Map();
	for (const [name, rows] of Object.entries(data.commits)) {
		const stat = { name, commits: 0, added: 0, removed: 0 };
		for (const [t, a, d] of rows) {
			const bulk = a + d > BULK_LINES;
			flat.push([t, bulk ? 0 : a, bulk ? 0 : d, bulk]);
			stat.commits += 1;
			if (!bulk) {
				stat.added += a;
				stat.removed += d;
			}
		}
		byRepo.set(name, stat);
	}
	flat.sort((x, y) => x[0] - y[0]);

	// Per-day roll-up: commits, lines and the distinct UTC hours with a push.
	const days = new Map();
	const day = (k) => {
		let d = days.get(k);
		if (!d) days.set(k, (d = { date: k, commits: 0, added: 0, removed: 0, slots: new Set() }));
		return d;
	};
	for (const [t, a, d] of flat) {
		const r = day(dayKey(t));
		r.commits += 1;
		r.added += a;
		r.removed += d;
		r.slots.add(new Date(t).getUTCHours());
	}
	for (const d of days.values()) d.hours = d.slots.size;

	// Rhythm: weekday x hour of every commit, and hour-of-day share of time.
	const rhythm = Array.from({ length: 7 }, () => Array(24).fill(0));
	for (const [t] of flat) {
		const d = new Date(t);
		rhythm[(d.getUTCDay() + 6) % 7][d.getUTCHours()] += 1;
	}

	// Calendar-based streaks and counts cover private work too.
	const calDays = [...calendar.entries()].filter(([k]) => k <= today);
	let longest = 0;
	let run = 0;
	let longestEnd = null;
	for (const [k, n] of calDays) {
		run = n > 0 ? run + 1 : 0;
		if (run > longest) {
			longest = run;
			longestEnd = k;
		}
	}
	let current = 0;
	for (let i = calDays.length - 1; i >= 0; i--) {
		if (calDays[i][1] > 0) current += 1;
		else if (i === calDays.length - 1 && calDays[i][0] === today) continue;
		else break;
	}
	const calTotal = calDays.reduce((n, [, c]) => n + c, 0);
	const activeDays = calDays.filter(([, c]) => c > 0).length;
	let busiest = { date: null, count: 0 };
	for (const [k, c] of calDays) if (c > busiest.count) busiest = { date: k, count: c };

	// Trailing windows.
	const windowFrom = (n) => dayKey(now.getTime() - (n - 1) * DAY);
	const last = (n) => {
		const from = windowFrom(n);
		const rows = [...days.values()].filter((d) => d.date >= from && d.date <= today);
		const cal = calDays.filter(([k]) => k >= from);
		return {
			commits: cal.reduce((s, [, c]) => s + c, 0),
			added: rows.reduce((s, d) => s + d.added, 0),
			removed: rows.reduce((s, d) => s + d.removed, 0),
			hours: rows.reduce((s, d) => s + d.hours, 0),
			activeDays: cal.filter(([, c]) => c > 0).length,
		};
	};
	const d30 = last(30);
	const d365 = last(365);

	// Daily series for the last 365 days, calendar counts plus public lines and hours.
	const series = [];
	for (let i = 364; i >= 0; i--) {
		const k = dayKey(now.getTime() - i * DAY);
		const d = days.get(k);
		series.push({ date: k, count: calendar.get(k) || 0, added: d?.added || 0, removed: d?.removed || 0, hours: d?.hours || 0 });
	}

	// Monthly lines for the last 24 months.
	const months = [];
	const nm = now.getUTCFullYear() * 12 + now.getUTCMonth();
	for (let i = 23; i >= 0; i--) {
		const m = nm - i;
		months.push({ key: `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`, added: 0, removed: 0, commits: 0, hours: 0 });
	}
	const monthIndex = new Map(months.map((m, i) => [m.key, i]));
	for (const d of days.values()) {
		const m = months[monthIndex.get(d.date.slice(0, 7))];
		if (!m) continue;
		m.added += d.added;
		m.removed += d.removed;
		m.commits += d.commits;
		m.hours += d.hours;
	}

	const wanted = [...byRepo.values()].filter((r) => !allow || allow.has(r.name));
	const topRepos = wanted.sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.name.localeCompare(b.name)).slice(0, 8);

	const totalAdded = flat.reduce((s, c) => s + c[1], 0);
	const totalRemoved = flat.reduce((s, c) => s + c[2], 0);
	const publicDays = [...days.values()].filter((d) => d.commits > 0);
	const biggestDay = publicDays.reduce((m, d) => (d.added + d.removed > m.added + m.removed ? d : m), publicDays[0] || { date: null, added: 0, removed: 0 });
	const longestDay = publicDays.reduce((m, d) => (d.hours > m.hours ? d : m), publicDays[0] || { date: null, hours: 0 });
	const totalHours = publicDays.reduce((n, d) => n + d.hours, 0);
	const peak = rhythm.flatMap((row, di) => row.map((v, h) => ({ v, di, h }))).reduce((m, c) => (c.v > m.v ? c : m), { v: -1, di: 0, h: 0 });

	return {
		fetchedAt: data.fetchedAt,
		since: calDays.find(([, c]) => c > 0)?.[0] || today,
		today,
		series,
		months,
		rhythm,
		peak,
		topRepos,
		totals: {
			commits: calTotal,
			publicCommits: flat.length,
			added: totalAdded,
			removed: totalRemoved,
			net: totalAdded - totalRemoved,
			bulkCommits: flat.filter((c) => c[3]).length,
			hours: totalHours,
			activeDays,
			publicDays: publicDays.length,
			longestStreak: longest,
			longestStreakEnd: longestEnd,
			currentStreak: current,
			busiest,
		},
		averages: {
			commitsPerActiveDay: activeDays ? calTotal / activeDays : 0,
			hoursPerActiveDay: publicDays.length ? totalHours / publicDays.length : 0,
			linesPerActiveDay: publicDays.length ? (totalAdded + totalRemoved) / publicDays.length : 0,
		},
		records: {
			biggestDay: { date: biggestDay.date, lines: biggestDay.added + biggestDay.removed },
			longestDay: { date: longestDay.date, hours: longestDay.hours },
		},
		last30: d30,
		last365: d365,
	};
}
