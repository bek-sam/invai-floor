import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * Accessibility scan shared by the axe spec (T-32-3, research 12 G23).
 *
 * The baseline is a quarantine, not a mute: every entry names the rule, the route, a stable target
 * selector, why it is tolerated for now and the backlog id (`B-xxx`) that will fix it. A serious or
 * critical violation that is not in the baseline fails the spec, and a baseline entry that no
 * longer occurs fails it too ("remove fixed baseline entry"), so the list can only shrink.
 */
export type Lang = "en" | "es";
export type Found = { rule: string; route: string; target: string; impact: string; lang: Lang };
export type BaselineEntry = {
  rule: string;
  route: string;
  target: string;
  reason: string;
  backlog: string;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_FILE = path.join(HERE, "a11y-baseline.json");
export const TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];
const BLOCKING = new Set(["serious", "critical"]);

export function loadBaseline(): BaselineEntry[] {
  const parsed = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as { entries: BaselineEntry[] };
  return parsed.entries;
}

/** Every violation seen (any impact), by impact, for the report. */
export const impactCounts = new Map<string, number>();

/** Serious and critical violations on the page as it is now, one row per failing element. */
export async function scan(page: Page, route: string, lang: Lang): Promise<Found[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  // A scan that ran no rules proves nothing (blank page, blocked script): fail loudly.
  if (results.passes.length === 0) throw new Error(`axe ran no rules on ${route} (${lang})`);
  const out: Found[] = [];
  for (const v of results.violations) {
    const label = `${v.impact ?? "unknown"}`;
    impactCounts.set(label, (impactCounts.get(label) ?? 0) + v.nodes.length);
  }
  for (const v of results.violations) {
    if (!BLOCKING.has(v.impact ?? "")) continue;
    for (const node of v.nodes) {
      out.push({
        rule: v.id,
        route,
        target: node.target.map((t) => (Array.isArray(t) ? t.join(" ") : t)).join(" "),
        impact: v.impact ?? "",
        lang,
      });
    }
  }
  return out;
}

export const keyOf = (f: { rule: string; route: string; target: string }) =>
  `${f.rule} | ${f.route} | ${f.target}`;

/** Findings that are not baselined (new problems). */
export function unbaselined(found: Found[], baseline: BaselineEntry[]): Found[] {
  const known = new Set(baseline.map(keyOf));
  return found.filter((f) => !known.has(keyOf(f)));
}

/**
 * Baseline entries for routes that were scanned in both languages and did not occur in either.
 * (A route scanned in one language only is not judged: the problem may show up in the other.)
 */
export function fixedEntries(
  found: Found[],
  baseline: BaselineEntry[],
  scanned: Set<string>,
): BaselineEntry[] {
  const seen = new Set(found.map(keyOf));
  return baseline.filter(
    (b) => scanned.has(`${b.route}|en`) && scanned.has(`${b.route}|es`) && !seen.has(keyOf(b)),
  );
}

export const describeFound = (list: Found[]) =>
  list.map((f) => `  - ${f.rule} (${f.impact}, ${f.lang}) ${f.route}  ${f.target}`).join("\n");

/** A11Y_DUMP=<file> writes everything found, to build or review the baseline. */
export function dumpIfAsked(found: Found[]) {
  console.log(
    `axe violations by impact (all, before filtering): ${JSON.stringify(Object.fromEntries(impactCounts))}`,
  );
  const file = process.env.A11Y_DUMP;
  if (file) writeFileSync(file, JSON.stringify(found, null, 2));
}
