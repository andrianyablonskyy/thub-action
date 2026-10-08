/**
 * @file        packages/action/src/report.js
 * @description A copy of thub-common's src/report-markdown.js (the action has no dependencies): the pull-request
 *              comment, the Job Summary and the JUnit test table. Edit it there; test/report.test.js checks they match
 *
 * @author      Andrian Yablonskyy
 * @copyright   Copyright (c) 2026 Andrian Yablonskyy. All rights reserved.
 *
 * This file is part of TestHub and is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without prior written permission
 * from AdSystem.PRO.
 */

'use strict';

// `flavor` (ctx.flavor) is where the Markdown is shown: github (the default)
// and gitlab render HTML (<details>, <sub>, an HTML comment as the marker);
// bitbucket strips HTML, so it gets plain headings and a link-definition marker.
const VERDICT = {
    PASSED: { icon: '✅', github: 'success', gitlab: 'success', bitbucket: 'SUCCESSFUL' },
    FAILED: { icon: '❌', github: 'failure', gitlab: 'failed', bitbucket: 'FAILED' },
    ERROR: { icon: '⚠️', github: 'error', gitlab: 'failed', bitbucket: 'FAILED' },
    TIMEOUT: { icon: '⏱️', github: 'error', gitlab: 'failed', bitbucket: 'FAILED' },
    LOST: { icon: '⚠️', github: 'error', gitlab: 'failed', bitbucket: 'FAILED' },
    CANCELED: { icon: '🚫', github: 'error', gitlab: 'canceled', bitbucket: 'STOPPED' },
    // Still going: reported while it runs (thub report on an active job).
    ...Object.fromEntries(['QUEUED', 'ASSIGNED', 'PREPARING', 'RUNNING']
      .map((s) => [s, { icon: '⏳', github: 'pending', gitlab: 'running', bitbucket: 'INPROGRESS' }]))
  },
  MAX_ROWS = 50,
  html = (ctx) => (ctx.flavor || 'github') !== 'bitbucket';

// 0 → "0s", 75 → "1m 15s", 3725 → "1h 2m 5s".
function formatDuration(sec){
  if (!Number.isFinite(sec) || sec < 0){
    return '—';
  }
  const s = Math.round(sec),
    parts = [[Math.floor(s / 3600), 'h'], [Math.floor((s % 3600) / 60), 'm'], [s % 60, 's']],
    first = parts.findIndex(([n]) => n > 0);
  return first === -1 ? '0s' : parts.slice(first).map(([n, u]) => `${n}${u}`).join(' ');
}

function seconds(from, to){
  const a = Date.parse(from),
    b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 1000) : NaN;
}

// How long it ran, and how long it waited for a Client before that.
function timing(job){
  const run = Number.isFinite(job.duration_sec) ? job.duration_sec : seconds(job.started_at, job.finished_at),
    queued = seconds(job.created_at, job.started_at);
  return { run, queued };
}

// `board:<name>` from the job's labels, if it asked for one.
function board(job){
  const label = (job.spec?.target?.labels || []).find((l) => l.startsWith('board:'));
  return label ? label.slice('board:'.length) : null;
}

