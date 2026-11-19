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

export function requestId(): string {
  requestCounter += 1;
  return `req_${Date.now().toString(36)}_${requestCounter}_${randomBytes(4).toString('hex')}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
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
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
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
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? match[1] : null;
}

/** True when the request carries the forge's token (or when no token is configured, dev mode). */
export function isAuthenticated(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  const presented = bearerToken(req);
  return presented !== null && presented === expected;
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
