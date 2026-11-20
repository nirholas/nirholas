# Profile generator

Everything in this repository except `scripts/`, `tests/`, `deploy/` and the community files is generated. `scripts/build-profile.mjs` builds the README, the animated charts in `assets/`, `llms.txt`, `llms-full.txt`, `CITATION.cff`, `AGENTS.md` and `repos.json` from the live GitHub listing, so the profile never drifts from what is actually public. Do not edit those files by hand; the next daily run overwrites them.

It needs Node 22 or newer and an authenticated `gh` (or `GH_TOKEN`). There are no npm dependencies.

```bash
npm run build                                    # regenerate the files in this checkout
node scripts/build-profile.mjs --no-activity     # catalog only, skip the commit-history crawl
node scripts/build-profile.mjs --out /tmp/p      # write somewhere else to compare
node scripts/build-profile.mjs --activity-cache c.json   # keep the commit cache in c.json (default: $TMPDIR/profile-activity-cache.json)
npm run publish:profile                          # regenerate, commit and push to main
npm test                                         # node:test suite, no network
```

## Daily refresh

| Piece | Value |
| --- | --- |
| Scheduler job | `github-profile-refresh`, Google Cloud project `aerial-vehicle-466722-p5`, `us-central1`, daily at 09:17 UTC |
| What it runs | [deploy/build.json](../deploy/build.json) on Cloud Build: clones this repo and runs `node scripts/build-profile.mjs --publish` |
| Build identity | `three-ws-build@` (needs `actAs` on itself to start the build) |
| GitHub token | Secret Manager `github-profile-token`, push access on `nirholas/nirholas` |
| Build tag | `github-profile-refresh` |
| Activity cache | `gs://nirholas-profile-state/activity-cache.json`, restored before the generator and saved after it (`three-ws-build@` has object admin on the bucket only) |

The build runs the generator as committed on `main` here, so a change takes effect on the first run after it is pushed. A rebuild where nothing changed except the "Pulled from the GitHub API on" date is not committed.

```bash
npm run schedule                                 # create or update the job from deploy/build.json
node scripts/schedule.mjs --run-now              # and trigger one run now
gcloud builds list --filter="tags=github-profile-refresh" --limit=5 --project=aerial-vehicle-466722-p5
```

The Scheduler job keeps its own copy of `deploy/build.json`, so rerun `npm run schedule` after editing that file. To rotate the token, add a new version to `github-profile-token`; builds read `latest`.

## What the README contains

It is the owner's personal profile, so the copy stays personal: three.ws appears as one section and in its own repo listings, never as the header, badges, contact or author.

The README carries animated charts rendered by [lib/profile-visuals.mjs](lib/profile-visuals.mjs) into `assets/`, one SVG per theme picked with `<picture>` and `prefers-color-scheme`:

| Asset | What it shows |
|---|---|
| `stats` | Odometer strip: repos, stars, forks, topics, languages, repos created this year |
| `planet` | A 3D sphere spinning in real time, one dot per repo sized by stars and colored by section, with a section legend |
| `top-stars` | Lollipops on a log axis for the 12 most-starred repos |
| `city` | Isometric city, one tower per repo (height is log stars), one district per section, towers rise on load |
| `growth` | Cumulative repos by creation month, stacked by section, drawn on left to right |
| `languages` | Extruded donut of primary languages that spins in 3D |
| `punchcard` | Repo creation by weekday and hour (UTC) |

The README header also carries a star-history "Top Committer 2026" badge on its own centered row under the follower badges.

The same run adds an **About** section (the owner's background, first person; it links the owner's Entrepreneur, HackerNoon, Medium and Amazon author pages and the Business Insider coverage from the `ABOUT_LINKS` table in the script, and names PhotoVogue without a link because vogue.com returns 404 for every PhotoVogue page) and a **How I build** section of coding analytics, rendered by [lib/profile-visuals.mjs](lib/profile-visuals.mjs) from numbers computed in [lib/profile-activity.mjs](lib/profile-activity.mjs):

| Asset | What it shows |
|---|---|
| `activity-volume` | Odometer: commits, lines added and lines removed over the last 12 months |
| `activity-habit` | Odometer: hours with a push, active days, longest streak |
| `activity-calendar` | A year of daily commit counts as a calendar heatmap |
| `activity-lines` | Lines added above the axis and removed below it, by month |
| `activity-hours` | Hours of the day with a push, for each of the last 90 days, with the average |
| `activity-rhythm` | Commits by weekday and hour (UTC) |

Where the numbers come from, and what they leave out:

- **Commits, active days and streaks** come from the GraphQL contribution calendar, so private repositories count (as counts only; no private name or content is ever read or printed).
- **Lines and hours** come from each public, non-fork repo's default-branch history filtered to the owner (`history(author:)`, paged by an `until` date because cursor paging 502s deep into large repos, and halving the page size when GitHub 502s on a page of large commits). Private repos do not contribute.
- **Bulk commits** over `BULK_LINES` (20,000) changed lines are left out of line totals as imports or generated output. A commit GitHub cannot diff comes back as a null node and is skipped.
- **Hours are not a stopwatch.** A day counts each UTC clock hour in which a commit landed, so it can never exceed 24 and a single push never counts as more than its hour.
- The README only ever names repos that survive the same gating as the catalog; gated repos still count toward totals.

Each run keeps every repo's commits in the activity cache. The next run reuses a repo GitHub reports no push for (`pushedAt` unchanged) without any API call, and for a pushed repo reads only commits from a week before its newest cached one, merged by commit id. Every 7 days the whole history is read again, so commits a rebase or force-push rewrote drop out instead of counting twice. A missing or unreadable cache simply means a full read. A full read of about 440 repos takes around 13 minutes on Cloud Build; a daily incremental run only touches the repos pushed that day.

An **Open-source contributions** section follows How I build: every public repository owned by someone else where a maintainer merged a pull request the owner authored, most-starred first, each with links to its merged pull requests. It comes from one GraphQL search (`is:pr is:merged author:nirholas -user:nirholas`) on every run, so a newly merged PR shows up at the next daily refresh with no hand edit. It lists every such repo regardless of the catalog's crypto gating, because the owner asked for the full record of accepted contributions. `llms.txt` carries the same list. If the search fails, the run throws before `--publish` pushes, so the live README never loses the section.

GitHub shows README images through `<img>`, so there is no script or web font. The 3D is real anyway: a ring drawn in a group rotated by `animateTransform` and squashed by `scale(1, k)` is the exact projection of a ring spinning about a vertical axis, and dots and labels ride inside a counter-rotated group so they stay round and upright. The donut wall is the same rotating ring stacked every 1.5px. Section colors follow the fixed category order, so a section keeps its color in every chart.
