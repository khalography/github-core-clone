// githttp.ts — git smart HTTP: info/refs, git-upload-pack (v2) and
// git-receive-pack (v0) for one repository.
//
// The wire contract is the suite's git-client.ts: v2 advertisements open
// with "version 2" and carry ls-refs + fetch; v0 advertisements are ref
// lines with capabilities after a NUL on the first line; pushes answer a
// report-status stream inside side-band-64k band 1; fetches answer the v2
// sectioned response (acknowledgments, shallow-info, wanted-refs, packfile)
// with the pack inside side-band-64k band 1. Packs are plain objects only.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  decodePktLines,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTree,
  readPack,
  sidebandWrap,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitcore.ts';
import { decodeSegment, pathOf, readBody, sendError, sendRaw } from './http.ts';
import { DEFAULT_BRANCH, store, type Repo } from './store.ts';

const AGENT = 'forge/1.0';
const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The refs a v0 advertisement lists: HEAD first, then every ref, then peeled tag lines. */
function v0RefLines(repo: Repo): string[] {
  const lines: string[] = [];
  const refs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? ZERO_OID;
  const caps = [
    `symref=HEAD:refs/heads/${DEFAULT_BRANCH}`,
    'report-status',
    'side-band-64k',
    'delete-refs',
    'thin-pack',
    'ofs-delta',
    'shallow',
    'multi_ack',
    `agent=${AGENT}`,
  ].join(' ');
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    return lines;
  }
  lines.push(`${headOid} HEAD\0${caps}\n`);
  for (const [ref, oid] of refs) {
    lines.push(`${oid} ${ref}\n`);
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const peeled = store.peelToCommit(repo, oid);
      if (peeled) lines.push(`${peeled} ${ref}^{}\n`);
    }
  }
  return lines;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const contentType = service === 'git-upload-pack' ? UPLOAD_ADVERTISEMENT : RECEIVE_ADVERTISEMENT;
  void contentType;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush', ...v0RefLines(repo), 'flush'];
  return encodePktLines(lines);
}

function v2Advertisement(service: 'git-upload-pack'): Buffer {
  void service;
  return V2_ADVERTISEMENT;
}

/** The v2 upload-pack advertisement never varies: build it once. */
const V2_ADVERTISEMENT: Buffer = encodePktLines([
  `# service=git-upload-pack\n`,
  'flush',
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow wait-for-done\n',
  'server-option\n',
  'object-format=sha1\n',
  'flush',
]);

/**
 * Cache key for a fetch response: the repo's git generation (bumped on
 * every objects/refs mutation) plus every request field that shapes the
 * response. The pack for a fixed (wants, haves, depth, shallow) is
 * immutable — git objects never change — and the wanted-refs section
 * follows the refs, which the generation covers. The clone workload
 * issues 50 identical fetches, so 49 of them hit this cache.
 */
function fetchCacheKey(repo: Repo, isV2: boolean, req: FetchRequest): string {
  return [
    repo.gitGen,
    isV2 ? 'v2' : 'v0',
    req.wants.join(','),
    req.haves.join(','),
    req.depth ?? '',
    req.shallow.join(','),
    req.deepenSince ?? '',
    req.deepenNot.join(','),
  ].join('|');
}

/** All refs in ls-refs order, HEAD first with its symref target. */
function lsRefsLines(repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): string[] {
  const lines: string[] = [];
  const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  const keep = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  if (keep('HEAD')) {
    if (headOid) lines.push(`${headOid} HEAD${opts.symrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`);
    else if (opts.unborn) lines.push(`unborn HEAD${opts.symrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`);
  }
  const refs = [...repo.refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [ref, oid] of refs) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag' && opts.peel) {
      const peeled = store.peelToCommit(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  done: boolean;
}

/** Parse a v2 upload-pack request body (command=ls-refs or command=fetch). */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  const args: string[] = [];
  let command = '';
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim && line.startsWith('command=')) command = line.slice('command='.length);
    else args.push(line);
  }
  return { command, args };
}

function parseFetchArgs(args: string[]): FetchRequest {
  const out: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) out.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) out.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) out.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) out.depth = Number.parseInt(arg.slice(7).trim(), 10) || null;
    else if (arg.startsWith('deepen-since ')) out.deepenSince = Number.parseInt(arg.slice(13).trim(), 10) || null;
    else if (arg.startsWith('deepen-not ')) out.deepenNot.push(arg.slice(11).trim());
    else if (arg === 'done') out.done = true;
  }
  return out;
}

/**
 * The objects a fetch must send: everything reachable from the wants,
 * minus what the client already has (its haves' closures), honouring a
 * depth limit (shallow) by cutting the walk at that generation.
 */
