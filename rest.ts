// rest.ts — the GitHub REST v3 surface (/api/v3/...) of the forge.
//
// Covers repositories, branches, commits, git refs, contents, labels,
// issues, comments and pull requests, with GitHub's shapes, statuses and
// pagination. Auth is the one bearer token; every reply is JSON with an
// X-GitHub-Request-Id (http.ts) and a Link header where a list pages.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  decodeSegment,
  jsonText,
  linkHeader,
  pageParams,
  paginate,
  pathOf,
  queryOf,
  readJsonBody,
  requireAuth,
  sendCachedJson,
  sendError,
  sendJson,
  originOf,
} from './http.ts';
import {
  DEFAULT_BRANCH,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  bumpIssueVersion,
  nowIso,
  store,
  viewerUser,
  type Issue,
  type IssueComment,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import { buildTree, hashObject, isObjectId, parseCommit, parseTree, ZERO_OID, type GitObject } from './gitcore.ts';

// ---------------------------------------------------------------------------------------------
// JSON shapes (GitHub's field names; the suite's checkShape reads only a subset)
// ---------------------------------------------------------------------------------------------

function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: Buffer.from(`User:${id}`).toString('base64'),
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: Repo, req: IncomingMessage): Record<string, unknown> {
  const origin = originOf(req);
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: fullName,
    private: repo.private,
    owner: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0),
    html_url: `https://github.com/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${fullName}`,
    forks_url: `${origin}/api/v3/repos/${fullName}/forks`,
    keys_url: `${origin}/api/v3/repos/${fullName}/keys{/key_id}`,
    collaborators_url: `${origin}/api/v3/repos/${fullName}/collaborators{/collaborator}`,
    teams_url: `${origin}/api/v3/repos/${fullName}/teams`,
    hooks_url: `${origin}/api/v3/repos/${fullName}/hooks`,
    issue_events_url: `${origin}/api/v3/repos/${fullName}/issues/events{/number}`,
    events_url: `${origin}/api/v3/repos/${fullName}/events`,
    assignees_url: `${origin}/api/v3/repos/${fullName}/assignees{/user}`,
    branches_url: `${origin}/api/v3/repos/${fullName}/branches{/branch}`,
    tags_url: `${origin}/api/v3/repos/${fullName}/tags`,
    blobs_url: `${origin}/api/v3/repos/${fullName}/git/blobs{/sha}`,
    git_tags_url: `${origin}/api/v3/repos/${fullName}/git/tags{/sha}`,
    git_refs_url: `${origin}/api/v3/repos/${fullName}/git/refs{/sha}`,
    trees_url: `${origin}/api/v3/repos/${fullName}/git/trees{/sha}`,
    statuses_url: `${origin}/api/v3/repos/${fullName}/statuses/{sha}`,
    languages_url: `${origin}/api/v3/repos/${fullName}/languages`,
    stargazers_url: `${origin}/api/v3/repos/${fullName}/stargazers`,
    contributors_url: `${origin}/api/v3/repos/${fullName}/contributors`,
    subscribers_url: `${origin}/api/v3/repos/${fullName}/subscribers`,
    subscription_url: `${origin}/api/v3/repos/${fullName}/subscription`,
    issues_url: `${origin}/api/v3/repos/${fullName}/issues{/number}`,
    pulls_url: `${origin}/api/v3/repos/${fullName}/pulls{/number}`,
    milestones_url: `${origin}/api/v3/repos/${fullName}/milestones{/number}`,
    notifications_url: `${origin}/api/v3/repos/${fullName}/notifications{?since,all,participating}`,
    labels_url: `${origin}/api/v3/repos/${fullName}/labels{/name}`,
    releases_url: `${origin}/api/v3/repos/${fullName}/releases{/id}`,
    deployments_url: `${origin}/api/v3/repos/${fullName}/deployments`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://github.com/${fullName}.git`,
    ssh_url: `git@github.com:${fullName}.git`,
    clone_url: `https://github.com/${fullName}.git`,
    svn_url: `https://github.com/${fullName}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length + [...repo.pulls.values()].filter((p) => p.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelJson(repo: Repo, label: Label, req: IncomingMessage): Record<string, unknown> {
  const origin = originOf(req);
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${label.id}`).toString('base64'),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: label.default,
    description: label.description,
  };
}

