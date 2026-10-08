/**
 * @file        action/src/main.js
 * @description GitHub Action entry point: runs `thub run --wait`, then reports the job on GitHub — outputs, the Job
 *              Summary, a pull-request comment and, optionally, a commit status
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

const { spawn } = require('node:child_process'),
  readline = require('node:readline'),
  { readInputs, githubMeta, agentCommand } = require('./inputs'),
  { parseJUnit, renderSummary, renderComment, renderNoJob, statusFor, timing, board, countsFromCases } = require('./report'),
  { log, setOutputs, appendSummary, readEvent, prNumber, headSha, GitHub } = require('./github'),
  { version } = require('../package.json');

const JUNIT_MAX_FILES = 10,
  JUNIT_MAX_BYTES = 5 * 1024 * 1024;

// Runs the Agent with its log streaming to the step's log. With --json its
// first line is {"jobId", "state", "webUrl"}: taken, not printed.
function runAgent({ cmd, args }, env, onJob){
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'inherit'] }),
      forward = (signal) => child.kill(signal);
    // A canceled workflow: the Agent in --wait mode cancels the TestHub job.
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    let first = true;
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (first){
        first = false;
        try {
          const submitted = JSON.parse(line);
          if (submitted?.jobId){
            onJob(submitted);
            return;
          }
        }
        catch { /* not the JSON line: an older Agent, or an error — just print it */ }
      }
      console.log(line);
    });
    child.on('error', (err) => {
      console.log(`Could not start the Agent (${cmd}): ${err.message}`);
      resolve(4);
    });
    child.on('close', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(code ?? (signal ? 3 : 4));
    });
  });
}

async function fetchJob(inputs, jobId){
  const res = await fetch(`${inputs.url}/api/v1/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${inputs.key}`, 'User-Agent': `thub-action/${version}` }
  });
  if (!res.ok){
    throw new Error(`GET /api/v1/jobs/${jobId}: HTTP ${res.status}`);
  }
  return res.json();
}

// Test cases from the JUnit XML the job published and listed as artifacts
// ($THUB_ARTIFACTS_FILE): their files never reach the Coordinator itself.
async function junitCases(job, headers){
  const xml = (job.artifacts || []).filter((a) => /\.xml(\?|$)/i.test(a.name || '') || /\.xml(\?|$)/i.test(a.link || '')).slice(0, JUNIT_MAX_FILES),
    hdrs = Object.fromEntries(headers.map((h) => [h.slice(0, h.indexOf(':')).trim(), h.slice(h.indexOf(':') + 1).trim()])),
    cases = [];
  for (const a of xml){
    try {
      const res = await fetch(a.link, { headers: hdrs });
      if (!res.ok){
        throw new Error(`HTTP ${res.status}`);
      }
      const text = await res.text();
      if (text.length > JUNIT_MAX_BYTES){
        throw new Error('larger than 5 MB');
      }
      cases.push(...parseJUnit(text));
    }
    catch (err){
      log.warning(`Couldn't read test results from ${a.name}: ${err.message} (set artifact-headers if the storage needs credentials)`);
    }
  }
  return cases;
}

async function report(inputs, ctx, job, cases){
  const { run } = timing(job);
  setOutputs(ctx.outputFile, {
    'job-id': job.id,
    'job-url': ctx.jobUrl,
    state: job.state,
    'exit-code': job.exit_code ?? '',
    client: job.resource?.name || '',
    board: board(job) || '',
    'duration-sec': Number.isFinite(run) ? Math.round(run) : '',
    total: job.summary?.total ?? '',
    passed: job.summary?.passed ?? '',
    failed: job.summary?.failed ?? '',
    skipped: job.summary?.skipped ?? ''
  });
  if (inputs.summary){
    appendSummary(ctx.summaryFile, renderSummary(job, ctx, cases));
  }
  const gh = inputs.githubToken && ctx.repo ? new GitHub({ token: inputs.githubToken, repo: ctx.repo, apiUrl: ctx.apiUrl }) : null;
  if (inputs.comment !== 'false' && ctx.pr){
    const passed = job.state === 'PASSED',
      create = inputs.comment === 'true' || !passed;
    try {
      if (!gh){
        throw new Error('no github-token');
      }
      const done = await gh.upsertComment(ctx.pr, ctx.key, renderComment(job, ctx, cases), { create });
      if (done.url){
        console.log(`PR #${ctx.pr}: comment ${done.action} — ${done.url}`);
      }
    }
    catch (err){
      log.warning(`Couldn't comment on PR #${ctx.pr}: ${err.message}. ` +
        (err.status === 403 || err.status === 404
          ? 'Give the job `permissions: pull-requests: write`; a pull request from a fork only gets a read-only token (see the action\'s README).'
          : ''));
    }
  }
  if (inputs.commitStatus && gh && ctx.sha){
    await gh.setStatus(ctx.sha, {
      state: statusFor(job.state),
      context: `TestHub / ${ctx.key}`,
      description: [
        job.state,
        job.summary?.total ? ` — ${job.summary.passed}/${job.summary.total} tests passed` : '',
        job.resource?.name ? ` on ${job.resource.name}` : ''
      ].join(''),
      targetUrl: ctx.jobUrl
    }).catch((err) => log.warning(`Couldn't set the commit status: ${err.message} (needs \`permissions: statuses: write\`)`));
  }
}