function formatBytes(n){
  if (!Number.isFinite(n)){
    return '—';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n,
    u = 0;
  while (v >= 1024 && u < units.length - 1){
    v /= 1024;
    u += 1;
  }
  return u === 0 ? `${v} B` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

// Text for a Markdown table cell: one line, no pipes.
function cell(text){
  return String(text ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

// ---- JUnit ---------------------------------------------------------------

const decode = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, '\'').replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');

function attr(tag, name){
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? decode(m[2] ?? m[3]) : undefined;
}

// [{ suite, name, classname, time, status: passed|failed|error|skipped, message }]
// from JUnit XML — as GoogleTest, CTest, pytest, Maven Surefire and Gradle
// write it (test/fixtures/junit/). Enough for a report: no DTD, no namespaces.
// A test that didn't run (GoogleTest's DISABLED_ ones, status="notrun"; CTest's
// status="disabled") is skipped, not passed.
function parseJUnit(xml){
  const cases = [],
    text = String(xml || ''),
    suiteAt = [...text.matchAll(/<testsuite\b[^>]*>/g)].map((m) => ({ at: m.index, name: attr(m[0], 'name') || '' }));
  for (const m of text.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)){
    const tag = m[1],
      body = m[3] || '',
      suite = suiteAt.filter((s) => s.at < m.index).pop()?.name || '',
      notRun = ['notrun', 'disabled'].includes(attr(tag, 'status')),
      outcome = /<failure\b([^>]*)/.exec(body) ? ['failed', /<failure\b([^>]*)/.exec(body)[1]]
        : /<error\b([^>]*)/.exec(body) ? ['error', /<error\b([^>]*)/.exec(body)[1]]
          : /<skipped\b([^>]*)/.exec(body) ? ['skipped', /<skipped\b([^>]*)/.exec(body)[1]]
            : notRun ? ['skipped', ' message="disabled"'] : ['passed', ''],
      time = Number(attr(tag, 'time'));
    cases.push({
      suite,
      name: attr(tag, 'name') || '(unnamed)',
      classname: attr(tag, 'classname') || '',
      time: Number.isFinite(time) ? time : null,
      status: outcome[0],
      message: outcome[1] ? attr(`<x ${outcome[1]}>`, 'message') || '' : ''
    });
  }
  return cases;
}

// ---- Markdown ------------------------------------------------------------

function testsLine(summary){
  if (!summary || !Number.isFinite(summary.total) || summary.total === 0){
    return summary?.dryRun ? 'dry run: nothing executed' : 'no JUnit results reported';
  }
  return `${summary.total} total · ${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped`;
}

function testTable(cases, { title, open = false, flavor } = {}){
  if (!cases.length){
    return '';
  }
  const rows = cases.slice(0, MAX_ROWS).map((c) => {
      const icon = { passed: '✅', failed: '❌', error: '⚠️', skipped: '⏭️' }[c.status],
        // CTest's classname is the test's whole name: not twice.
        test = cell(c.classname && c.classname !== c.name && !c.name.startsWith(`${c.classname}.`) ? `${c.classname}.${c.name}` : c.name),
        time = c.time === null ? '—' : formatDuration(c.time);
      return `| ${icon} | ${test} | ${time} | ${cell(c.message).slice(0, 200)} |`;
    }),
    more = cases.length > MAX_ROWS ? `\n\n…and ${cases.length - MAX_ROWS} more.` : '',
    table = `| | Test | Time | Message |\n|---|---|---|---|\n${rows.join('\n')}${more}`;
  return html({ flavor })
    ? `<details${open ? ' open' : ''}><summary>${title} (${cases.length})</summary>\n\n${table}\n\n</details>\n`
    : `**${title} (${cases.length})**\n\n${table}\n`;
}

// The facts both the summary and the comment show, as table rows.
function factRows(job, ctx){
  const { run, queued } = timing(job),
    b = board(job),
    client = job.resource?.name,
    rows = [
      ['Job', `[${job.id}](${ctx.jobUrl})`],
      ['Result', `${job.state}${job.exit_code !== null && job.exit_code !== undefined ? ` (exit code ${job.exit_code})` : ''}`],
      ['Board', b ? `\`${b}\`${client ? ` on ${client}` : ''}` : client || '—'],
      ['Tests', testsLine(job.summary)],
      ['Duration', `${formatDuration(run)}${Number.isFinite(queued) && queued >= 1 ? ` (queued ${formatDuration(queued)})` : ''}`],
      ['Suite', job.spec?.suite ? `\`${job.spec.suite}\`` : null],
      ['Commit', ctx.sha ? `\`${ctx.sha.slice(0, 7)}\`` : null],
      ['Message', job.message ? cell(job.message) : null]
    ];
  return rows.filter(([, v]) => v);
}

function artifactsTable(job){
  if (!job.artifacts?.length){
    return '';
  }
  const rows = job.artifacts.slice(0, MAX_ROWS).map((a) => `| [${cell(a.name)}](${a.link}) | ${formatBytes(a.size)} |`);
  return `\n**Artifacts**\n\n| Name | Size |\n|---|---|\n${rows.join('\n')}\n`;
}

function heading(job, ctx){
  const v = VERDICT[job.state] || { icon: '•' };
  return `${v.icon} TestHub ${ctx.title ? `${ctx.title}: ` : ''}**${job.state}**`;
}

// The Job Summary (GITHUB_STEP_SUMMARY): everything, including every test.
function renderSummary(job, ctx, cases = []){
  const failed = cases.filter((c) => c.status === 'failed' || c.status === 'error');
  return [
    `### ${heading(job, ctx)}`,
    '',
    '| | |',
    '|---|---|',
    ...factRows(job, ctx).map(([k, v]) => `| ${k} | ${v} |`),
    `| Links | [Job page and full log](${ctx.jobUrl})${ctx.runUrl ? ` · [${ctx.runLabel || 'This workflow run'}](${ctx.runUrl})` : ''} |`,
    '',
    testTable(failed, { title: 'Failed tests', open: true, flavor: ctx.flavor }),
    testTable(cases, { title: 'All tests', flavor: ctx.flavor }),
    artifactsTable(job)
  ].join('\n');
}

// The pull/merge-request comment: the facts, failed tests only, and a marker
// so the next run of the same CI job updates it instead of adding another.
function renderComment(job, ctx, cases = []){
  const failed = cases.filter((c) => c.status === 'failed' || c.status === 'error'),
    updated = `${ctx.key} · updated ${new Date(ctx.now || Date.now()).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  return [
    commentMarker(ctx.key, ctx.flavor),
    `### ${heading(job, ctx)}`,
    '',
    '| | |',
    '|---|---|',
    ...factRows(job, ctx).map(([k, v]) => `| ${k} | ${v} |`),
    `| Links | [Job page and full log](${ctx.jobUrl})${ctx.runUrl ? ` · [${ctx.runLabel || 'Workflow run'}](${ctx.runUrl})` : ''} |`,
    '',
    testTable(failed, { title: 'Failed tests', open: failed.length <= 10, flavor: ctx.flavor }),
    html(ctx) ? `<sub>${updated}</sub>` : `_${updated}_`
  ].join('\n');
}

// A submission that never became a job (bad input, auth, the Coordinator unreachable).
function renderNoJob(ctx, reason){
  return `### ⚠️ TestHub ${ctx.title ? `${ctx.title}: ` : ''}**not submitted**\n\n${cell(reason)}\n`;
}

// The first line of every TestHub comment, which identifies it (by `key`)
// for the next run to update. Invisible where it's shown.
function commentMarker(key, flavor = 'github'){
  return flavor === 'bitbucket'
    ? `[//]: # (thub-report:${String(key).replace(/[()\n]/g, '')})`
    : `<!-- thub-report:${String(key).replace(/--/g, '-')} -->`;
}

// The commit/build status for the verdict on `platform` (github, gitlab, bitbucket).
function statusFor(state, platform = 'github'){
  return VERDICT[state]?.[platform] || VERDICT.ERROR[platform];
}

// Test counts from the cases themselves: for a job whose Client found no
// <testsuite tests=…> attributes to count.
function countsFromCases(cases){
  const n = (statuses) => cases.filter((c) => statuses.includes(c.status)).length;
  return { total: cases.length, passed: n(['passed']), failed: n(['failed', 'error']), skipped: n(['skipped']) };
}

module.exports = {
  formatDuration, timing, board, formatBytes, parseJUnit, renderSummary, renderComment, renderNoJob, commentMarker, statusFor, testsLine,
  countsFromCases
};
