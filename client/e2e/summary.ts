// SPDX-License-Identifier: AGPL-3.0-only

// A reporter that writes a run's summary to the job's page on GitHub
// ($GITHUB_STEP_SUMMARY): how many tests ran and how they ended, the ten
// slowest, and every flaky or failed test with its first error, so that what
// a run cost, and where it went wrong, is read without opening the log.
// SUMMARY_TITLE names the job. Without GITHUB_STEP_SUMMARY it writes nothing.

import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite } from '@playwright/test/reporter';

/** A test as the summary tells it. */
export interface Row {
  /** Its file and line, as spec.ts:12. */
  where: string;
  title: string;
  project: string;
  outcome: 'skipped' | 'expected' | 'unexpected' | 'flaky';
  /** Each try's time, in milliseconds. */
  tries: number[];
  /** Each failed try's first line of error. */
  errors: string[];
}

/** Milliseconds as m:ss. */
export function minutes(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A test as the summary counts it: its runs (under --repeat-each) as one. */
interface Test extends Row {
  /** How many times it ran, and passed. */
  runs: number;
  passed: number;
}

/**
 * Each test's rows as one. A test that passed in one run and failed in
 * another, or passed only on a retry, is flaky.
 */
function tests(rows: Row[]): Test[] {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.project} ${r.where} ${r.title}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((g) => {
    const ran = g.filter((r) => r.outcome !== 'skipped');
    const failed = ran.filter((r) => r.outcome === 'unexpected').length;
    const passed = ran.length - failed;
    const outcome: Row['outcome'] =
      ran.length === 0
        ? 'skipped'
        : g.some((r) => r.outcome === 'flaky') || (passed > 0 && failed > 0)
          ? 'flaky'
          : failed > 0
            ? 'unexpected'
            : 'expected';
    const first = g[0] as Row;
    return {
      ...first,
      outcome,
      tries: g.flatMap((r) => r.tries),
      errors: g.flatMap((r) => r.errors),
      runs: ran.length,
      passed,
    };
  });
}

/** The summary of a run of rows that took wall milliseconds, in Markdown. */
export function summarize(title: string, rows: Row[], wall: number, status: string): string {
  const all = tests(rows);
  const count = (o: Row['outcome']) => all.filter((t) => t.outcome === o).length;
  const total = (r: Row) => r.tries.reduce((a, b) => a + b, 0);
  const cell = (s: string) => s.replaceAll('|', '\\|');
  const repeats = Math.max(1, ...all.map((t) => t.runs));
  const out = [
    `### ${title}`,
    '',
    `${all.length} tests${repeats > 1 ? `, each run up to ${repeats} times,` : ''} in ${minutes(wall)}, ` +
      `${status}: ${count('expected')} passed, ${count('flaky')} flaky, ${count('unexpected')} failed, ` +
      `${count('skipped')} skipped.`,
    '',
  ];
  const ran = all.filter((t) => t.outcome !== 'skipped').sort((a, b) => total(b) - total(a));
  if (ran.length > 0) {
    out.push('| Slowest | Project | Time | Tries |', '|---|---|---|---|');
    for (const t of ran.slice(0, 10)) {
      out.push(
        `| ${cell(`${t.where} ${t.title}`)} | ${t.project} | ${minutes(total(t))} | ${t.tries.length} |`,
      );
    }
    out.push('');
  }
  for (const [word, outcome] of [
    ['Flaky', 'flaky'],
    ['Failed', 'unexpected'],
  ] as const) {
    const these = all.filter((t) => t.outcome === outcome);
    if (these.length === 0) {
      continue;
    }
    out.push(`**${word}:**`, '');
    for (const t of these) {
      const how =
        t.runs > 1
          ? `passed ${t.passed} of ${t.runs} runs`
          : `tries ${t.tries.map(minutes).join(', ')}`;
      const why = t.errors[0] === undefined ? '' : `: ${t.errors[0]}`;
      out.push(`- ${t.where} ${t.title} (${t.project}; ${how})${why}`);
    }
    out.push('');
  }
  // Each file's time, for the shards' groups (playwright.config.ts).
  const files = new Map<string, number>();
  for (const t of ran) {
    const file = t.where.replace(/:\d+$/, '');
    files.set(file, (files.get(file) ?? 0) + total(t));
  }
  if (files.size > 1) {
    out.push('<details><summary>Time by file</summary>', '', '| File | Time |', '|---|---|');
    for (const [file, ms] of [...files].sort((a, b) => b[1] - a[1])) {
      out.push(`| ${file} | ${minutes(ms)} |`);
    }
    out.push('', '</details>', '');
  }
  return `${out.join('\n')}\n`;
}

/** The first line of an error's message, without the terminal's colours. */
function firstLine(message: string | undefined): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape that starts a colour.
  const plain = (message ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  return plain.split('\n').find((l) => l.trim() !== '') ?? '';
}

export default class Summary implements Reporter {
  #root: Suite | null = null;
  #dir = '';
  #start = 0;

  onBegin(config: FullConfig, suite: Suite): void {
    this.#root = suite;
    this.#dir = config.rootDir;
    this.#start = Date.now();
  }

  onEnd(result: FullResult): void {
    const file = process.env.GITHUB_STEP_SUMMARY;
    if (file === undefined || file === '' || this.#root === null) {
      return;
    }
    const rows: Row[] = this.#root.allTests().map((t) => ({
      where: `${relative(this.#dir, t.location.file)}:${t.location.line}`,
      title: t.title,
      project: t.parent.project()?.name ?? '',
      outcome: t.outcome(),
      tries: t.results.map((r) => r.duration),
      errors: t.results
        .filter((r) => r.status !== 'passed' && r.status !== 'skipped')
        .map((r) => firstLine(r.error?.message)),
    }));
    const title = process.env.SUMMARY_TITLE ?? 'Playwright';
    appendFileSync(file, summarize(title, rows, Date.now() - this.#start, result.status));
  }

  printsToStdio(): boolean {
    return false;
  }
}
