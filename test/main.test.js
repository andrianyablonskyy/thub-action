/**
 * @file        packages/action/test/main.test.js
 * @description Tests: end to end — a fake Agent, Coordinator and GitHub API: outputs, Job Summary, PR comment, commit status
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
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http'),
  { main } = require('../src/main');

const JUNIT = '<testsuite name="s"><testcase classname="c" name="ok"/><testcase classname="c" name="bad"><failure message="boom"/></testcase></testsuite>';

// One server for both: the Coordinator API (/api/v1/…), the JUnit artifact
// (/art/…) and the GitHub REST API (/repos/…). Records every request.
async function fakeServices(t, { state = 'FAILED', existingComment = false, summary = { total: 2, passed: 1, failed: 1, skipped: 0 } } = {}){
  let base = null;
  const seen = [],
    comments = existingComment ? [{ id: 9, body: '<!-- thub-report:ci / hw -->\nold' }] : [],
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        const json = (code, data) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data));
        if (req.url === '/api/v1/jobs/A-00007'){
          return json(200, {
            id: 'A-00007', state, exit_code: state === 'PASSED' ? 0 : 1, duration_sec: 61, created_at: '2026-10-08T10:00:00Z',
            started_at: '2026-10-08T10:00:05Z', resource: { name: 'lab-sw-01' }, spec: { target: { labels: ['board:sim'] } },
            summary,
            artifacts: [{ name: 'junit.xml', size: 120, link: `${base}/art/junit.xml` }]
          });
        }
        if (req.url === '/art/junit.xml'){
          return req.headers['x-art'] === 'secret' ? res.end(JUNIT) : res.writeHead(401).end();
        }
        if (req.url.startsWith('/repos/o/r/issues/5/comments') && req.method === 'GET'){
          return json(200, comments);
        }
        if (req.url === '/repos/o/r/issues/5/comments' && req.method === 'POST'){
          return json(201, { id: 10, html_url: 'https://github.com/o/r/pull/5#issuecomment-10' });
        }
        if (req.url === '/repos/o/r/issues/comments/9' && req.method === 'PATCH'){
          return json(200, { id: 9, html_url: 'https://github.com/o/r/pull/5#issuecomment-9' });
        }
        if (req.url.startsWith('/repos/o/r/statuses/')){
          return json(201, {});
        }
        json(404, { message: 'Not Found' });
      });
    });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  return { base, seen };
}

// Stands in for `thub run --wait --json`: the JSON line, a log, the verdict's
// exit code — and what it was given, for the test to check.
function fakeAgent(dir, exitCode){
  const file = path.join(dir, 'agent.js');
  fs.writeFileSync(file, `
    require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'agent-call.json'))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
    console.log(JSON.stringify({ jobId: 'A-00007', state: 'QUEUED', webUrl: 'https://thub.example.com/jobs/A-00007' }));
    console.log('[runner] hello from the lab');
    process.exit(${exitCode});`);
  return `node ${file}`;
}

function runEnv(dir, base, extra = {}){
  const event = path.join(dir, 'event.json');
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 5, head: { sha: 'headsha123', ref: 'feature' } } }));
  for (const f of ['out', 'summary']){
    fs.writeFileSync(path.join(dir, f), '');
  }
  return {
    PATH: process.env.PATH,
    INPUT_URL: base,
    INPUT_KEY: 'agt_secret',
    INPUT_TYPE: 'sw',
    INPUT_COMMAND: './t.sh',
    INPUT_NAME: 'hw',
    'INPUT_COMMENT-KEY': 'ci / hw',
    'INPUT_GITHUB-TOKEN': 'ghs_x',
    'INPUT_ARTIFACT-HEADERS': 'X-Art: secret',
    GITHUB_OUTPUT: path.join(dir, 'out'),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    GITHUB_EVENT_PATH: event,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ID: '42',
    GITHUB_SHA: 'mergesha',
    GITHUB_API_URL: base,
    GITHUB_WORKFLOW: 'ci',
    GITHUB_JOB: 'test',
    ...extra
  };
}

test('a failed job: reported everywhere, and the step fails with the Agent\'s exit code', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-action-')),
    { base, seen } = await fakeServices(t),
    env = runEnv(dir, base, { INPUT_AGENT: fakeAgent(dir, 1), 'INPUT_COMMIT-STATUS': 'true' }),
    code = await main(env);
  assert.equal(code, 1);

  const outputs = fs.readFileSync(env.GITHUB_OUTPUT, 'utf8');
  assert.ok(outputs.includes('passed=1\n'));
  for (const line of ['job-id=A-00007', 'state=FAILED', 'client=lab-sw-01', 'board=sim', 'total=2', 'failed=1', 'duration-sec=61']){
    assert.ok(outputs.includes(line + '\n'), line);
  }
  const summary = fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.match(summary, /❌ TestHub hw: \*\*FAILED\*\*/);
  assert.match(summary, /\| ❌ \| c\.bad \| — \| boom \|/); // from the JUnit artifact, fetched with artifact-headers

  const post = seen.find((r) => r.method === 'POST' && r.url === '/repos/o/r/issues/5/comments');
  assert.ok(post.body.body.startsWith('<!-- thub-report:ci / hw -->'));
  assert.equal(post.auth, 'Bearer ghs_x');
  const statuses = seen.filter((r) => r.url.startsWith('/repos/o/r/statuses/'));
  assert.deepEqual(statuses.map((s) => [s.url, s.body.state]), [['/repos/o/r/statuses/headsha123', 'pending'], ['/repos/o/r/statuses/headsha123', 'failure']]);
  assert.equal(statuses[1].body.target_url, 'https://thub.example.com/jobs/A-00007');

  // The Agent got the key as THUB_KEY, but none of the action's INPUT_*.
  const call = JSON.parse(fs.readFileSync(path.join(dir, 'agent-call.json'), 'utf8'));
  assert.equal(call.env.THUB_KEY, 'agt_secret');
  assert.ok(!Object.keys(call.env).some((k) => k.startsWith('INPUT_')));
  assert.ok(call.argv.includes('githubPr=5') && call.argv.includes('githubSha=headsha123'));
});

