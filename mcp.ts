// mcp.ts — the Model Context Protocol endpoint (POST /mcp).
//
// JSON-RPC 2.0 over Streamable HTTP, answered as plain JSON (the client
// accepts that; SSE is not needed). The modern 2026-07-28 era is served:
// `server/discover` names the supported revisions, capabilities and
// identity; `initialize` is also answered for a legacy client. The six
// tools are the github-mcp-server surface and act on the same store as the
// REST surface, so a repository or issue made here is the same object over
// REST, with the same ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, requireAuth, sendJson } from './http.ts';
import {
  DEFAULT_BRANCH,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  nowIso,
  store,
  viewerUser,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { isMergeable } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

/** The six tools, in a fixed order, so two tools/list answers are byte-identical. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'The state to filter by: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch of the pull request.' },
        base: { type: 'string', description: 'The base branch of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** A tool result: JSON in a text block and as structured content, so both readers find it. */
function toolResult(data: unknown, isError = false): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: data,
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** Resolve owner/repo from the arguments, accepting full_name and the common synonyms. */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const pick = (keys: string[]): string | null => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return null;
  };
  let owner = pick(['owner', 'owner_login', 'org', 'organization', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  let repo = pick(['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  if ((!owner || !repo)) {
    const fullName = pick(['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
    if (fullName) {
      const slash = fullName.indexOf('/');
      if (slash > 0) {
        owner = owner ?? fullName.slice(0, slash);
        repo = repo ?? fullName.slice(slash + 1);
      }
    }
  }
  if (!owner || !repo) return null;
  return { owner, repo };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${issue.id}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${pull.id}`).toString('base64'),
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: isMergeable(repo, pull),
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    headRefName: pull.head,
    baseRefName: pull.base,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function callCreateRepo(args: Record<string, unknown>): Record<string, unknown> {
  const name = typeof args.name === 'string' ? args.name : (typeof args.repo === 'string' ? args.repo : '');
  if (name === '') return toolError('create_repo requires a name');
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) return toolError(`create_repo: ${JSON.stringify(name)} is not a valid repository name`);
  if (store.getRepo(VIEWER_LOGIN, name)) return toolError(`create_repo: a repository named ${name} already exists`);
  const description = typeof args.description === 'string' ? args.description : (typeof args.body === 'string' ? args.body : '');
  const isPrivate = args.private === true || args.is_private === true;
  const repo = store.createRepo(name, description, isPrivate);
  return toolResult(repoJson(repo));
}

function callGetRepo(args: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolveOwnerRepo(args);
  if (!resolved) return toolError('get_repo requires owner and repo');
  const repo = store.getRepo(resolved.owner, resolved.repo);
  if (!repo) return toolError(`get_repo: repository ${resolved.owner}/${resolved.repo} not found`);
  return toolResult(repoJson(repo));
}

function callCreateIssue(args: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolveOwnerRepo(args);
  const title = typeof args.title === 'string' ? args.title : (typeof args.issue_title === 'string' ? args.issue_title : '');
  if (!resolved) return toolError('create_issue requires owner and repo');
  if (title === '') return toolError('create_issue requires a title');
  const repo = store.getRepo(resolved.owner, resolved.repo);
  if (!repo) return toolError(`create_issue: repository ${resolved.owner}/${resolved.repo} not found`);
  const body = typeof args.body === 'string' ? args.body : (typeof args.issue_body === 'string' ? args.issue_body : '');
  const labels = Array.isArray(args.labels) ? args.labels.map((l) => String(l)).filter((n) => repo.labels.has(n)) : [];
  const now = nowIso();
  const issue: Issue = {
    id: store.nextId(),
    number: repo.nextIssue++,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    user: viewerUser(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.issues.set(issue.number, issue);
  return toolResult(issueJson(repo, issue));
}

function callListIssues(args: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolveOwnerRepo(args);
  if (!resolved) return toolError('list_issues requires owner and repo');
  const repo = store.getRepo(resolved.owner, resolved.repo);
  if (!repo) return toolError(`list_issues: repository ${resolved.owner}/${resolved.repo} not found`);
  const state = typeof args.state === 'string' ? args.state.toLowerCase() : (typeof args.status === 'string' ? args.status.toLowerCase() : 'open');
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((i) => i.state === 'open');
  else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
  issues.sort((a, b) => b.number - a.number);
  return toolResult({ issues: issues.map((i) => issueJson(repo, i)) });
}

function callCreatePullRequest(args: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolveOwnerRepo(args);
  const title = typeof args.title === 'string' ? args.title : (typeof args.pr_title === 'string' ? args.pr_title : '');
  const head = typeof args.head === 'string' ? args.head : (typeof args.head_ref === 'string' ? args.head_ref : (typeof args.head_branch === 'string' ? args.head_branch : ''));
  const base = typeof args.base === 'string' ? args.base : (typeof args.base_ref === 'string' ? args.base_ref : (typeof args.base_branch === 'string' ? args.base_branch : DEFAULT_BRANCH));
  if (!resolved) return toolError('create_pull_request requires owner and repo');
  if (title === '') return toolError('create_pull_request requires a title');
  if (head === '') return toolError('create_pull_request requires a head branch');
  const repo = store.getRepo(resolved.owner, resolved.repo);
  if (!repo) return toolError(`create_pull_request: repository ${resolved.owner}/${resolved.repo} not found`);
  const headRef = head.includes(':') ? head.split(':').pop()! : head;
  const baseRef = base.includes(':') ? base.split(':').pop()! : base;
  const headOid = repo.refs.get(`refs/heads/${headRef}`);
  const baseOid = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headOid || !baseOid) return toolError('create_pull_request: the head or base branch does not exist');
  const body = typeof args.body === 'string' ? args.body : '';
  const now = nowIso();
  const pull: Pull = {
    id: store.nextId(),
    number: repo.nextPull++,
    title,
    body,
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
  pull.mergeable = isMergeable(repo, pull);
  repo.pulls.set(pull.number, pull);
  return toolResult(pullJson(repo, pull));
}

function callMergePullRequest(args: Record<string, unknown>): Record<string, unknown> {
  const resolved = resolveOwnerRepo(args);
  const pullNumberRaw = args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number ?? args.issue_number ?? args.index;
  const pullNumber = typeof pullNumberRaw === 'number' ? pullNumberRaw : typeof pullNumberRaw === 'string' && /^\d+$/.test(pullNumberRaw) ? Number(pullNumberRaw) : NaN;
  if (!resolved) return toolError('merge_pull_request requires owner and repo');
  if (!Number.isInteger(pullNumber)) return toolError('merge_pull_request requires a pull_number');
  const repo = store.getRepo(resolved.owner, resolved.repo);
  if (!repo) return toolError(`merge_pull_request: repository ${resolved.owner}/${resolved.repo} not found`);
  const pull = repo.pulls.get(pullNumber);
  if (!pull) return toolError(`merge_pull_request: pull request #${pullNumber} not found`);
  if (pull.state !== 'open') return toolError(`merge_pull_request: pull request #${pullNumber} is not open`);
  const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
  const headOid = repo.refs.get(`refs/heads/${pull.head}`);
  if (!baseOid || !headOid) return toolError('merge_pull_request: the head or base branch does not exist');
  const merged = store.threeWayMerge(repo, baseOid, headOid);
  if (merged.conflict) return toolError('merge_pull_request: merge conflict');
  const timestamp = Math.floor(Date.now() / 1000);
  const who = `${VIEWER_NAME} <${VIEWER_LOGIN}@example.invalid> ${timestamp} +0000`;
  const lines = [`tree ${merged.treeOid}`, `parent ${baseOid}`, `author ${who}`, `committer ${who}`, ''];
  const data = Buffer.from(`${lines.join('\n')}\nMerge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}`, 'utf8');
  const mergeSha = store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  const now = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  pull.mergedAt = now;
  pull.closedAt = now;
  pull.updatedAt = now;
  pull.baseSha = mergeSha;
  return toolResult({ ...pullJson(repo, pull), sha: mergeSha });
}

function callTool(name: string, args: Record<string, unknown>): { result: Record<string, unknown>; error: { code: number; message: string } | null } {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { result: {}, error: { code: -32602, message: `unknown tool ${name}` } };
  // A missing required argument is an isError tool result, not a JSON-RPC error.
  const missing = tool.inputSchema.required.filter((prop) => args[prop] === undefined || args[prop] === null || args[prop] === '');
  if (missing.length > 0) {
    return { result: toolError(`tools/call ${name}: missing required argument(s): ${missing.join(', ')}`), error: null };
  }
  switch (name) {
    case 'create_repo':
      return { result: callCreateRepo(args), error: null };
    case 'get_repo':
      return { result: callGetRepo(args), error: null };
    case 'create_issue':
      return { result: callCreateIssue(args), error: null };
    case 'list_issues':
      return { result: callListIssues(args), error: null };
    case 'create_pull_request':
      return { result: callCreatePullRequest(args), error: null };
    case 'merge_pull_request':
      return { result: callMergePullRequest(args), error: null };
    default:
      return { result: {}, error: { code: -32602, message: `unknown tool ${name}` } };
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/**
 * Handle one POST /mcp request. Returns true when answered; false when the
 * path is not /mcp.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (() => {
    try {
      return new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      return '/';
    }
  })();
  if (path !== '/mcp') return false;
  if (!requireAuth(req, res)) return true;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    // A body that is not JSON is HTTP 400 with JSON-RPC -32700.
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return true;
  }
  const request = parsed as JsonRpcRequest;
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // A notification (no id) gets no JSON-RPC answer.
  if (id === null && request.id === undefined) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: SUPPORTED_VERSIONS[0],
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    }));
    return true;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return true;
  }

  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return true;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return true;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!isRecord(args)) {
      sendJson(res, 200, rpcError(id, -32602, 'tools/call arguments must be an object'));
      return true;
    }
    const { result, error } = callTool(name, args);
    if (error) {
      sendJson(res, 200, rpcError(id, error.code, error.message));
      return true;
    }
    sendJson(res, 200, rpcResult(id, result));
    return true;
  }

  // Any other method is method-not-found.
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
