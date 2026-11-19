// gitcore.ts — the git object model and wire formats for the forge.
//
// Everything here is stdlib-only and deterministic: object ids are SHA-1 over
// "<type> <size>\0" + bytes, packs are plain (no deltas), and pkt-lines are the
// 4-hex-length framing git's smart HTTP speaks. The suite's own git-client.ts
// is the reference for every format used here.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

/** git's object id: SHA-1 over "<type> <size>\0" + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

/** Parse a tree object's entries (mode, name, 20-byte oid each). */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from its entries (sorted git's way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

/**
 * Every object reachable from `roots`: commit -> tree + parents, tag -> its
 * target, tree -> entries (gitlinks skipped), blob -> nothing. Throws on a
 * missing object unless `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Encode one pkt-line: 4 hex length digits (including the 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode several lines (strings, Buffers, or 'flush' / 'delim' markers) into one buffer. */
export function encodePktLines(lines: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else if (line === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const lenHex = buffer.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    if (len === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (offset + len > buffer.length) throw new Error('truncated pkt-line');
      out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

/**
 * Wrap a payload in side-band-64k packets (band 1 = data). Each outer pkt-line
 * carries one band byte plus a chunk of the payload, so the framing stays
 * inside git's 65520-byte pkt-line limit.
 */
export function sidebandWrap(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxChunk = 65500;
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([band])));
    return Buffer.concat(parts);
  }
  for (let offset = 0; offset < data.length; offset += maxChunk) {
    const chunk = data.subarray(offset, Math.min(offset + maxChunk, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// packfile (plain objects only, no deltas — the suite's client writes plain packs too)
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const data = Buffer.isBuffer(object.data) ? object.data : Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    // Level 1: the pack is a wire transfer, not storage; the objects are
    // small and the client verifies the checksum, so speed beats ratio.
    parts.push(deflateSync(data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export interface PackReadEntry {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

/**
 * Read a packfile of plain objects (plus OFS/REF deltas, resolved against the
 * pack itself or a `resolveBase` lookup). Returns the objects keyed by id.
 */
export function readPack(
  pack: Uint8Array,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): Map<string, GitObject> {
  const buffer = Buffer.from(pack);
  if (buffer.length < 12 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(8);
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    delta: { kind: 'ofs' | 'ref'; baseOffset?: number; baseOid?: string } | null;
  }
  const raw: Raw[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = buffer[offset++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let delta: Raw['delta'] = null;
    if (typeCode === 6) {
      byte = buffer[offset++];
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buffer[offset++];
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      delta = { kind: 'ofs', baseOffset: entryOffset - baseOffset };
    } else if (typeCode === 7) {
      delta = { kind: 'ref', baseOid: buffer.subarray(offset, offset + 20).toString('hex') };
      offset += 20;
    }
    const start = offset;
    // One inflate: {info:true} reports the input bytes the stream consumed,
    // so the next object starts exactly there. (The old code binary-searched
    // the end with repeated inflates, throwing an error with a stack trace
    // on every too-short guess.)
    const inflated = inflateSync(buffer.subarray(start), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const consumed = inflated.engine.bytesWritten;
    if (!consumed || consumed <= 0) throw new Error('zlib stream consumed no bytes');
    offset = start + consumed;
    raw.push({ offset: entryOffset, typeCode, size, data: inflated.buffer, delta });
  }
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, Raw>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const resolve = (entry: Raw): GitObject => {
    if (entry.delta === null) {
      const type = CODE_TYPE[entry.typeCode];
      if (!type) throw new Error(`unknown pack object type ${entry.typeCode}`);
      return { type, data: entry.data };
    }
    let base: GitObject | undefined;
    if (entry.delta.kind === 'ofs') {
      const baseEntry = byOffset.get(entry.delta.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      base = resolve(baseEntry);
    } else {
      base = options.resolveBase?.(entry.delta.baseOid!) ?? objects.get(entry.delta.baseOid!);
      if (!base) throw new Error(`ref-delta base ${entry.delta.baseOid} not available`);
    }
    const data = applyDelta(base.data, entry.data);
    return { type: base.type, data };
  };
  for (const entry of raw) {
    const object = resolve(entry);
    const oid = hashObject(object.type, object.data);
    if (!objects.has(oid)) objects.set(oid, object);
  }
  return objects;
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.from(base);
  const deltaBuffer = Buffer.from(delta);
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== baseBuffer.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  const out: Buffer[] = [];
  let outLen = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) copyOffset |= deltaBuffer[offset++] << (i * 8);
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) copySize |= deltaBuffer[offset++] << (i * 8);
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(baseBuffer.subarray(copyOffset, copyOffset + copySize));
      outLen += copySize;
    } else if (op !== 0) {
      out.push(deltaBuffer.subarray(offset, offset + op));
      outLen += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (outLen !== targetSize) throw new Error(`delta produced ${outLen} bytes, expected ${targetSize}`);
  return Buffer.concat(out);
}
