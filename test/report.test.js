/**
 * @file        packages/action/test/report.test.js
 * @description Tests: the Job Summary, the PR comment and JUnit parsing
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

const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { formatDuration, parseJUnit, renderSummary, renderComment, commentMarker, statusFor } = require('../src/report');

const JUNIT = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="uart" tests="3" failures="1" skipped="1">
    <testcase classname="uart.Echo" name="echoes 115200" time="0.42"/>
    <testcase classname="uart.Echo" name="echoes &amp; checks 921600" time="1.5">
      <failure message="expected &quot;OK&quot;, got timeout | retry">trace</failure>
    </testcase>
    <testcase classname="uart.Echo" name="flow control" time="0"><skipped message="no RTS"/></testcase>
  </testsuite>
  <testsuite name="flash"><testcase classname="flash" name="erase" time="3"><error message="probe lost"/></testcase></testsuite>
</testsuites>`,
  job = {
    id: 'A-00042', state: 'FAILED', exit_code: 1, created_at: '2026-10-08T10:00:00Z', started_at: '2026-10-08T10:00:20Z',
    finished_at: '2026-10-08T10:03:32Z', duration_sec: 192, resource: { name: 'lab-hw-01' },
    spec: { suite: 'smoke', target: { labels: ['board:nucleo-f401re', 'uart'] } },
    summary: { total: 4, passed: 1, failed: 2, skipped: 1 },
    artifacts: [{ name: 'junit.xml', size: 2048, link: 'https://art/qa/A-00042/junit.xml' }]
  },
  ctx = {
    key: 'firmware / test-hw',
    title: 'HW smoke',
    jobUrl: 'https://thub.example.com/jobs/A-00042',
    runUrl: 'https://github.com/o/r/actions/runs/1',
    sha: 'abcdef1234567',
    now: Date.parse('2026-10-08T10:04:00Z')
  };

test('durations', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(75), '1m 15s');
  assert.equal(formatDuration(3725), '1h 2m 5s');
  assert.equal(formatDuration(NaN), '—');
});

test('JUnit: every case with its outcome and message, entities decoded', () => {
  const cases = parseJUnit(JUNIT);
  assert.deepEqual(cases.map((c) => [c.suite, c.name, c.status]), [
    ['uart', 'echoes 115200', 'passed'], ['uart', 'echoes & checks 921600', 'failed'], ['uart', 'flow control', 'skipped'], ['flash', 'erase', 'error']
  ]);
  assert.equal(cases[1].message, 'expected "OK", got timeout | retry');
  assert.equal(cases[1].time, 1.5);
  assert.deepEqual(parseJUnit('not xml'), []);
});

test('the summary: facts, failed tests open, every test, artifacts — table cells escaped', () => {
  const md = renderSummary(job, ctx, parseJUnit(JUNIT));
  assert.match(md, /^### ❌ TestHub HW smoke: \*\*FAILED\*\*/);
  assert.match(md, /\| Job \| \[A-00042\]\(https:\/\/thub\.example\.com\/jobs\/A-00042\) \|/);
  assert.match(md, /\| Board \| `nucleo-f401re` on lab-hw-01 \|/);
  assert.match(md, /\| Tests \| 4 total · 1 passed · 2 failed · 1 skipped \|/);
  assert.match(md, /\| Duration \| 3m 12s \(queued 20s\) \|/);
  assert.match(md, /\| Commit \| `abcdef1` \|/);
  assert.match(md, /<details open><summary>Failed tests \(2\)<\/summary>/);
  assert.match(md, /\| ❌ \| uart\.Echo\.echoes & checks 921600 \| 2s \| expected "OK", got timeout \\\| retry \|/);
  assert.match(md, /<details><summary>All tests \(4\)<\/summary>/);
  assert.match(md, /\| \[junit\.xml\]\(https:\/\/art\/qa\/A-00042\/junit\.xml\) \| 2\.0 KB \|/);
});

test('the PR comment: its marker first, failed tests only, the run it came from', () => {
  const md = renderComment(job, ctx, parseJUnit(JUNIT));
  assert.ok(md.startsWith(commentMarker('firmware / test-hw') + '\n'));
  assert.match(md, /\[Workflow run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)/);
  assert.doesNotMatch(md, /All tests/);
  assert.match(md, /<sub>firmware \/ test-hw · updated 2026-10-08 10:04 UTC<\/sub>/);
  const passed = renderComment({ ...job, state: 'PASSED', exit_code: 0, summary: { total: 4, passed: 4, failed: 0, skipped: 0 } }, ctx, []);
  assert.match(passed, /### ✅ TestHub HW smoke: \*\*PASSED\*\*/);
  assert.doesNotMatch(passed, /Failed tests/);
  assert.equal(commentMarker('a--b'), '<!-- thub-report:a-b -->'); // can't end the HTML comment early
});

test('commit status per verdict', () => {
  assert.deepEqual(['PASSED', 'FAILED', 'ERROR', 'CANCELED', 'TIMEOUT'].map((s) => statusFor(s)), ['success', 'failure', 'error', 'error', 'error']);
});

// The action has no dependencies, so it carries a copy of thub-common's
// renderer: in the monorepo, the two must stay the same (bar the header).
test('src/report.js is thub-common\'s src/report-markdown.js', (t) => {
  const shared = path.join(__dirname, '..', '..', 'shared', 'src', 'report-markdown.js');
  if (!fs.existsSync(shared)){
    t.skip('not in the monorepo');
    return;
  }
  const body = (file) => {
    const s = fs.readFileSync(file, 'utf8'); return s.slice(s.indexOf('\'use strict\';'));
  };
  assert.equal(body(path.join(__dirname, '..', 'src', 'report.js')), body(shared),
    'copy packages/shared/src/report-markdown.js (below its header) into packages/action/src/report.js');
});