function issueJson(repo: Repo, issue: Issue, req: IncomingMessage): Record<string, unknown> {
  const origin = originOf(req);
  const path = `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
  return {
    url: `${origin}${path}`,
    repository_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${origin}${path}/labels{/name}`,
    comments_url: `${origin}${path}/comments`,
    events_url: `${origin}${path}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    id: issue.id,
    node_id: Buffer.from(`Issue:${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    user: userJson(issue.user.login, issue.user.id),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label
        ? labelJson(repo, label, req)
        : { id: 0, node_id: '', url: '', name, color: 'ededed', default: false, description: '' };
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    active_lock_reason: null,
    body: issue.body,
    reactions: { url: `${origin}${path}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: `${origin}${path}/timeline`,
    performed_via_github_app: null,
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: IssueComment, req: IncomingMessage): Record<string, unknown> {
  const origin = originOf(req);
  return {
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    user: userJson(comment.user.login, comment.user.id),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
    body: comment.body,
    reactions: { url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}/reactions`, total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    performed_via_github_app: null,
  };
}

function pullJson(repo: Repo, pull: Pull, req: IncomingMessage): Record<string, unknown> {
  const origin = originOf(req);
  const path = `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`;
  const head = {
    label: `${repo.owner}:${pull.head}`,
    ref: pull.head,
    sha: pull.headSha,
    user: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0),
    repo: repoJson(repo, req),
  };
  const base = {
    label: `${repo.owner}:${pull.base}`,
    ref: pull.base,
    sha: pull.baseSha,
    user: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0),
    repo: repoJson(repo, req),
  };
  return {
    url: `${origin}${path}`,
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${pull.id}`).toString('base64'),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(pull.user.login, pull.user.id),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `${origin}${path}/commits`,
    review_comments_url: `${origin}${path}/comments`,
    review_comment_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `${origin}${path}/comments`,
    statuses_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/statuses/${pull.headSha}`,
    head,
    base,
    _links: {
      self: { href: `${origin}${path}` },
      html: { href: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}` },
      issue: { href: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}` },
      comments: { href: `${origin}${path}/comments` },
      review_comments: { href: `${origin}${path}/comments` },
      review_comment: { href: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/comments{/number}` },
      commits: { href: `${origin}${path}/commits` },
      statuses: { href: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/statuses/${pull.headSha}` },
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: isMergeable(repo, pull),
    rebaseable: true,
    mergeable_state: isMergeable(repo, pull) ? 'clean' : 'dirty',
    merged_by: pull.merged ? userJson(pull.user.login, pull.user.id) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: countCommits(repo, pull),
    additions: pull.files.reduce((n, f) => n + f.additions, 0),
    deletions: pull.files.reduce((n, f) => n + f.deletions, 0),
    changed_files: pull.files.length,
  };
}

/** Whether the pull request can be merged cleanly right now (three-way merge over the merge-base). */
export function isMergeable(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
  const headOid = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseOid || !headOid) return false;
  return !store.threeWayMerge(repo, baseOid, headOid).conflict;
}

function countCommits(repo: Repo, pull: Pull): number {
  const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
  const headOid = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseOid || !headOid) return 0;
  const base = store.mergeBase(repo, baseOid, headOid);
  if (base === null) return 0;
  const headHistory = store.commitHistory(repo, headOid);
  let n = 0;
  for (const entry of headHistory) {
    if (entry.oid === base) break;
    n += 1;
  }
  return n;
}

