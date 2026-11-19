// graphql.ts — the GitHub GraphQL v4 surface (POST /api/graphql).
//
// A small GraphQL parser and executor for exactly the documents the suite
// sends (gh's queries and mutations, plus introspection probes). It answers
// one operation or a batched array of operations in order, requires the
// bearer token (401 without it), and reports an unknown field as HTTP 200
// with an errors array naming it, as GitHub does.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, requireAuth, sendError, sendJson } from './http.ts';
import {
  DEFAULT_BRANCH,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  bumpIssueVersion,
  nowIso,
  store,
  viewerUser,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { isMergeable } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// global ids and cursors (opaque, stable across reads)
// ---------------------------------------------------------------------------------------------

function encodeNodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`).toString('base64');
}

function decodeNodeId(id: string): { kind: string; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const match = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (!match) return null;
    return { kind: match[1], num: Number(match[2]) };
  } catch {
    return null;
  }
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`).toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// the schema the executor knows (field lists double as the introspection data)
// ---------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'url', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url', 'description'],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestFileConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  Ref: ['name', 'target'],
  Commit: ['oid', 'message'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

// ---------------------------------------------------------------------------------------------
// a small GraphQL document parser
// ---------------------------------------------------------------------------------------------

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selection: SelectionNode[];
}

interface FragmentSpread {
  kind: 'spread';
  name: string;
}

interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpread | InlineFragment;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { type: string; defaultValue: Value | null }>;
  selection: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Record<string, FragmentDef>;
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      // A string literal (no block strings in the documents we receive).
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    // A name, number, or $-variable.
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.$-]/.test(src[j])) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const tok = this.tokens[this.pos];
    this.pos += 1;
    return tok;
  }

  private expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments: Record<string, FragmentDef> = {};
    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (tok === 'query' || tok === 'mutation') {
        operations.push(this.parseOperation());
      } else if (tok === 'fragment') {
        const frag = this.parseFragment();
        fragments[frag.name] = frag;
      } else if (tok === '{') {
        operations.push({ kind: 'query', name: null, variables: {}, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${tok}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    const kind = this.next() as 'query' | 'mutation';
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next !== '(' && next !== '{' && next !== '@') {
      name = this.next();
    }
    const variables: Record<string, { type: string; defaultValue: Value | null }> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        if (this.peek() === '$') {
          this.next();
          const varName = this.next();
          this.expect(':');
          const type = this.parseType();
          let defaultValue: Value | null = null;
          if (this.peek() === '=') {
            this.next();
            defaultValue = this.parseValue();
          }
          variables[varName] = { type, defaultValue };
        } else {
          this.next();
        }
      }
      this.expect(')');
    }
    // Directives on the operation (ignored).
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        let depth = 0;
        while (this.pos < this.tokens.length) {
          const t = this.next();
          if (t === '(') depth += 1;
          else if (t === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
      }
    }
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  private parseType(): string {
    let type = '';
    if (this.peek() === '[') {
      this.next();
      type = `[${this.parseType()}]`;
    } else {
      type = this.next();
    }
    if (this.peek() === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseFragment(): FragmentDef {
    this.expect('fragment');
    const name = this.next();
    this.expect('on');
    const typeCondition = this.next();
    const selection = this.parseSelectionSet();
    return { name, typeCondition, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        const next = this.peek();
        if (next === 'on') {
          this.next();
          const typeCondition = this.next();
          out.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          out.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      const first = this.next();
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ':') {
        this.next();
        alias = first;
        name = this.next();
      }
      const args: Array<{ name: string; value: Value }> = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      // Directives on the field (ignored).
      while (this.peek() === '@') {
        this.next();
        this.next();
        if (this.peek() === '(') {
          let depth = 0;
          while (this.pos < this.tokens.length) {
            const t = this.next();
            if (t === '(') depth += 1;
            else if (t === ')') {
              depth -= 1;
              if (depth === 0) break;
            }
          }
        }
      }
      const selection = this.peek() === '{' ? this.parseSelectionSet() : [];
      out.push({ alias, name, args, selection });
    }
    this.expect('}');
    return out;
  }

  private parseValue(): Value {
    const tok = this.next();
    if (tok === '$') return { kind: 'variable', name: this.next() };
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: Number.parseInt(tok, 10) };
    if (/^-?\d+\.\d+$/.test(tok)) return { kind: 'float', value: Number.parseFloat(tok) };
    if (tok === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (tok === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    return { kind: 'enum', value: tok };
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GqlValue {
  __type: string;
  [key: string]: unknown;
}

interface ExecContext {
  errors: Array<{ message: string }>;
  variables: Record<string, unknown>;
  fragments: Record<string, FragmentDef>;
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'variable':
      return variables[value.name];
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, ctx: ExecContext): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, ctx.variables);
}

function repoById(databaseId: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === databaseId) return repo;
  }
  return undefined;
}