async function main(env = process.env){
  let inputs;
  try {
    inputs = readInputs(env);
  }
  catch (err){
    log.error(err.message);
    return 4;
  }
  log.mask(inputs.key);
  if (process.platform === 'win32' && !inputs.agent){
    log.error('Run TestHub jobs from a Linux or macOS runner (the Coordinator and Clients are reached the same way from any of them).');
    return 4;
  }

  const event = readEvent(env.GITHUB_EVENT_PATH),
    server = env.GITHUB_SERVER_URL || 'https://github.com',
    key = inputs.commentKey || [env.GITHUB_WORKFLOW, env.GITHUB_JOB, inputs.name].filter(Boolean).join(' / ') || 'thub',
    ctx = {
      key,
      title: inputs.name,
      repo: env.GITHUB_REPOSITORY,
      apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
      sha: headSha(event, env),
      pr: prNumber(event, inputs.prNumber),
      runUrl: env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
      jobUrl: null,
      outputFile: env.GITHUB_OUTPUT,
      summaryFile: env.GITHUB_STEP_SUMMARY
    },
    gh = inputs.commitStatus && inputs.githubToken && ctx.repo ? new GitHub({ token: inputs.githubToken, repo: ctx.repo, apiUrl: ctx.apiUrl }) : null,
    agentEnv = {
      ...env,
      THUB_URL: inputs.url,
      THUB_KEY: inputs.key,
      THUB_NO_SELF_UPDATE: '1',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      NPM_CONFIG_FUND: 'false'
    };
  // INPUT_* (the key among them) are this action's, not the job's business.
  for (const k of Object.keys(agentEnv).filter((k) => k.startsWith('INPUT_'))){
    delete agentEnv[k];
  }

  let submitted = null;
  const exitCode = await runAgent(agentCommand(inputs, githubMeta(env, event)), agentEnv, (s) => {
    submitted = s;
    ctx.jobUrl = s.webUrl || `${inputs.url}/jobs/${s.jobId}`;
    console.log(`Job ${s.jobId} queued — ${ctx.jobUrl}`);
    setOutputs(ctx.outputFile, { 'job-id': s.jobId, 'job-url': ctx.jobUrl });
    if (gh && ctx.sha){
      gh.setStatus(ctx.sha, { state: 'pending', context: `TestHub / ${key}`, description: `Job ${s.jobId} queued`, targetUrl: ctx.jobUrl })
        .catch((err) => log.warning(`Couldn't set the commit status: ${err.message} (needs \`permissions: statuses: write\`)`));
    }
  });

  if (!submitted){
    const reason = 'The job was not submitted — see the step log above (input, access key or Coordinator address).';
    if (inputs.summary){
      appendSummary(ctx.summaryFile, renderNoJob(ctx, reason));
    }
    log.error(reason);
    return exitCode || 4;
  }

  try {
    const job = await fetchJob(inputs, submitted.jobId),
      cases = await junitCases(job, inputs.artifactHeaders);
    // The Client counts tests from <testsuite tests=…> attributes, which not
    // every JUnit writer sets: then the cases themselves are the counts.
    if (cases.length && !(job.summary?.total > 0)){
      job.summary = { ...job.summary, ...countsFromCases(cases) };
    }
    await report(inputs, ctx, job, cases);
    if (job.state !== 'PASSED'){
      log.error(`Job ${job.id} ${job.state}${job.message ? `: ${job.message}` : ''} — ${ctx.jobUrl}`);
    }
  }
  catch (err){
    log.warning(`The job ran, but its report couldn't be made: ${err.message}`);
  }
  return inputs.failOnVerdict ? exitCode : 0;
}

if (require.main === module){
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      log.error(err.stack || err.message);
      process.exit(1);
    });
}

module.exports = { main, runAgent, junitCases };