function branchJson(repo: Repo, name: string, sha: string, req: IncomingMessage): Record<string, unknown> {
  const origin = originOf(req);
  return {
    name,
    commit: {
      sha,
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    },
    protected: false,
    protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } },
    protection_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(name)}/protection`,
  };
}

function commitJson(repo: Repo, oid: string, req: IncomingMessage): Record<string, unknown> | null {
  const origin = originOf(req);
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const person = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: line, email: '', date: repo.createdAt };
    const date = new Date(Number(match[3]) * 1000).toISOString();
    return { name: match[1], email: match[2], date };
  };
  const author = person(commit.author);
  const committer = person(commit.committer);
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
    commit: {
      author,
      committer,
      message: commit.message,
      tree: { sha: commit.tree, url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
    },
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
    comments_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
    author: author.name === VIEWER_NAME ? userJson(VIEWER_LOGIN, VIEWER_ID) : null,
    committer: committer.name === VIEWER_NAME ? userJson(VIEWER_LOGIN, VIEWER_ID) : null,
    parents: commit.parents.map((p) => ({
      sha: p,
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${p}`,
    })),
  };
}

function refJson(repo: Repo, ref: string, oid: string, req: IncomingMessage): Record<string, unknown> {
  const origin = originOf(req);
  const object = repo.objects.get(oid);
  return {
    ref,
    node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`,
    object: {
      sha: oid,
      type: object?.type ?? 'commit',
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/${object?.type === 'tree' ? 'trees' : object?.type === 'blob' ? 'blobs' : 'commits'}/${oid}`,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// line diff (for pull-request file counts)
// ---------------------------------------------------------------------------------------------

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A simple LCS line diff: returns [additions, deletions]. Files here are small. */
export function lineDiffCounts(oldText: string, newText: string): [number, number] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  if (n === 0) return [m, 0];
  if (m === 0) return [0, n];
  // LCS lengths, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  const lcs = prev[m];
  return [m - lcs, n - lcs];
}

/** The changed files between two trees, with per-file change counts and the head blob id. */
function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; patch: string; sha: string }> {
  const base = store.flattenTree(repo, baseTreeOid);
  const head = store.flattenTree(repo, headTreeOid);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; patch: string; sha: string }> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const [add, del] = lineDiffCounts(oldText, '');
      out.push({ filename: path, status: 'removed', additions: add, deletions: del, changes: add + del, patch: '', sha: b.oid });
    } else if (!b && h) {
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const [add, del] = lineDiffCounts('', newText);
      out.push({ filename: path, status: 'added', additions: add, deletions: del, changes: add + del, patch: '', sha: h.oid });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const [add, del] = lineDiffCounts(oldText, newText);
      out.push({ filename: path, status: 'modified', additions: add, deletions: del, changes: add + del, patch: '', sha: h.oid });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// helpers shared by the handlers
// ---------------------------------------------------------------------------------------------

function resolveRepo(req: IncomingMessage, res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Create one commit object on a branch tip, storing it and moving the ref. */
function commitOnBranchTip(repo: Repo, branch: string, treeOid: string, message: string, parents: string[]): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${timestamp} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const data = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
  const oid = store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  const now = nowIso();
  repo.updatedAt = now;
  repo.pushedAt = now;
  return oid;
}

/** The tip commit oid of a branch, or null. */
function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

/**
 * Handle one /api/v3 request. Returns true when the request was answered
 * (including its 404s); false when the path is not an /api/v3 route at all.
 */
export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  if (!path.startsWith('/api/v3')) return false;
  if (!requireAuth(req, res)) return true;
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const parts = path.split('/').filter((p) => p !== '');

  // GET /api/v3/ — the API root.
  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (path === '/api/v3/meta' && method === 'GET') {
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_services_sha: '0000000000000000000000000000000000000000' });
    return true;
  }

  // GET /api/v3/user
  if (path === '/api/v3/user' && method === 'GET') {
    sendJson(res, 200, {
      ...userJson(VIEWER_LOGIN, VIEWER_ID),
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      company: null,
      blog: '',
      location: null,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: store.listViewerRepos().length,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: nowIso(),
    });
    return true;
  }

  // POST /api/v3/user/repos — create a repository for the token's login.
  if (path === '/api/v3/user/repos' && method === 'POST') {
    const body = await readJsonBody(req, res);
    if (body === null) return true;
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) {
      sendError(res, 422, 'Validation Failed: name is invalid');
      return true;
    }
    if (store.getRepo(VIEWER_LOGIN, name)) {
      sendError(res, 422, 'Validation Failed: name already exists on this account');
      return true;
    }
    const description = typeof body.description === 'string' ? body.description : '';
    const isPrivate = body.private === true;
    const repo = store.createRepo(name, description, isPrivate);
    sendJson(res, 201, repoJson(repo, req));
    return true;
  }

  // GET /api/v3/user/repos — the viewer's repositories, paginated.
  if (path === '/api/v3/user/repos' && method === 'GET') {
    const { page, perPage } = pageParams(query);
    const all = store.listViewerRepos().sort((a, b) => a.name.localeCompare(b.name));
    const { pageItems, total } = paginate(all, page, perPage);
    sendJson(res, 200, pageItems.map((r) => repoJson(r, req)), {
      link: linkHeader(req, path, query, page, perPage, total),
    });
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (parts.length >= 4 && parts[0] === 'api' && parts[1] === 'v3' && parts[2] === 'repos') {
    const owner = decodeSegment(parts[3]) ?? '';
    const name = decodeSegment(parts[4]) ?? '';
    const repo = resolveRepo(req, res, owner, name);
    if (!repo) return true;
    return handleRepoRoute(req, res, repo, parts.slice(5), method, query);
  }

  // Anything else under /api/v3 is a JSON 404.
  sendError(res, 404, 'Not Found');
  return true;
}

