/**
 * @file        action/src/github.js
 * @description The GitHub side: step outputs, the Job Summary, the sticky pull-request comment and the commit status
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

const fs = require('node:fs'),
  crypto = require('node:crypto'),
  { commentMarker } = require('./report');

// Workflow commands (stdout) and the files the runner reads.
const log = {
  warning: (msg) => console.log(`::warning title=TestHub::${escapeData(msg)}`),
  error: (msg) => console.log(`::error title=TestHub::${escapeData(msg)}`),
  mask: (value) => value && console.log(`::add-mask::${value}`),
  group: (title) => console.log(`::group::${title}`),
  endGroup: () => console.log('::endgroup::')
};

function escapeData(s){
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

// name=value, or a here-document for values with newlines.
function setOutputs(file, outputs){
  if (!file){
    return;
  }
  const lines = Object.entries(outputs).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => {
    const s = String(v);
    if (!s.includes('\n')){
      return `${k}=${s}`;
    }
    const eof = `EOF_${crypto.randomUUID()}`;
    return `${k}<<${eof}\n${s}\n${eof}`;
  });
  fs.appendFileSync(file, lines.join('\n') + '\n');
}

function appendSummary(file, markdown){
  if (file){
    fs.appendFileSync(file, markdown + '\n');
  }
}

// The workflow's event payload (pull_request, push, …).
function readEvent(file){
  try {
    return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  catch {
    return {};
  }
}

// The pull request this run is about: the event's, or an explicit number.
function prNumber(event, explicit){
  const n = Number(explicit || event.pull_request?.number || (event.issue?.pull_request ? event.issue.number : NaN));
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The commit the verdict is about: a PR's head, else the pushed commit.
function headSha(event, env = process.env){
  return event.pull_request?.head?.sha || env.GITHUB_SHA || null;
}

class GitHub{
  constructor({ token, repo, apiUrl = 'https://api.github.com' }){
    this.token = token;
    this.repo = repo;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
  }

  async request(method, path, body){
    const res = await fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'thub-action',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      }),
      data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok){
      const err = new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${data?.message || ''}`.trim());
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Creates the comment, or updates the one an earlier run left (found by
  // its marker), so a PR has one TestHub comment per workflow job (key).
  // `create: false` only updates an existing comment (comment: on-failure,
  // once the job passes again).
  async upsertComment(issue, key, body, { create = true } = {}){
    const marker = commentMarker(key);
    let existing = null;
    for (let page = 1; page <= 10 && !existing; page++){
      const comments = await this.request('GET', `/repos/${this.repo}/issues/${issue}/comments?per_page=100&page=${page}`);
      existing = comments.find((c) => c.body?.startsWith(marker));
      if (comments.length < 100){
        break;
      }
    }
    if (existing){
      const updated = await this.request('PATCH', `/repos/${this.repo}/issues/comments/${existing.id}`, { body });
      return { action: 'updated', url: updated.html_url };
    }
    if (!create){
      return { action: 'skipped', url: null };
    }
    const created = await this.request('POST', `/repos/${this.repo}/issues/${issue}/comments`, { body });
    return { action: 'created', url: created.html_url };
  }

  setStatus(sha, { state, context, description, targetUrl }){
    return this.request('POST', `/repos/${this.repo}/statuses/${sha}`, {
      state, context, description: String(description).slice(0, 140), target_url: targetUrl
    });
  }
}

module.exports = { log, setOutputs, appendSummary, readEvent, prNumber, headSha, GitHub };