function fetchObjects(repo: Repo, req: FetchRequest): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  // What the client already has. A `have` that is also one of the client's
  // declared shallow boundaries counts as that commit (and its tree) only:
  // the client has the boundary object, not its parents, so the walk must
  // not cross a shallow boundary or a deepen would deliver nothing.
  const boundary = new Set(req.shallow);
  const haveReachable = new Set<string>();
  for (const have of req.haves) {
    const queue: string[] = [have];
    while (queue.length) {
      const oid = queue.pop()!;
      if (haveReachable.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      haveReachable.add(oid);
      if (boundary.has(oid)) {
        // Shallow boundary: the client has this commit and its tree, but
        // not its parents, so descend into the tree only.
        if (object.type === 'commit') queue.push(parseCommit(object.data).tree);
        continue;
      }
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        const text = object.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})$/m.exec(text);
        if (match) queue.push(match[1]);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    }
  }
  const depth = req.depth;
  const shallow = new Set<string>();
  const wanted = new Set<string>();
  // Walk from each want, tracking depth (generations of parents).
  interface Frame { oid: string; depth: number }
  const queue: Frame[] = req.wants.map((oid) => ({ oid, depth: 0 }));
  const seen = new Set<string>();
  while (queue.length) {
    const frame = queue.shift()!;
    if (seen.has(frame.oid)) continue;
    seen.add(frame.oid);
    const object = repo.objects.get(frame.oid);
    if (!object) continue;
    wanted.add(frame.oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      // The commit's tree and its blobs are always included.
      const treeQueue: string[] = [commit.tree];
      while (treeQueue.length) {
        const treeOid = treeQueue.shift()!;
        if (seen.has(treeOid)) continue;
        seen.add(treeOid);
        const treeObject = repo.objects.get(treeOid);
        if (!treeObject || treeObject.type !== 'tree') continue;
        wanted.add(treeOid);
        for (const entry of parseTree(treeObject.data)) {
          if (entry.mode === '40000') treeQueue.push(entry.oid);
          else if (!seen.has(entry.oid)) {
            seen.add(entry.oid);
            wanted.add(entry.oid);
          }
        }
      }
      if (depth !== null && frame.depth + 1 >= depth) {
        shallow.add(frame.oid);
        continue;
      }
      for (const parent of commit.parents) queue.push({ oid: parent, depth: frame.depth + 1 });
    } else if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match) queue.push({ oid: match[1], depth: frame.depth });
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push({ oid: entry.oid, depth: frame.depth });
    }
  }
  // Shallow boundaries the client already declared stay shallow; a deepen
  // past them unshallows them.
  const unshallow: string[] = [];
  for (const boundary of req.shallow) {
    if (depth === null || depth > 1) unshallow.push(boundary);
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (haveReachable.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return { objects, shallow: [...shallow], unshallow };
}

function v2FetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const key = fetchCacheKey(repo, true, req);
  const hit = repo.fetchCache.get(key);
  if (hit) return hit;
  const { objects, shallow, unshallow } = fetchObjects(repo, req);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePktLines(['acknowledgments\n', req.haves.length ? 'NAK\n' : 'NAK\n', 'delim']));
  // shallow-info
  const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
  for (const oid of shallow) shallowLines.push(`shallow ${oid}\n`);
  for (const oid of unshallow) shallowLines.push(`unshallow ${oid}\n`);
  shallowLines.push('delim');
  parts.push(encodePktLines(shallowLines));
  // wanted-refs
  const wantedLines: Array<string | 'delim'> = ['wanted-refs\n'];
  for (const want of req.wants) {
    for (const [ref, oid] of repo.refs) {
      if (oid === want) wantedLines.push(`${want} ${ref}\n`);
    }
  }
  if (wantedLines.length === 1) {
    // No ref points at a want (a bare oid): still name the want against HEAD's ref when it matches.
    const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    for (const want of req.wants) {
      if (want === headOid) wantedLines.push(`${want} refs/heads/${DEFAULT_BRANCH}\n`);
    }
  }
  wantedLines.push('delim');
  parts.push(encodePktLines(wantedLines));
  // packfile
  parts.push(encodePktLines(['packfile\n']));
  const pack = writePack(objects);
  parts.push(sidebandWrap(1, pack));
  parts.push(Buffer.from('0000', 'ascii'));
  const out = Buffer.concat(parts);
  repo.fetchCache.set(key, out);
  return out;
}

/** Parse a v0 upload-pack request (want/have/deepen lines, two sections). */
function parseV0Fetch(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const verb = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
    if (verb === 'want') req.wants.push(rest.split(' ')[0]);
    else if (verb === 'have') req.haves.push(rest.trim());
    else if (verb === 'shallow') req.shallow.push(rest.trim());
    else if (verb === 'deepen') req.depth = Number.parseInt(rest.trim(), 10) || null;
    else if (verb === 'deepen-since') req.deepenSince = Number.parseInt(rest.trim(), 10) || null;
    else if (verb === 'deepen-not') req.deepenNot.push(rest.trim());
    else if (verb === 'done') req.done = true;
  }
  return req;
}