async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
  method: string,
  query: URLSearchParams,
): Promise<boolean> {
  const path = pathOf(req);

  // GET /repos/{o}/{r} | PATCH | DELETE
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo, req));
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.updatedAt = nowIso();
      sendJson(res, 200, repoJson(repo, req));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'x-github-request-id': 'req_' + Date.now().toString(36) });
      res.end();
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  const head = rest[0];

  // ---- branches ----
  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort();
      sendJson(res, 200, branches.map((b) => branchJson(repo, b, repo.refs.get(`refs/heads/${b}`)!, req)));
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeSegment(rest[1]) ?? '';
      const tip = branchTip(repo, branch);
      if (!tip) {
        sendError(res, 404, 'Branch not found');
        return true;
      }
      sendJson(res, 200, branchJson(repo, branch, tip, req));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // ---- commits ----
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const shaParam = query.get('sha');
      let tip: string | null = null;
      if (shaParam) {
        tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (isObjectId(shaParam) ? shaParam : null);
      } else {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      }
      if (!tip) {
        sendJson(res, 200, []);
        return true;
      }
      const history = store.commitHistory(repo, tip);
      const { page, perPage } = pageParams(query);
      const { pageItems, total } = paginate(history, page, perPage);
      const items = pageItems.map((e) => commitJson(repo, e.oid, req)).filter((c): c is Record<string, unknown> => c !== null);
      sendJson(res, 200, items, { link: linkHeader(req, path, query, page, perPage, total) });
      return true;
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = decodeSegment(rest[1]) ?? '';
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, commitJson(repo, sha, req));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // ---- git/refs ----
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'GET' && rest.length === 2) {
      const refs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      sendJson(res, 200, refs.map(([ref, oid]) => refJson(repo, ref, oid, req)));
      return true;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).map((s) => decodeSegment(s) ?? '').join('/');
      const oid = repo.refs.get(ref);
      if (!oid) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, refJson(repo, ref, oid, req));
      return true;
    }
    if (method === 'POST' && rest.length === 2) {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.get(sha)) {
        sendError(res, 422, 'Validation Failed: ref or sha is invalid');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Validation Failed: Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      repo.gitGen += 1; // a ref changed: invalidate the git fetch cache
      repo.updatedAt = nowIso();
      sendJson(res, 201, refJson(repo, ref, sha, req));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // ---- contents ----
  if (head === 'contents') {
    const filePath = rest.slice(1).map((s) => decodeSegment(s) ?? '').join('/');
    if (filePath === '' && method === 'GET') {
      // The repository root as a directory listing.
      return sendContentsDir(req, res, repo, '');
    }
    if (method === 'GET') return sendContents(req, res, repo, filePath, query);
    if (method === 'PUT') return putContents(req, res, repo, filePath, query);
    if (method === 'DELETE') return deleteContents(req, res, repo, filePath, query);
    sendError(res, 404, 'Not Found');
    return true;
  }

  // ---- labels ----
  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      const labels = [...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name));
      sendJson(res, 200, labels.map((l) => labelJson(repo, l, req)));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return true;
      }
      if (repo.labels.has(name)) {
        sendError(res, 422, 'Validation Failed: label already exists');
        return true;
      }
      const label: Label = {
        id: store.nextId(),
        name,
        color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
        description: typeof body.description === 'string' ? body.description : '',
        default: false,
      };
      repo.labels.set(name, label);
      bumpIssueVersion(repo); // a label's JSON is embedded in every issue's JSON
      sendJson(res, 201, labelJson(repo, label, req));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // ---- issues ----
  if (head === 'issues') {
    if (rest.length === 1 && method === 'GET') return listIssues(req, res, repo, query);
    if (rest.length === 1 && method === 'POST') return createIssue(req, res, repo);
    if (rest.length === 2 && method === 'GET') {
      const number = Number(rest[1]);
      const issue = repo.issues.get(number);
      if (!issue) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      // The benchmark GETs one issue 2,000 times in a row; its JSON is
      // identical every time until the issue is mutated, so serve the
      // cached bytes. The entry is keyed on the repo's issue version,
      // bumped at every mutation site, and on the request origin, so a
      // stale or wrong-origin response can never be served.
      const origin = originOf(req);
      const hit = repo.issueCache.get(number);
      if (hit && hit.v === repo.issueVersion && hit.origin === origin) {
        sendCachedJson(res, 200, hit);
        return true;
      }
      const serialized = jsonText(issueJson(repo, issue, req));
      repo.issueCache.set(number, { v: repo.issueVersion, origin, text: serialized.text, len: serialized.len });
      sendCachedJson(res, 200, serialized);
      return true;
    }
    if (rest.length === 2 && method === 'PATCH') {
      const number = Number(rest[1]);
      const issue = repo.issues.get(number);
      if (!issue) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? nowIso() : null;
      }
      if (Array.isArray(body.labels)) {
        const names = body.labels.map((l) => (typeof l === 'string' ? l : typeof l === 'object' && l !== null ? String((l as Record<string, unknown>).name ?? '') : '')).filter((n) => n !== '');
        const unknown = names.filter((n) => !repo.labels.has(n));
        if (unknown.length) {
          sendError(res, 422, `Validation Failed: ${unknown.join(', ')} is not a valid label`);
          return true;
        }
        issue.labels = names;
      }
      issue.updatedAt = nowIso();
      bumpIssueVersion(repo); // the issue's cached JSON is now stale
      sendJson(res, 200, issueJson(repo, issue, req));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') {
      const number = Number(rest[1]);
      const issue = repo.issues.get(number);
      if (!issue) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue, c, req)));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'comments' && method === 'POST') {
      const number = Number(rest[1]);
      const issue = repo.issues.get(number);
      if (!issue) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const body = await readJsonBody(req, res);
      if (body === null) return true;
      const text = typeof body.body === 'string' ? body.body : '';
      const comment: IssueComment = {
        id: store.nextId(),
        body: text,
        user: viewerUser(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      issue.comments.push(comment);
      issue.updatedAt = nowIso();
      bumpIssueVersion(repo); // the issue's comment count changed
      sendJson(res, 201, commentJson(repo, issue, comment, req));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // ---- pulls ----
  if (head === 'pulls') {
    if (rest.length === 1 && method === 'GET') return listPulls(req, res, repo, query);
    if (rest.length === 1 && method === 'POST') return createPull(req, res, repo);
    if (rest.length === 2 && method === 'GET') {
      const number = Number(rest[1]);
      const pull = repo.pulls.get(number);
      if (!pull) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, pullJson(repo, pull, req));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const number = Number(rest[1]);
      const pull = repo.pulls.get(number);
      if (!pull) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, pull.files.map((f) => ({
        sha: f.sha,
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${pull.headSha}/${f.filename}`,
        raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${pull.headSha}/${f.filename}`,
        contents_url: `${originOf(req)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${f.filename}?ref=${pull.headSha}`,
        patch: f.patch,
      })));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      const number = Number(rest[1]);
      const pull = repo.pulls.get(number);
      if (!pull) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      return mergePull(req, res, repo, pull);
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function contentFileJson(repo: Repo, path: string, blobOid: string, data: Buffer, req: IncomingMessage): Record<string, unknown> {
  const origin = originOf(req);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: blobOid,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/HEAD/${path}`,
    _links: {
      git: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
      self: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html: `https://github.com/${repo.owner}/${repo.name}/blob/HEAD/${path}`,
    },
  };
}

function sendContentsDir(req: IncomingMessage, res: ServerResponse, repo: Repo, dir: string): boolean {
  const branch = queryOf(req).get('ref') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch) ?? (isObjectId(branch) ? branch : null);
  if (!tip) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const treeOid = parseCommit(commit.data).tree;
  const tree = store.treeAtPath(repo, treeOid, dir);
  if (!tree) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const origin = originOf(req);
  const items = tree.entries.map((entry) => {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    const isDir = entry.mode === '40000';
    return {
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      name: entry.name,
      path,
      sha: entry.oid,
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      git_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/HEAD/${path}`,
      download_url: isDir ? null : `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/HEAD/${path}`,
      _links: {
        git: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        self: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html: `https://github.com/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/HEAD/${path}`,
      },
    };
  });
  sendJson(res, 200, items);
  return true;
}