function issueById(id: number): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return undefined;
}

function pullById(id: number): { repo: Repo; pull: Pull } | undefined {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === id) return { repo, pull };
    }
  }
  return undefined;
}

function sortIssues(issues: Issue[], orderBy: { field?: string; direction?: string } | undefined): Issue[] {
  const out = [...issues];
  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction ?? 'DESC';
  out.sort((a, b) => {
    let cmp = 0;
    if (field === 'CREATED_AT') cmp = a.createdAt.localeCompare(b.createdAt);
    else if (field === 'UPDATED_AT') cmp = a.updatedAt.localeCompare(b.updatedAt);
    else if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    if (cmp === 0) cmp = a.number - b.number;
    return direction === 'ASC' ? cmp : -cmp;
  });
  return out;
}

function connectionPage<T>(items: readonly T[], first: number | undefined, after: string | null | undefined, cursorOf: (item: T) => number): { nodes: T[]; pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null } } {
  const afterNum = decodeCursor(after ?? null);
  let start = 0;
  if (afterNum !== null) {
    const idx = items.findIndex((item) => cursorOf(item) === afterNum);
    start = idx >= 0 ? idx + 1 : items.length;
  }
  const count = first === undefined ? items.length : Math.max(0, first);
  const nodes = items.slice(start, start + count);
  const hasNextPage = start + nodes.length < items.length;
  const hasPreviousPage = start > 0;
  const startCursor = nodes.length ? encodeCursor(cursorOf(nodes[0])) : null;
  const endCursor = nodes.length ? encodeCursor(cursorOf(nodes[nodes.length - 1])) : null;
  return { nodes, pageInfo: { hasNextPage, hasPreviousPage, startCursor, endCursor } };
}

function executeSelection(
  typeName: string,
  value: GqlValue | null,
  selection: SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'spread') {
      const frag = ctx.fragments[node.name];
      if (!frag) continue;
      const sub = executeSelection(typeName, value, frag.selection, ctx);
      if (sub) Object.assign(out, sub);
      continue;
    }
    if (node.kind === 'inline') {
      if (node.typeCondition !== null && node.typeCondition !== typeName && node.typeCondition !== value.__type) continue;
      const sub = executeSelection(typeName, value, node.selection, ctx);
      if (sub) Object.assign(out, sub);
      continue;
    }
    const field = node as FieldNode;
    const responseKey = field.alias ?? field.name;
    const result = resolveField(typeName, value, field, ctx);
    out[responseKey] = result;
  }
  return out;
}

function unknownField(typeName: string, fieldName: string, ctx: ExecContext): null {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".` });
  return null;
}

function resolveField(typeName: string, value: GqlValue, field: FieldNode, ctx: ExecContext): unknown {
  const name = field.name;
  // Introspection meta-fields.
  if (name === '__typename') return typeName;
  if (name === '__type') {
    const typeArg = argValue(field, 'name', ctx);
    if (typeof typeArg !== 'string') return null;
    const tv = typeValue(typeArg);
    if (tv === null) return null;
    return executeSelection('__Type', tv, field.selection, ctx);
  }
  if (name === '__schema') {
    return executeSelection('__Schema', { __type: '__Schema', queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] }, field.selection, ctx);
  }

  // Validate the field against the schema; an unknown field is a GraphQL
  // error (HTTP 200), not a transport failure.
  const known = TYPE_FIELDS[typeName] ?? [];
  const isQuery = typeName === 'Query';
  const isMutation = typeName === 'Mutation';
  const queryFields = ['viewer', 'repository', 'node'];
  const mutationFields = ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];
  if (isQuery && !queryFields.includes(name) && name !== '__type' && name !== '__schema') return unknownField(typeName, name, ctx);
  if (isMutation && !mutationFields.includes(name)) return unknownField(typeName, name, ctx);
  if (!isQuery && !isMutation && !known.includes(name)) return unknownField(typeName, name, ctx);

  if (isQuery) return resolveQueryField(value, field, ctx);
  if (isMutation) return resolveMutationField(value, field, ctx);
  return resolveObjectField(typeName, value, field, ctx);
}

