/**
 * @file        action/src/inputs.js
 * @description The action's inputs, and the `thub run` command line they become
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

const AGENT_PACKAGE = '@andrian.yablonskyy/thub-agent';

// action.yml hands every input over as INPUT_<NAME> (upper case, `-` kept).
function getInput(name, env = process.env){
  return String(env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
}

function getBool(name, env = process.env, fallback = false){
  const v = getInput(name, env).toLowerCase();
  if (!v){
    return fallback;
  }
  if (['true', 'yes', '1', 'on'].includes(v)){
    return true;
  }
  if (['false', 'no', '0', 'off'].includes(v)){
    return false;
  }
  throw new Error(`Input ${name}: expected true or false, got "${v}"`);
}

// A multi-line input: one value per line; blank lines and `#` comments skipped.
function getList(name, env = process.env){
  return getInput(name, env).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// Every input as the action uses it, checked. Throws with what's wrong.
function readInputs(env = process.env){
  const inputs = {
      url: getInput('url', env).replace(/\/+$/, ''),
      key: getInput('key', env),
      type: getInput('type', env),
      command: getInput('command', env),
      labels: getList('labels', env).flatMap((l) => l.split(',')).map((l) => l.trim()).filter(Boolean),
      client: getInput('client', env),
      downloadFiles: getList('download-files', env),
      env: getList('env', env),
      args: getList('args', env),
      suite: getInput('suite', env),
      timeout: getInput('timeout', env),
      priority: getInput('priority', env),
      meta: getList('meta', env),
      dryRun: getBool('dry-run', env),
      powerOnStart: getInput('power-on-start', env),
      powerOnEnd: getInput('power-on-end', env),
      powerResetDelay: getInput('power-reset-delay', env),
      agent: getInput('agent', env),
      agentVersion: getInput('agent-version', env) || 'latest',
      failOnVerdict: getBool('fail', env, true),
      summary: getBool('summary', env, true),
      comment: (getInput('comment', env) || 'true').toLowerCase(),
      name: getInput('name', env),
      commentKey: getInput('comment-key', env),
      commitStatus: getBool('commit-status', env),
      prNumber: getInput('pr-number', env),
      artifactHeaders: getList('artifact-headers', env),
      githubToken: getInput('github-token', env)
    },
    missing = ['url', 'key', 'type', 'command'].filter((k) => !inputs[k]);
  if (missing.length){
    throw new Error(`Missing required input(s): ${missing.join(', ')}`);
  }
  if (!/^https?:\/\//.test(inputs.url)){
    throw new Error(`Input url: must start with http:// or https://, got "${inputs.url}"`);
  }
  if (!['hw', 'sw'].includes(inputs.type)){
    throw new Error(`Input type: must be hw or sw, got "${inputs.type}"`);
  }
  if (!['true', 'false', 'on-failure'].includes(inputs.comment)){
    throw new Error(`Input comment: must be true, false or on-failure, got "${inputs.comment}"`);
  }
  for (const h of inputs.artifactHeaders){
    if (!/^[A-Za-z0-9-]+:\s*\S/.test(h)){
      throw new Error('Input artifact-headers: one "Name: value" per line');
    }
  }
  return inputs;
}

// What this run is, for --meta on the job: the job page then links back to it.
function githubMeta(env = process.env, event = {}){
  const server = env.GITHUB_SERVER_URL || 'https://github.com',
    repo = env.GITHUB_REPOSITORY,
    pr = event.pull_request,
    meta = {
      githubRun: repo && env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null,
      githubRepo: repo || null,
      githubSha: pr?.head?.sha || env.GITHUB_SHA || null,
      githubRef: pr?.head?.ref || env.GITHUB_REF_NAME || null,
      githubPr: pr?.number ? String(pr.number) : null,
      githubActor: env.GITHUB_ACTOR || null
    };
  return Object.entries(meta).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
}

// The command that runs `thub run … --wait --json`: the published Agent
// through npx, or `agent` (e.g. a thub already installed on the runner).
function agentCommand(inputs, meta = []){
  const run = ['run', '--type', inputs.type, '--command', inputs.command, '--wait', '--json'],
    add = (flag, values) => {
      for (const v of [].concat(values)){
        if (v !== '' && v !== undefined && v !== null){
          run.push(flag, String(v));
        }
      }
    };
  add('--label', inputs.labels);
  add('--client', inputs.client);
  add('--download-file', inputs.downloadFiles);
  add('--env', inputs.env);
  add('--arg', inputs.args);
  add('--suite', inputs.suite);
  add('--timeout', inputs.timeout);
  add('--priority', inputs.priority);
  // The caller's own --meta wins over the GitHub ones of the same key.
  const own = new Set(inputs.meta.map((m) => m.split('=')[0]));
  add('--meta', [...meta.filter((m) => !own.has(m.split('=')[0])), ...inputs.meta]);
  add('--power-on-start', inputs.powerOnStart);
  add('--power-on-end', inputs.powerOnEnd);
  add('--power-reset-delay', inputs.powerResetDelay);
  if (inputs.dryRun){
    run.push('--dry-run');
  }
  if (inputs.agent){
    const [cmd, ...pre] = inputs.agent.split(/\s+/);
    return { cmd, args: [...pre, ...run] };
  }
  return { cmd: 'npx', args: ['-y', `${AGENT_PACKAGE}@${inputs.agentVersion}`, ...run] };
}

module.exports = { getInput, getBool, getList, readInputs, githubMeta, agentCommand, AGENT_PACKAGE };
