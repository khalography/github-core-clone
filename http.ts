// http.ts — the small HTTP plumbing every surface of the forge shares.
//
// Every JSON reply carries a non-empty X-GitHub-Request-Id, is
// application/json, and never HTML. Errors are {"message": string}.
// Authentication is one bearer token (MAKEFUN_SHOP_TOKEN); a missing or wrong
// token is 401. Bodies are read whole (they are small) and malformed JSON is
// a 400, as the protocol checks require.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
// One random prefix per process; the per-response id is a counter after it.
// (The old code drew fresh crypto randomness for every response.)
const requestPrefix = randomBytes(4).toString('hex');

// The bearer token, read once at module load: requireAuth runs on every
// REST/GraphQL/MCP request, and a process.env lookup per request is
// needless work. (The token is set before the process starts and never
// changes while it runs.)
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function requestId(): string {
  requestCounter += 1;
  return `req_${requestPrefix}_${requestCounter}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  // Encode once: Buffer.byteLength(text) scans the string and res.end(text)
  // would encode it again. A single Buffer.from gives the length for free
  // and res.end sends the bytes directly.
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': buf.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(buf);
}

/**
 * Serialize a JSON body exactly as sendJson does, returning the wire bytes
 * (pre-encoded once) and their length, so a caller can cache and re-send them
 * without paying the UTF-8 encode on every repeat.
 */
export function jsonText(body: unknown): { buf: Buffer; len: number } {
  const buf = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  return { buf, len: buf.length };
}

/** Send pre-serialized JSON bytes with exactly the headers sendJson sets. */
export function sendCachedJson(
  res: ServerResponse,
  status: number,
  cached: { buf: Buffer; len: number },
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': cached.len,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(cached.buf);
}

export function sendRaw(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The path of a request URL, or '/' when it does not parse. */
const urlCache = new WeakMap<IncomingMessage, { path: string; query: URLSearchParams }>();

function parsedUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const cached = urlCache.get(req);
  if (cached) return cached;
  const raw = req.url ?? '/';
  // Fast path: split on the first '?'. A request URL has no fragment, and
  // the suite's paths need no normalization, so this matches URL.pathname
  // for everything the forge serves while avoiding a URL parse per call.
  const q = raw.indexOf('?');
  const path = q < 0 ? (raw === '' ? '/' : raw) : raw.slice(0, q) || '/';
  const query = q < 0 ? new URLSearchParams() : new URLSearchParams(raw.slice(q + 1));
  const parsed = { path, query };
  urlCache.set(req, parsed);
  return parsed;
}

export function pathOf(req: IncomingMessage): string {
  return parsedUrl(req).path;
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  return parsedUrl(req).query;
}

/** The request's origin (http://host) for building absolute pagination URLs. */
export function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'entry';
  return `http://${host}`;
}

/** Read the whole request body as a Buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns null (and answers 400) when the body is not JSON. */
export async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendError(res, 400, 'Problems parsing JSON');
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return null;
  }
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() || null : null;
}

/** True when the request carries the forge's token (or when no token is configured, dev mode). */
export function isAuthenticated(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  const presented = bearerToken(req);
  return presented !== null && presented === EXPECTED_TOKEN;
}

/** Answer 401 unless the request is authenticated; returns true when it may proceed. */
export function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAuthenticated(req)) return true;
  sendError(res, 401, 'Bad credentials');
  return false;
}

/** Decode a %-encoded path segment (a branch or file path); null when it does not decode. */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Build a GitHub-style Link header for a paginated list. `page` is 1-based,
 * `perPage` the page size, `total` the item count. URLs are absolute so the
 * suite's client can follow them without leaving the entry's origin.
 */
export function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string {
  const origin = originOf(req);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${origin}${path}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(lastPage)}>; rel="last"`);
  return parts.join(', ');
}

/** Slice a list into one page; returns the page and the total count. */
export function paginate<T>(items: readonly T[], page: number, perPage: number): { pageItems: T[]; total: number } {
  const total = items.length;
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), total };
}

/** Parse the page/per_page query pair the way GitHub does (defaults 1 / 30, clamped). */
export function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10) || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}