function typeValue(typeName: string): GqlValue | null {
  if (TYPE_FIELDS[typeName]) return { __type: '__Type', name: typeName, kind: 'OBJECT' };
  if (ENUM_VALUES[typeName]) return { __type: '__Type', name: typeName, kind: 'ENUM' };
  return null;
}

function resolveQueryField(_value: GqlValue, field: FieldNode, ctx: ExecContext): unknown {
  const name = field.name;
  if (name === 'viewer') {
    const viewer: GqlValue = { __type: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME };
    return executeSelection('User', viewer, field.selection, ctx);
  }
  if (name === 'repository') {
    const owner = argValue(field, 'owner', ctx);
    const repoName = argValue(field, 'name', ctx);
    if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
    const repo = store.getRepo(owner, repoName);
    if (!repo) return null;
    const gql: GqlValue = { __type: 'Repository', repo };
    return executeSelection('Repository', gql, field.selection, ctx);
  }
  if (name === 'node') {
    const id = argValue(field, 'id', ctx);
    if (typeof id !== 'string') return null;
    const decoded = decodeNodeId(id);
    if (!decoded) return null;
    if (decoded.kind === 'Repository') {
      const repo = repoById(decoded.num);
      if (!repo) return null;
      const gql: GqlValue = { __type: 'Repository', repo };
      return executeSelection('Repository', gql, field.selection, ctx);
    }
    if (decoded.kind === 'Issue') {
      const hit = issueById(decoded.num);
      if (!hit) return null;
      const gql: GqlValue = { __type: 'Issue', repo: hit.repo, issue: hit.issue };
      return executeSelection('Issue', gql, field.selection, ctx);
    }
    if (decoded.kind === 'PullRequest') {
      const hit = pullById(decoded.num);
      if (!hit) return null;
      const gql: GqlValue = { __type: 'PullRequest', repo: hit.repo, pull: hit.pull };
      return executeSelection('PullRequest', gql, field.selection, ctx);
    }
    return null;
  }
  return null;
}

