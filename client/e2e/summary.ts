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

/** The summary of a run of rows that took wall milliseconds, in Markdown. */
export function summarize(title: string, rows: Row[], wall: number, status: string): string {
  const count = (o: Row['outcome']) => rows.filter((r) => r.outcome === o).length;
  const total = (r: Row) => r.tries.reduce((a, b) => a + b, 0);
  const cell = (s: string) => s.replaceAll('|', '\\|');
  const out = [
    `### ${title}`,
    '',
    `${rows.length} tests in ${minutes(wall)}, ${status}: ${count('expected')} passed, ` +
      `${count('flaky')} flaky, ${count('unexpected')} failed, ${count('skipped')} skipped.`,
    '',
  ];
  const ran = rows.filter((r) => r.outcome !== 'skipped').sort((a, b) => total(b) - total(a));
  if (ran.length > 0) {
    out.push('| Slowest | Project | Time | Tries |', '|---|---|---|---|');
    for (const r of ran.slice(0, 10)) {
      out.push(
        `| ${cell(`${r.where} ${r.title}`)} | ${r.project} | ${minutes(total(r))} | ${r.tries.length} |`,
      );
    }
    out.push('');
  }
  for (const [word, outcome] of [
    ['Flaky', 'flaky'],
    ['Failed', 'unexpected'],
  ] as const) {
    const these = rows.filter((r) => r.outcome === outcome);
    if (these.length === 0) {
      continue;
    }
    out.push(`**${word}:**`, '');
    for (const r of these) {
      const tries = r.tries.map(minutes).join(', ');
      const why = r.errors[0] === undefined ? '' : `: ${r.errors[0]}`;
      out.push(`- ${r.where} ${r.title} (${r.project}; tries ${tries})${why}`);
    }
    out.push('');
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
