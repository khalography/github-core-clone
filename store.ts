// store.ts — the forge's whole state, in memory.
//
// One Store holds every repository. A repository holds its git objects
// (keyed by SHA-1), its refs, and its issues / pull requests / labels.
// Nothing is persisted: the trial's export is the suite's own record, and a
// fresh process starts empty, exactly as the harness expects.

import { buildTree, collectReachable, hashObject, parseCommit, parseTree, type GitObject } from './gitcore.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';

export const CONFORMANCE_IDENTITY = 'Conformance <conformance@example.invalid>';

/** A clock that never goes backwards and always yields a fresh ISO timestamp. */
let lastMs = 0;
export function nowIso(): string {
  const ms = Math.max(Date.now(), lastMs + 1);
  lastMs = ms;
  return new Date(ms).toISOString();
}

export interface UserRef {
  login: string;
  id: number;
  type: string;
}

export function viewerUser(): UserRef {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' };
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  default: boolean;
}

export interface IssueComment {
  id: number;
  body: string;
  user: UserRef;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  user: UserRef;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface PullFile {
  sha: string;
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
  previousFilename?: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeable: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  files: PullFile[];
  user: UserRef;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  nextLabelId: number;
  /**
   * Bumped on every mutation that can change a serialized issue's JSON
   * (issue field edits, comment adds, label adds, issue creates). The
   * per-issue response cache in rest.ts is keyed on this version, so a
   * stale entry can never be served. Bump it at every such site.
   */
  issueVersion: number;
  /** Cached serialized single-issue JSON, per issue number. See rest.ts. */
  issueCache: Map<number, { v: number; origin: string; text: string; len: number }>;
  /**
   * Bumped on every git objects/refs mutation (putObject, applyPush, ref
   * creation). The fetch-response cache in githttp.ts is keyed on this
   * generation, so a stale pack can never be served.
   */
  gitGen: number;
  /** Cached git-upload-pack fetch responses, keyed by generation + request. */
  fetchCache: Map<string, Buffer>;
}

/** Bump a repo's issue version: call at every mutation that can change a serialized issue's JSON. */
export function bumpIssueVersion(repo: Repo): void {
  repo.issueVersion += 1;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 10000;
  nextGlobalId = 20000;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === VIEWER_LOGIN);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const now = nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
      nextLabelId: 1,
      issueVersion: 0,
      issueCache: new Map(),
      gitGen: 0,
      fetchCache: new Map(),
    };
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Globally unique id for issues, pulls, comments and labels. */
  nextId(): number {
    return this.nextGlobalId++;
  }

  // -- git objects ---------------------------------------------------------

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data: Buffer.from(data) });
      // A new git object changes what a fetch can return: invalidate the fetch cache.
      repo.gitGen += 1;
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The objects reachable from `roots`, in a stable order (commits first, then trees/blobs). */
  reachableObjects(repo: Repo, roots: Iterable<string>): GitObject[] {
    const ids = collectReachable(roots, (oid) => repo.objects.get(oid));
    const out: GitObject[] = [];
    for (const oid of ids) {
      const object = repo.objects.get(oid);
      if (object) out.push(object);
    }
    return out;
  }

  /** The commit a ref points at, resolving annotated tags. */
  refCommit(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (!oid) return null;
    return this.peelToCommit(repo, oid);
  }

  /** Follow tag objects to the commit they point at (or return the oid unchanged). */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(current)) return null;
      seen.add(current);
      const object = repo.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        // parse the tag's target
        const text = object.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})$/m.exec(text);
        if (!match) return null;
        current = match[1];
        continue;
      }
      return null;
    }
  }

  /** Walk a ref's history newest-first (following first parents only for the list). */
  commitHistory(repo: Repo, tipOid: string): Array<{ oid: string; commit: ReturnType<typeof parseCommit> }> {
    const out: Array<{ oid: string; commit: ReturnType<typeof parseCommit> }> = [];
    const seen = new Set<string>();
    const queue: string[] = [tipOid];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ oid, commit });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  /** The tree entries at a path within a commit's tree ('' = the root). */
  treeAtPath(repo: Repo, treeOid: string, path: string): { entries: ReturnType<typeof parseTree>; oid: string } | null {
    let current = treeOid;
    if (path !== '') {
      for (const part of path.split('/')) {
        const object = repo.objects.get(current);
        if (!object || object.type !== 'tree') return null;
        const entries = parseTree(object.data);
        const hit = entries.find((e) => e.name === part && e.mode === '40000');
        if (!hit) return null;
        current = hit.oid;
      }
    }
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    return { entries: parseTree(object.data), oid: current };
  }

  /** Read a blob's bytes at a path within a commit's tree. */
  blobAtPath(repo: Repo, treeOid: string, path: string): { data: Buffer; oid: string } | null {
    const parts = path.split('/');
    const file = parts.pop()!;
    const dir = parts.join('/');
    const tree = this.treeAtPath(repo, treeOid, dir);
    if (!tree) return null;
    const hit = tree.entries.find((e) => e.name === file && e.mode !== '40000');
    if (!hit) return null;
    const object = repo.objects.get(hit.oid);
    if (!object || object.type !== 'blob') return null;
    return { data: object.data, oid: hit.oid };
  }

  /** Flatten a tree into path -> {oid, mode} for every file, recursively. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /**
   * Build (and store) the tree objects for a flat path -> {oid, mode} file
   * list; returns the root tree's id. Directories are created as needed.
   */
  buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, file] of files) {
      const parts = path.split('/');
      const name = parts.pop()!;
      let node = root;
      for (const part of parts) {
        let next = node.dirs.get(part);
        if (!next) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.set(name, file);
    }
    const build = (node: Node): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return build(root);
  }

  /**
   * Return a new root tree id with one file set (or removed when blobOid is
   * null), creating intermediate directories as needed.
   */
  updateFileInTree(repo: Repo, treeOid: string, path: string, blobOid: string | null, mode = '100644'): string {
    const files = this.flattenTree(repo, treeOid);
    if (blobOid === null) files.delete(path);
    else files.set(path, { oid: blobOid, mode });
    return this.buildTreeFromFiles(repo, files);
  }

  /** The merge-base of two commits: the first common ancestor walking newest-first. */
  mergeBase(repo: Repo, aOid: string, bOid: string): string | null {
    const ancestorsOfB = new Set<string>();
    const queueB: string[] = [bOid];
    while (queueB.length) {
      const oid = queueB.shift()!;
      if (ancestorsOfB.has(oid)) continue;
      ancestorsOfB.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
    const queueA: string[] = [aOid];
    const seenA = new Set<string>();
    while (queueA.length) {
      const oid = queueA.shift()!;
      if (seenA.has(oid)) continue;
      seenA.add(oid);
      if (ancestorsOfB.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
    return null;
  }

  /**
   * A three-way merge of `baseTip` and `headTip` over their merge-base.
   * Returns the merged tree id, or null when the same file changed both ways.
   */
  threeWayMerge(repo: Repo, baseTip: string, headTip: string): { treeOid: string; conflict: boolean } {
    const baseCommit = repo.objects.get(baseTip);
    const headCommit = repo.objects.get(headTip);
    if (!baseCommit || baseCommit.type !== 'commit' || !headCommit || headCommit.type !== 'commit') {
      return { treeOid: '', conflict: true };
    }
    const baseTree = parseCommit(baseCommit.data).tree;
    const headTree = parseCommit(headCommit.data).tree;
    const base = this.mergeBase(repo, baseTip, headTip);
    const ancestorTree = base === null ? '' : parseCommit(repo.objects.get(base)!.data).tree;
    const baseFiles = this.flattenTree(repo, baseTree);
    const headFiles = this.flattenTree(repo, headTree);
    const ancestorFiles = ancestorTree === '' ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, ancestorTree);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...ancestorFiles.keys()]);
    for (const path of paths) {
      const a = ancestorFiles.get(path);
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      const same = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
      if (same(h, a)) {
        // Head did not change it: take the base side (even when deleted there).
        if (b) merged.set(path, b);
      } else if (same(b, a)) {
        // Base did not change it: take the head side (even when deleted there).
        if (h) merged.set(path, h);
      } else if (same(b, h)) {
        // Both changed it the same way.
        if (b) merged.set(path, b);
      } else {
        return { treeOid: '', conflict: true };
      }
    }
    return { treeOid: this.buildTreeFromFiles(repo, merged), conflict: false };
  }
}

/** The one store for the process. */
export const store = new Store();
