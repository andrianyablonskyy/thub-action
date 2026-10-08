/**
 * @file        action/test/inputs.test.js
 * @description Tests: the action's inputs, and the thub run command line they become
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
  { readInputs, agentCommand, githubMeta } = require('../src/inputs');

const base = { INPUT_URL: 'https://thub.example.com/', INPUT_KEY: 'k', INPUT_TYPE: 'hw', INPUT_COMMAND: './ci/test.sh' };

test('required inputs, and what makes them invalid', () => {
  assert.equal(readInputs(base).url, 'https://thub.example.com');
  assert.throws(() => readInputs({ ...base, INPUT_KEY: '' }), /Missing required input\(s\): key/);
  assert.throws(() => readInputs({ ...base, INPUT_TYPE: 'arm' }), /type: must be hw or sw/);
  assert.throws(() => readInputs({ ...base, INPUT_URL: 'thub.example.com' }), /url: must start with http/);
  assert.throws(() => readInputs({ ...base, INPUT_COMMENT: 'always' }), /comment: must be true, false or on-failure/);
  assert.throws(() => readInputs({ ...base, 'INPUT_ARTIFACT-HEADERS': 'no colon' }), /one "Name: value" per line/);
  assert.throws(() => readInputs({ ...base, 'INPUT_DRY-RUN': 'maybe' }), /expected true or false/);
});

test('the Agent command: npx by default, every input as its option, GitHub metadata that the caller can override', () => {
  const inputs = readInputs({
      ...base,
      INPUT_LABELS: 'board:nucleo-f401re, uart\nstlink',
      'INPUT_DOWNLOAD-FILES': 'https://art/app.bin\n# a comment\nhttps://art/tests.tgz',
      INPUT_ENV: 'GH_TOKEN\nTARGET=staging',
      INPUT_META: 'githubRef=release',
      'INPUT_POWER-ON-START': 'reset',
      'INPUT_AGENT-VERSION': '1.1.6'
    }),
    { cmd, args } = agentCommand(inputs, ['githubRun=https://github.com/o/r/actions/runs/1', 'githubRef=main']);
  assert.equal(cmd, 'npx');
  assert.deepEqual(args.slice(0, 4), ['-y', '--package=git+https://github.com/andrianyablonskyy/thub-agent.git#v1.1.6', 'thub', 'run']);
  const pairs = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  assert.deepEqual(pairs('--label'), ['board:nucleo-f401re', 'uart', 'stlink']);
  assert.deepEqual(pairs('--download-file'), ['https://art/app.bin', 'https://art/tests.tgz']);
  assert.deepEqual(pairs('--env'), ['GH_TOKEN', 'TARGET=staging']);
  assert.deepEqual(pairs('--meta'), ['githubRun=https://github.com/o/r/actions/runs/1', 'githubRef=release']);
  assert.deepEqual(pairs('--power-on-start'), ['reset']);
  assert.ok(args.includes('--wait') && args.includes('--json'));
  assert.ok(!args.includes('--client') && !args.includes('--dry-run'));

  assert.deepEqual(agentCommand({ ...inputs, agent: 'node /opt/agent/cli.js' }).args.slice(0, 2), ['/opt/agent/cli.js', 'run']);
});

test('GitHub metadata: a pull request\'s head, not the merge commit', () => {
  const meta = githubMeta({ GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7', GITHUB_SHA: 'merge', GITHUB_REF_NAME: '5/merge' },
    { pull_request: { number: 5, head: { sha: 'abc', ref: 'feature' } } });
  assert.deepEqual(meta, ['githubRun=https://github.com/o/r/actions/runs/7', 'githubRepo=o/r', 'githubSha=abc', 'githubRef=feature', 'githubPr=5']);
});

test('action.yml hands every input it declares to the script', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8'),
    declared = [...yml.slice(yml.indexOf('\ninputs:'), yml.indexOf('\noutputs:')).matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((m) => m[1]),
    mapped = [...yml.matchAll(/^ {8}INPUT_([A-Z-]+): \$\{\{ inputs\.([a-z-]+) \}\}$/gm)];
  for (const [, envName, input]of mapped){
    assert.equal(envName.toLowerCase(), input);
  }
  assert.deepEqual(declared.filter((i) => i !== 'setup-node').sort(), mapped.map((m) => m[2]).sort());
});

test('agent-version: latest is the newest release tag, a version its tag; anything else refused', () => {
  const { agentRef } = require('../src/inputs');
  assert.equal(agentRef('latest'), 'semver:*');
  assert.equal(agentRef(''), 'semver:*');
  assert.equal(agentRef('1.1.11'), 'v1.1.11');
  assert.equal(agentRef('v1.1.11'), 'v1.1.11');
  assert.throws(() => agentRef('main; rm -rf /'), /agent-version must be/);
});