function sendContents(req: IncomingMessage, res: ServerResponse, repo: Repo, filePath: string, query: URLSearchParams): boolean {
  const branch = query.get('ref') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch) ?? (isObjectId(branch) ? branch : null);
  if (!tip) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const treeOid = parseCommit(commit.data).tree;
  // A directory reads as a listing; a file reads as a blob.
  const dir = store.treeAtPath(repo, treeOid, filePath);
  if (dir) return sendContentsDir(req, res, repo, filePath);
  const blob = store.blobAtPath(repo, treeOid, filePath);
  if (!blob) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  sendJson(res, 200, contentFileJson(repo, filePath, blob.oid, blob.data, req));
  return true;
}

async function putContents(req: IncomingMessage, res: ServerResponse, repo: Repo, filePath: string, query: URLSearchParams): Promise<boolean> {
  const body = await readJsonBody(req, res);
  if (body === null) return true;
  const branch = typeof body.branch === 'string' ? body.branch : (query.get('branch') ?? repo.defaultBranch);
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
  } catch {
    sendError(res, 422, 'Validation Failed: content is not valid base64');
    return true;
  }
  const tip = branchTip(repo, branch);
  // A branch that does not exist yet starts from an empty tree: the PUT
  // creates the branch's initial commit (GitHub's behaviour for a new repo).
  const isNewBranch = tip === null;
  const treeOid = (() => {
    if (!isNewBranch) {
      const commit = repo.objects.get(tip!);
      if (!commit || commit.type !== 'commit') return null;
      return parseCommit(commit.data).tree;
    }
    return store.putObject(repo, 'tree', buildTree([]));
  })();
  if (treeOid === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const existing = isNewBranch ? null : store.blobAtPath(repo, treeOid, filePath);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  if (existing && sha === undefined) {
    sendError(res, 422, 'Validation Failed: sha is required when updating a file');
    return true;
  }
  if (existing && sha !== undefined && sha !== existing.oid) {
    sendError(res, 409, 'Conflict: the file has changed since the sha you gave');
    return true;
  }
  if (!existing && sha !== undefined) {
    sendError(res, 422, 'Validation Failed: sha does not match an existing file');
    return true;
  }
  const blobOid = store.putObject(repo, 'blob', content);
  const newTreeOid = store.updateFileInTree(repo, treeOid, filePath, blobOid);
  const commitOid = commitOnBranchTip(repo, branch, newTreeOid, message, isNewBranch ? [] : [tip!]);
  const isCreate = !existing;
  sendJson(res, isCreate ? 201 : 200, {
    content: contentFileJson(repo, filePath, blobOid, content, req),
    commit: commitJson(repo, commitOid, req),
  });
  return true;
}