test('a re-run updates its comment; on-failure only updates once it passes; fail: false never fails the step', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-action-')),
    { base, seen } = await fakeServices(t, { state: 'PASSED', existingComment: true });
  assert.equal(await main(runEnv(dir, base, { INPUT_AGENT: fakeAgent(dir, 0) })), 0);
  assert.ok(seen.some((r) => r.method === 'PATCH' && r.url === '/repos/o/r/issues/comments/9'));

  const fresh = await fakeServices(t, { state: 'PASSED' });
  assert.equal(await main(runEnv(dir, fresh.base, { INPUT_AGENT: fakeAgent(dir, 0), INPUT_COMMENT: 'on-failure' })), 0);
  assert.ok(!fresh.seen.some((r) => r.method === 'POST' && r.url.includes('/comments'))); // a pass doesn't start a comment

  const failed = await fakeServices(t);
  assert.equal(await main(runEnv(dir, failed.base, { INPUT_AGENT: fakeAgent(dir, 1), INPUT_FAIL: 'false' })), 0);
});

test('no counts from the Client (JUnit without tests= attributes): counted from the cases', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-action-')),
    { base } = await fakeServices(t, { summary: { total: 0, passed: 0, failed: 0, skipped: 0 } }),
    env = runEnv(dir, base, { INPUT_AGENT: fakeAgent(dir, 1), INPUT_COMMENT: 'false' });
  await main(env);
  const outputs = fs.readFileSync(env.GITHUB_OUTPUT, 'utf8');
  assert.ok(['total=2', 'passed=1', 'failed=1', 'skipped=0'].every((l) => outputs.includes(l + '\n')), outputs);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /\| Tests \| 2 total · 1 passed · 1 failed · 0 skipped \|/);
});

test('a job that was never submitted: said so in the summary, and the step fails', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thub-action-')),
    { base } = await fakeServices(t),
    agent = path.join(dir, 'bad.js');
  fs.writeFileSync(agent, 'console.error("Error: Invalid or revoked access key"); process.exit(4);');
  const env = runEnv(dir, base, { INPUT_AGENT: `node ${agent}` });
  assert.equal(await main(env), 4);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /not submitted/);
});