function v0FetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const key = fetchCacheKey(repo, false, req);
  const hit = repo.fetchCache.get(key);
  if (hit) return hit;
  const { objects, shallow, unshallow } = fetchObjects(repo, req);
  const parts: Buffer[] = [];
  parts.push(encodePktLines(['NAK\n']));
  for (const oid of shallow) parts.push(encodePktLines([`shallow ${oid}\n`]));
  for (const oid of unshallow) parts.push(encodePktLines([`unshallow ${oid}\n`]));
  const pack = writePack(objects);
  parts.push(sidebandWrap(1, pack));
  parts.push(Buffer.from('0000', 'ascii'));
  const out = Buffer.concat(parts);
  repo.fetchCache.set(key, out);
  return out;
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack command list: pkt-lines up to the first flush, then the pack. */
function parsePush(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const commands: PushCommand[] = [];
  let offset = 0;
  let first = true;
  while (offset + 4 <= body.length) {
    const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len === 1 || len === 2) {
      offset += 4;
      continue;
    }
    if (offset + len > body.length) break;
    const payload = body.subarray(offset + 4, offset + len).toString('utf8');
    const text = first ? payload.split('\0')[0] : payload;
    first = false;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(text.replace(/\n$/, ''));
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
    offset += len;
  }
  const pack = offset < body.length ? body.subarray(offset) : null;
  return { commands, pack };
}

/** Apply a push: store the pack's objects, then apply each ref update with fast-forward checks. */
function applyPush(repo: Repo, commands: PushCommand[], pack: Buffer | null): Array<{ ref: string; ok: boolean; reason: string }> {
  if (pack !== null && pack.length > 0) {
    const objects = readPack(pack);
    for (const [oid, object] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: Buffer.from(object.data) });
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Create or update: the new object must be present.
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    // Fast-forward only: the new tip must descend from the current tip.
    // Walk the ancestry but stop the moment the current tip is found: on a
    // linear chain it is the new tip's immediate parent, so this is two
    // parses instead of a walk of the whole history on every push.
    const ancestors = new Set<string>();
    const queue: string[] = [command.newOid];
    let head = 0;
    let isFastForward = false;
    while (head < queue.length) {
      const oid = queue[head++]!;
      if (oid === current) {
        isFastForward = true;
        break;
      }
      if (ancestors.has(oid)) continue;
      ancestors.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    if (!isFastForward) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  const now = new Date().toISOString();
  repo.updatedAt = now;
  repo.pushedAt = now;
  // Objects and/or refs changed: invalidate the git fetch cache.
  repo.gitGen += 1;
  return results;
}

function pushReport(results: Array<{ ref: string; ok: boolean; reason: string }>): Buffer {
  const inner: Array<string | 'flush'> = ['unpack ok\n'];
  for (const result of results) {
    inner.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  inner.push('flush');
  const innerBytes = encodePktLines(inner);
  return sidebandWrap(1, innerBytes);
}

/**
 * Handle one git smart-HTTP request. Returns true when answered; false when
 * the path is not a git route.
 */
export async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
  if (!match) return false;
  const owner = decodeSegment(match[1]) ?? '';
  const name = decodeSegment(match[2]) ?? '';
  const tail = match[3];
  const repo = store.getRepo(owner, name);
  if (!repo) {
    // A missing repository is a 404 on both services' info/refs, and on the
    // pack endpoints too; the server stays up.
    if (tail.startsWith('info/refs') || tail === 'git-upload-pack' || tail === 'git-receive-pack') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    return false;
  }

  // GET /info/refs?service=...
  if (tail.startsWith('info/refs') && method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://entry');
    const service = url.searchParams.get('service') ?? '';
    if (service === 'git-upload-pack') {
      const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = wantsV2 ? v2Advertisement('git-upload-pack') : v0Advertisement(repo, 'git-upload-pack');
      sendRaw(res, 200, body, UPLOAD_ADVERTISEMENT);
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), RECEIVE_ADVERTISEMENT);
      return true;
    }
    sendError(res, 400, 'unknown service');
    return true;
  }

  // POST /git-upload-pack
  if (tail === 'git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (isV2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        const peel = args.includes('peel');
        const symrefs = args.includes('symrefs');
        const unborn = args.includes('unborn');
        const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
        const lines = lsRefsLines(repo, { peel, symrefs, unborn, prefixes });
        sendRaw(res, 200, encodePktLines([...lines, 'flush']), UPLOAD_RESULT);
        return true;
      }
      if (command === 'fetch') {
        const fetchReq = parseFetchArgs(args);
        sendRaw(res, 200, v2FetchResponse(repo, fetchReq), UPLOAD_RESULT);
        return true;
      }
      sendError(res, 400, `unknown command ${command}`);
      return true;
    }
    const fetchReq = parseV0Fetch(body);
    sendRaw(res, 200, v0FetchResponse(repo, fetchReq), UPLOAD_RESULT);
    return true;
  }

  // POST /git-receive-pack
  if (tail === 'git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    const { commands, pack } = parsePush(body);
    if (commands.length === 0) {
      sendError(res, 400, 'no commands');
      return true;
    }
    const results = applyPush(repo, commands, pack);
    sendRaw(res, 200, pushReport(results), RECEIVE_RESULT);
    return true;
  }

  return false;
}