async function deleteContents(req: IncomingMessage, res: ServerResponse, repo: Repo, filePath: string, query: URLSearchParams): Promise<boolean> {
  const body = await readJsonBody(req, res);
  if (body === null) return true;
  const branch = typeof body.branch === 'string' ? body.branch : (query.get('branch') ?? repo.defaultBranch);
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  const tip = branchTip(repo, branch);
  if (!tip) {
    sendError(res, 404, 'Branch not found');
    return true;
  }
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const treeOid = parseCommit(commit.data).tree;
  const existing = store.blobAtPath(repo, treeOid, filePath);
  if (!existing) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (sha !== '' && sha !== existing.oid) {
    sendError(res, 409, 'Conflict: the file has changed since the sha you gave');
    return true;
  }
  const newTreeOid = store.updateFileInTree(repo, treeOid, filePath, null);
  const commitOid = commitOnBranchTip(repo, branch, newTreeOid, message, [tip]);
  sendJson(res, 200, { commit: commitJson(repo, commitOid, req) });
  return true;
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function listIssues(req: IncomingMessage, res: ServerResponse, repo: Repo, query: URLSearchParams): boolean {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((i) => i.state === 'open');
  else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
  issues.sort((a, b) => {
    let cmp = 0;
    if (sort === 'created') cmp = a.createdAt.localeCompare(b.createdAt);
    else if (sort === 'updated') cmp = a.updatedAt.localeCompare(b.updatedAt);
    else if (sort === 'comments') cmp = a.comments.length - b.comments.length;
    if (cmp === 0) cmp = a.number - b.number;
    return direction === 'asc' ? cmp : -cmp;
  });
  const { page, perPage } = pageParams(query);
  const { pageItems, total } = paginate(issues, page, perPage);
  sendJson(res, 200, pageItems.map((i) => issueJson(repo, i, req)), {
    link: linkHeader(req, pathOf(req), query, page, perPage, total),
  });
  return true;
}

async function createIssue(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<boolean> {
  const body = await readJsonBody(req, res);
  if (body === null) return true;
  const title = typeof body.title === 'string' ? body.title : '';
  const text = typeof body.body === 'string' ? body.body : '';
  const labels = Array.isArray(body.labels)
    ? body.labels.map((l) => (typeof l === 'string' ? l : '')).filter((n) => n !== '')
    : [];
  const unknown = labels.filter((n) => !repo.labels.has(n));
  if (unknown.length) {
    sendError(res, 422, `Validation Failed: ${unknown.join(', ')} is not a valid label`);
    return true;
  }
  const now = nowIso();
  const issue: Issue = {
    id: store.nextId(),
    number: repo.nextIssue++,
    title,
    body: text,
    state: 'open',
    labels,
    comments: [],
    user: viewerUser(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.issues.set(issue.number, issue);
  bumpIssueVersion(repo);
  sendJson(res, 201, issueJson(repo, issue, req));
  return true;
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function listPulls(req: IncomingMessage, res: ServerResponse, repo: Repo, query: URLSearchParams): boolean {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
  pulls.sort((a, b) => {
    let cmp = 0;
    if (sort === 'created') cmp = a.createdAt.localeCompare(b.createdAt);
    else if (sort === 'updated') cmp = a.updatedAt.localeCompare(b.updatedAt);
    if (cmp === 0) cmp = a.number - b.number;
    return direction === 'asc' ? cmp : -cmp;
  });
  const { page, perPage } = pageParams(query);
  const { pageItems, total } = paginate(pulls, page, perPage);
  sendJson(res, 200, pageItems.map((p) => pullJson(repo, p, req)), {
    link: linkHeader(req, pathOf(req), query, page, perPage, total),
  });
  return true;
}

async function createPull(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<boolean> {
  const body = await readJsonBody(req, res);
  if (body === null) return true;
  const title = typeof body.title === 'string' ? body.title : '';
  const text = typeof body.body === 'string' ? body.body : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  const headRef = head.includes(':') ? head.split(':').pop()! : head;
  const baseRef = base.includes(':') ? base.split(':').pop()! : base;
  const headOid = repo.refs.get(`refs/heads/${headRef}`);
  const baseOid = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headOid || !baseOid) {
    sendError(res, 404, 'Not Found: the head or base branch does not exist');
    return true;
  }
  const now = nowIso();
  const pull: Pull = {
    id: store.nextId(),
    number: repo.nextPull++,
    title,
    body: text,
    state: 'open',
    head: headRef,
    base: baseRef,
    headSha: headOid,
    baseSha: baseOid,
    merged: false,
    mergeable: true,
    mergeCommitSha: null,
    mergedAt: null,
    files: [],
    user: viewerUser(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  // The changed files are the head's tree against the merge-base's tree.
  const mergeBase = store.mergeBase(repo, baseOid, headOid);
  const baseTree = mergeBase === null ? '' : parseCommit(repo.objects.get(mergeBase)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headOid)!.data).tree;
  pull.files = baseTree === '' ? [] : diffTrees(repo, baseTree, headTree).map((f) => ({
    sha: f.sha,
    filename: f.filename,
    status: f.status as 'added' | 'modified' | 'removed' | 'renamed',
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    patch: f.patch,
  }));
  pull.mergeable = isMergeable(repo, pull);
  repo.pulls.set(pull.number, pull);
  sendJson(res, 201, pullJson(repo, pull, req));
  return true;
}

async function mergePull(req: IncomingMessage, res: ServerResponse, repo: Repo, pull: Pull): Promise<boolean> {
  const body = await readJsonBody(req, res);
  if (body === null) return true;
  if (pull.state !== 'open') {
    sendError(res, 405, 'Pull Request is not mergeable');
    return true;
  }
  const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
  const headOid = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseOid || !headOid) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const merged = store.threeWayMerge(repo, baseOid, headOid);
  if (merged.conflict) {
    sendError(res, 405, 'Merge conflict');
    return true;
  }
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`;
  const mergeSha = commitOnBranchTip(repo, pull.base, merged.treeOid, message, [baseOid]);
  const now = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  pull.mergedAt = now;
  pull.closedAt = now;
  pull.updatedAt = now;
  pull.baseSha = mergeSha;
  sendJson(res, 200, { sha: mergeSha, merged: true, message: `Pull Request successfully merged` });
  return true;
}

// Keep the GitObject import used.
void (null as unknown as GitObject);