function resolveMutationField(_value: GqlValue, field: FieldNode, ctx: ExecContext): unknown {
  const name = field.name;
  const input = argValue(field, 'input', ctx) as Record<string, unknown> | undefined;
  /** The selection set of a named subfield of this mutation field (e.g. `issue` inside `createIssue`). */
  const subSelection = (subName: string): SelectionNode[] => {
    const sub = field.selection.find((s): s is FieldNode => s.kind !== 'spread' && s.kind !== 'inline' && (s as FieldNode).name === subName);
    return sub ? sub.selection : [];
  };
  if (name === 'createIssue') {
    const repositoryId = input?.repositoryId;
    const title = typeof input?.title === 'string' ? input.title : '';
    const body = typeof input?.body === 'string' ? input.body : '';
    const decoded = typeof repositoryId === 'string' ? decodeNodeId(repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? repoById(decoded.num) : undefined;
    if (!repo) return { issue: null };
    const now = nowIso();
    const issue: Issue = {
      id: store.nextId(),
      number: repo.nextIssue++,
      title,
      body,
      state: 'open',
      labels: [],
      comments: [],
      user: viewerUser(),
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.issues.set(issue.number, issue);
    bumpIssueVersion(repo);
    const gql: GqlValue = { __type: 'Issue', repo, issue };
    return { issue: executeSelection('Issue', gql, subSelection('issue'), ctx) };
  }
  if (name === 'closeIssue') {
    const issueId = input?.issueId;
    const decoded = typeof issueId === 'string' ? decodeNodeId(issueId) : null;
    const hit = decoded?.kind === 'Issue' ? issueById(decoded.num) : undefined;
    if (!hit) return { issue: null };
    hit.issue.state = 'closed';
    hit.issue.closedAt = nowIso();
    hit.issue.updatedAt = nowIso();
    bumpIssueVersion(hit.repo);
    const gql: GqlValue = { __type: 'Issue', repo: hit.repo, issue: hit.issue };
    return { issue: executeSelection('Issue', gql, subSelection('issue'), ctx) };
  }
  if (name === 'createPullRequest') {
    const repositoryId = input?.repositoryId;
    const headRefName = typeof input?.headRefName === 'string' ? input.headRefName : '';
    const baseRefName = typeof input?.baseRefName === 'string' ? input.baseRefName : DEFAULT_BRANCH;
    const title = typeof input?.title === 'string' ? input.title : '';
    const decoded = typeof repositoryId === 'string' ? decodeNodeId(repositoryId) : null;
    const repo = decoded?.kind === 'Repository' ? repoById(decoded.num) : undefined;
    if (!repo) return { pullRequest: null };
    const headOid = repo.refs.get(`refs/heads/${headRefName}`);
    const baseOid = repo.refs.get(`refs/heads/${baseRefName}`);
    if (!headOid || !baseOid) return { pullRequest: null };
    const now = nowIso();
    const pull: Pull = {
      id: store.nextId(),
      number: repo.nextPull++,
      title,
      body: typeof input?.body === 'string' ? (input.body as string) : '',
      state: 'open',
      head: headRefName,
      base: baseRefName,
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
    const gql: GqlValue = { __type: 'PullRequest', repo, pull };
    return { pullRequest: executeSelection('PullRequest', gql, subSelection('pullRequest'), ctx) };
  }
  if (name === 'mergePullRequest') {
    const pullRequestId = input?.pullRequestId;
    const decoded = typeof pullRequestId === 'string' ? decodeNodeId(pullRequestId) : null;
    const hit = decoded?.kind === 'PullRequest' ? pullById(decoded.num) : undefined;
    if (!hit) return { pullRequest: null };
    const { repo, pull } = hit;
    const baseOid = repo.refs.get(`refs/heads/${pull.base}`);
    const headOid = repo.refs.get(`refs/heads/${pull.head}`);
    if (!baseOid || !headOid || pull.state !== 'open') return { pullRequest: null };
    const merged = store.threeWayMerge(repo, baseOid, headOid);
    if (merged.conflict) {
      ctx.errors.push({ message: 'Merge conflict: the pull request cannot be merged cleanly.' });
      const gql: GqlValue = { __type: 'PullRequest', repo, pull };
      return { pullRequest: executeSelection('PullRequest', gql, subSelection('pullRequest'), ctx) };
    }
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
    const gql: GqlValue = { __type: 'PullRequest', repo, pull };
    return { pullRequest: executeSelection('PullRequest', gql, subSelection('pullRequest'), ctx) };
  }
  if (name === 'addComment') {
    const subjectId = input?.subjectId;
    const body = typeof input?.body === 'string' ? input.body : '';
    const decoded = typeof subjectId === 'string' ? decodeNodeId(subjectId) : null;
    if (!decoded) return { commentEdge: null };
    const comment = {
      id: store.nextId(),
      body,
      user: viewerUser(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    let target: { repo: Repo; issue: Issue } | { repo: Repo; pull: Pull } | undefined;
    if (decoded.kind === 'Issue') target = issueById(decoded.num);
    else if (decoded.kind === 'PullRequest') target = pullById(decoded.num);
    if (!target) return { commentEdge: null };
    if ('issue' in target) {
      target.issue.comments.push(comment);
      target.issue.updatedAt = nowIso();
      bumpIssueVersion(target.repo);
    }
    const node: GqlValue = { __type: 'IssueComment', comment };
    const edgeSelection = subSelection('commentEdge');
    const edge: Record<string, unknown> = {};
    for (const sub of edgeSelection) {
      if (sub.kind === 'spread' || sub.kind === 'inline') continue;
      const subField = sub as FieldNode;
      if (subField.name === 'node') edge.node = executeSelection('IssueComment', node, subField.selection, ctx);
      else if (subField.name === 'cursor') edge.cursor = encodeCursor(comment.id);
    }
    return { commentEdge: edge };
  }
  return null;
}

function resolveObjectField(typeName: string, value: GqlValue, field: FieldNode, ctx: ExecContext): unknown {
  const name = field.name;
  if (typeName === '__Schema') {
    if (name === 'queryType') return executeSelection('__Type', { __type: '__Type', name: 'Query', kind: 'OBJECT' }, field.selection, ctx);
    if (name === 'mutationType') return executeSelection('__Type', { __type: '__Type', name: 'Mutation', kind: 'OBJECT' }, field.selection, ctx);
    if (name === 'types') return [];
    return null;
  }
  if (typeName === '__Type') {
    if (name === 'name') return value.name;
    if (name === 'kind') return value.kind;
    if (name === 'fields') {
      const type = value.name as string;
      const names = TYPE_FIELDS[type] ?? [];
      return names.map((n) => executeSelection('__Field', { __type: '__Field', name: n }, field.selection, ctx));
    }
    if (name === 'enumValues') {
      const type = value.name as string;
      const names = ENUM_VALUES[type] ?? [];
      return names.map((n) => executeSelection('__EnumValue', { __type: '__EnumValue', name: n }, field.selection, ctx));
    }
    return null;
  }
  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (name === 'name') return value.name;
    return null;
  }
  if (typeName === 'User') {
    if (name === 'login') return value.login;
    if (name === 'id') return encodeNodeId('User', value.id as number);
    if (name === 'name') return value.name ?? null;
    if (name === 'email') return null;
    if (name === 'url') return `https://github.com/${value.login}`;
    return null;
  }
  if (typeName === 'Repository') {
    const repo = value.repo as Repo;
    if (name === 'id') return encodeNodeId('Repository', repo.id);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'description') return repo.description;
    if (name === 'owner') {
      const owner: GqlValue = { __type: 'User', login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, name: repo.owner === VIEWER_LOGIN ? VIEWER_NAME : repo.owner };
      return executeSelection('User', owner, field.selection, ctx);
    }
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      const ref: GqlValue = { __type: 'Ref', name: repo.defaultBranch, target: tip };
      return executeSelection('Ref', ref, field.selection, ctx);
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'createdAt') return repo.createdAt;
    if (name === 'updatedAt') return repo.updatedAt;
    if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
    if (name === 'issue') {
      const number = argValue(field, 'number', ctx);
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      if (!issue) return null;
      const gql: GqlValue = { __type: 'Issue', repo, issue };
      return executeSelection('Issue', gql, field.selection, ctx);
    }
    if (name === 'issues') {
      const first = argValue(field, 'first', ctx) as number | undefined;
      const after = argValue(field, 'after', ctx) as string | undefined;
      const states = argValue(field, 'states', ctx) as string[] | undefined;
      const orderBy = argValue(field, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
      let issues = [...repo.issues.values()];
      if (states) issues = issues.filter((i) => states.includes(i.state.toUpperCase()));
      issues = sortIssues(issues, orderBy);
      const page = connectionPage(issues, first, after ?? null, (i) => i.number);
      const conn: GqlValue = { __type: 'IssueConnection', repo, issues: page.nodes, pageInfo: page.pageInfo };
      return executeSelection('IssueConnection', conn, field.selection, ctx);
    }
    if (name === 'pullRequests') {
      const first = argValue(field, 'first', ctx) as number | undefined;
      const after = argValue(field, 'after', ctx) as string | undefined;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      const page = connectionPage(pulls, first, after ?? null, (p) => p.number);
      const conn: GqlValue = { __type: 'PullRequestConnection', repo, pulls: page.nodes, pageInfo: page.pageInfo };
      return executeSelection('PullRequestConnection', conn, field.selection, ctx);
    }
    if (name === 'pullRequest') {
      const number = argValue(field, 'number', ctx);
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      if (!pull) return null;
      const gql: GqlValue = { __type: 'PullRequest', repo, pull };
      return executeSelection('PullRequest', gql, field.selection, ctx);
    }
    return null;
  }
  if (typeName === 'Issue') {
    const issue = value.issue as Issue;
    if (name === 'id') return encodeNodeId('Issue', issue.id);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'state') return issue.state.toUpperCase();
    if (name === 'body') return issue.body;
    if (name === 'createdAt') return issue.createdAt;
    if (name === 'updatedAt') return issue.updatedAt;
    if (name === 'url') return `https://github.com/${(value.repo as Repo).owner}/${(value.repo as Repo).name}/issues/${issue.number}`;
    if (name === 'author') {
      const author: GqlValue = { __type: 'User', login: issue.user.login, id: issue.user.id, name: issue.user.login };
      return executeSelection('User', author, field.selection, ctx);
    }
    if (name === 'labels') return issue.labels.map((l) => ({ name: l }));
    if (name === 'comments') return issue.comments.map((c) => ({ __type: 'IssueComment', comment: c }));
    return null;
  }
  if (typeName === 'PullRequest') {
    const pull = value.pull as Pull;
    const repo = value.repo as Repo;
    if (name === 'id') return encodeNodeId('PullRequest', pull.id);
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    if (name === 'merged') return pull.merged;
    if (name === 'mergeable') return isMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    if (name === 'headRefName') return pull.head;
    if (name === 'baseRefName') return pull.base;
    if (name === 'headRef') {
      const ref: GqlValue = { __type: 'Ref', name: pull.head, target: pull.headSha };
      return executeSelection('Ref', ref, field.selection, ctx);
    }
    if (name === 'baseRef') {
      const ref: GqlValue = { __type: 'Ref', name: pull.base, target: pull.baseSha };
      return executeSelection('Ref', ref, field.selection, ctx);
    }
    if (name === 'createdAt') return pull.createdAt;
    if (name === 'updatedAt') return pull.updatedAt;
    if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
    if (name === 'author') {
      const author: GqlValue = { __type: 'User', login: pull.user.login, id: pull.user.id, name: pull.user.login };
      return executeSelection('User', author, field.selection, ctx);
    }
    if (name === 'files') {
      const first = argValue(field, 'first', ctx) as number | undefined;
      const after = argValue(field, 'after', ctx) as string | undefined;
      const page = connectionPage(pull.files, first, after ?? null, (f) => pull.files.indexOf(f));
      const conn: GqlValue = { __type: 'PullRequestFileConnection', files: page.nodes, pageInfo: page.pageInfo };
      return executeSelection('PullRequestFileConnection', conn, field.selection, ctx);
    }
    return null;
  }
  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
    if (name === 'nodes') {
      const items = (value.issues as unknown[]) ?? (value.pulls as unknown[]) ?? (value.files as unknown[]) ?? [];
      const itemType = typeName === 'IssueConnection' ? 'Issue' : typeName === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestFile';
      return items.map((item) => {
        if (itemType === 'Issue') {
          const gql: GqlValue = { __type: 'Issue', repo: value.repo as Repo, issue: item as Issue };
          return executeSelection('Issue', gql, field.selection, ctx);
        }
        if (itemType === 'PullRequest') {
          const gql: GqlValue = { __type: 'PullRequest', repo: value.repo as Repo, pull: item as Pull };
          return executeSelection('PullRequest', gql, field.selection, ctx);
        }
        const file = item as { filename: string; status: string; additions: number; deletions: number };
        const gql: GqlValue = { __type: 'PullRequestFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status };
        return executeSelection('PullRequestFile', gql, field.selection, ctx);
      });
    }
    if (name === 'edges') {
      const items = (value.issues as unknown[]) ?? (value.pulls as unknown[]) ?? (value.files as unknown[]) ?? [];
      return items.map((item) => {
        const cursor = typeName === 'IssueConnection' ? encodeCursor((item as Issue).number) : typeName === 'PullRequestConnection' ? encodeCursor((item as Pull).number) : encodeCursor(0);
        return { node: null, cursor };
      });
    }
    if (name === 'totalCount') {
      const items = (value.issues as unknown[]) ?? (value.pulls as unknown[]) ?? (value.files as unknown[]) ?? [];
      return items.length;
    }
    if (name === 'pageInfo') {
      const pageInfo = value.pageInfo as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      return executeSelection('PageInfo', { __type: 'PageInfo', ...pageInfo }, field.selection, ctx);
    }
    return null;
  }
  if (typeName === 'PageInfo') {
    if (name === 'hasNextPage') return value.hasNextPage;
    if (name === 'hasPreviousPage') return value.hasPreviousPage;
    if (name === 'startCursor') return value.startCursor;
    if (name === 'endCursor') return value.endCursor;
    return null;
  }
  if (typeName === 'Ref') {
    if (name === 'name') return value.name;
    if (name === 'target') {
      const target: GqlValue = { __type: 'Commit', oid: value.target as string, message: '' };
      return executeSelection('Commit', target, field.selection, ctx);
    }
    return null;
  }
  if (typeName === 'Commit') {
    if (name === 'oid') return value.oid;
    if (name === 'message') return value.message;
    return null;
  }
  if (typeName === 'IssueComment') {
    const comment = value.comment as { id: number; body: string; user: { login: string; id: number }; createdAt: string; updatedAt: string };
    if (name === 'id') return encodeNodeId('IssueComment', comment.id);
    if (name === 'body') return comment.body;
    if (name === 'createdAt') return comment.createdAt;
    if (name === 'updatedAt') return comment.updatedAt;
    if (name === 'author') {
      const author: GqlValue = { __type: 'User', login: comment.user.login, id: comment.user.id, name: comment.user.login };
      return executeSelection('User', author, field.selection, ctx);
    }
    return null;
  }
  if (typeName === 'PullRequestFile') {
    if (name === 'path') return value.path;
    if (name === 'additions') return value.additions;
    if (name === 'deletions') return value.deletions;
    if (name === 'changeType') return (value.changeType as string)?.toUpperCase() ?? null;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// the endpoint
// ---------------------------------------------------------------------------------------------

function executeOperation(document: Document, operation: Operation, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: ExecContext = { errors: [], variables: { ...variables }, fragments: document.fragments };
  // Fill in variable defaults.
  for (const [name, def] of Object.entries(operation.variables)) {
    if (ctx.variables[name] === undefined && def.defaultValue !== null) {
      ctx.variables[name] = resolveValue(def.defaultValue, {});
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlValue = { __type: rootType };
  const data = executeSelection(rootType, root, operation.selection, ctx);
  return { data, errors: ctx.errors };
}

/**
 * Handle one POST /api/graphql request: a single operation object or a
 * batched array of them, answered in order.
 */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (() => {
    try {
      return new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      return '/';
    }
  })();
  if (path !== '/api/graphql') return false;
  if (!requireAuth(req, res)) return true;
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return true;
  }
  const operations: Array<{ query: string; variables?: Record<string, unknown>; operationName?: string }> = Array.isArray(parsed)
    ? (parsed as Array<Record<string, unknown>>).map((entry) => ({
        query: typeof entry.query === 'string' ? entry.query : '',
        variables: (entry.variables as Record<string, unknown> | undefined) ?? {},
        operationName: typeof entry.operationName === 'string' ? entry.operationName : undefined,
      }))
    : [{
        query: typeof (parsed as Record<string, unknown>).query === 'string' ? ((parsed as Record<string, unknown>).query as string) : '',
        variables: ((parsed as Record<string, unknown>).variables as Record<string, unknown> | undefined) ?? {},
        operationName: typeof (parsed as Record<string, unknown>).operationName === 'string' ? ((parsed as Record<string, unknown>).operationName as string) : undefined,
      }];
  const results: Array<{ data: Record<string, unknown> | null; errors?: Array<{ message: string }> }> = [];
  for (const operation of operations) {
    let document: Document;
    try {
      document = new Parser(tokenize(operation.query)).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
      continue;
    }
    if (document.operations.length === 0) {
      results.push({ data: null, errors: [{ message: 'No operation in the document' }] });
      continue;
    }
    const selected = operation.operationName
      ? document.operations.find((op) => op.name === operation.operationName)
      : document.operations[0];
    if (!selected) {
      results.push({ data: null, errors: [{ message: `Unknown operation ${operation.operationName}` }] });
      continue;
    }
    const result = executeOperation(document, selected, operation.variables ?? {});
    results.push(result.errors.length ? { data: result.data, errors: result.errors } : { data: result.data });
  }
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
  return true;
}
