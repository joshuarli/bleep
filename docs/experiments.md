# Run a network experiment

Use this recipe to see whether upload or download load on your connection slows requests to both destinations, and whether SQM changes that. Each step produces an export you can compare later.

## Before you start

- Open one hosted page: `https://blip-monitor.joshua-r-li-98.workers.dev` or `https://blip-monitor.vercel.app`. Use the same page for every run you want to compare, because results from different UI hosts are never pooled.
- Start with a wired connection. Add Wi‑Fi variables only after you have a wired baseline.
- Generate load from a command-line tool, a native app, or another device. Keep the monitor visible in its own window or split screen. A load test in another tab of the same window hides the monitor, and a hidden monitor pauses.
- Do not count on a laptop that may sleep. A sleeping page records one `scheduler_gap`, not measurements.

## Record one experiment

1. Select **Compare both**, then **Start**. Wait for the 10 s warm-up notice to clear.
2. Type `Baseline` in **Label** and click **Mark now**. Leave the connection idle for at least 60 s.
3. Start a sustained upload, then mark `Upload started`. Keep it running for at least 60 s.
4. Stop the upload and mark `Recovery`. Wait at least 60 s.
5. Start a sustained download and mark `Download started`. Keep it running for at least 60 s.
6. Stop the download and mark `Recovery`. Wait at least 60 s.
7. Click **Set as baseline** on the `Baseline` interval.
8. Click **Export JSON and CSV**. Keep both files together.

If a run needs more than 10 minutes, click **Extend +10 min** before it ends. A session can last up to 60 minutes.

## Repeat after a change

1. Change one thing, such as enabling SQM, and mark `SQM enabled`.
2. Repeat steps 2 to 8 of the experiment above in the same session, or start a new session and repeat all of them.
3. If you change Wi‑Fi or move the device, mark `Changed Wi-Fi` or `Moved to another room` and record a new baseline.

## Compare intervals

1. Tick **compare** on two intervals, such as `Baseline` and `Upload started`.
2. Read each destination's median and 95th percentile beside its successful count, failures, unsent slots, and coverage.
3. Read the baseline deltas. A positive median delta means that interval was slower than the baseline.
4. Compare equivalent intervals across experiments, such as `Upload started` with SQM off against `Upload started` with SQM on.

If both destinations slow down together under load, the pattern is consistent with a shared influence such as your connection. If only one destination slows down, that is a difference worth investigating. Neither pattern proves which device or provider caused it.

## Summarize exports

Run this from a checkout of the repository:

```sh
node scripts/summarize-export.ts path/to/exports
node scripts/summarize-export.ts --check path/to/exports
```

The first command prints per-run, per-segment summaries for every export. The second command fails if an export no longer reproduces the summary the page displayed when you exported it.
