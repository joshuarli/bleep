import { PAIR_CATEGORIES, SKEW_TOLERANCE_MS, type PairCategory, type PairSummary } from "../measure/pairs.ts";
import { element } from "./controls.ts";

const CATEGORY_LABELS: Record<PairCategory, string> = {
  both_ok: "Both succeeded",
  cloudflare_only: "Only Cloudflare succeeded",
  vercel_only: "Only Vercel succeeded",
  neither_valid: "Both sent, neither succeeded",
  not_fully_sent: "A side was not sent or was cancelled, neither succeeded",
};

export function describeDifference(summary: PairSummary): string {
  const difference = summary.medianDifferenceMs;
  if (difference === null) return "No complete pairs to compare yet.";
  const size = Math.abs(difference) < 10 ? Math.abs(difference).toFixed(1) : String(Math.round(Math.abs(difference)));
  if (difference === 0) return "Median paired difference: 0 ms (Vercel − Cloudflare).";
  return `Median paired difference: ${difference > 0 ? "+" : "−"}${size} ms (Vercel − Cloudflare): ${
    difference > 0 ? "Vercel" : "Cloudflare"
  } took longer in the typical pair.`;
}

export function renderComparison(summary: PairSummary): HTMLElement {
  const rows = PAIR_CATEGORIES.map((category) =>
    element("tr", { dataset: { category } }, [
      element("th", { scope: "row", textContent: CATEGORY_LABELS[category] }),
      element("td", { textContent: String(summary.counts[category]) }),
    ]),
  );
  return element("div", { className: "compare" }, [
    element("h3", { textContent: "Paired comparison" }),
    element("p", { className: "difference", dataset: { metric: "median-difference" }, textContent: describeDifference(summary) }),
    element("p", {
      className: "note",
      textContent: `Based on ${summary.differenceCount} pairs where both requests succeeded and were sent within ${SKEW_TOLERANCE_MS} ms of each other. ${summary.skewFlagged} pairs exceeded that dispatch skew and are excluded from the median but kept in the counts. Pairs are matched by sequence number, never by arrival order.`,
    }),
    element("div", { className: "table-wrap" }, [
      element("table", {}, [
        element("tbody", {}, [
          ...rows,
          element("tr", { dataset: { category: "skew_flagged" } }, [
            element("th", { scope: "row", textContent: `Dispatch skew over ${SKEW_TOLERANCE_MS} ms` }),
            element("td", { textContent: String(summary.skewFlagged) }),
          ]),
          element("tr", { dataset: { category: "incomplete" } }, [
            element("th", { scope: "row", textContent: "Waiting for a side (in flight)" }),
            element("td", { textContent: String(summary.incomplete) }),
          ]),
        ]),
      ]),
    ]),
    element("p", {
      className: "note",
      textContent:
        "Per-destination medians and 95th percentiles are in the table above. Coincident spikes on both destinations are consistent with a shared influence; a spike on one destination is a difference worth investigating. This comparison includes routing, geography, transport behavior, browser scheduling, and platform handling, so it cannot isolate JavaScript runtime performance.",
    }),
  ]);
}
