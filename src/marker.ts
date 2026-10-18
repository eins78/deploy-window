// The marker line at the start of every silence comment (spec section 8.1, DWA-ST-006):
//   <instance>:v1 w=<id> ch=<channel> env=<ENV> t=<target> n=<entries> u=<user> ts=<ts>[ sig=<hex>] | <message>
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface MarkerFields {
  instance: string;
  windowId: string;
  channelId: string;
  env: string;
  target: string;
  entries: number;
  userId: string;
  ts: string;
}

export interface ParsedMarker extends MarkerFields {
  message: string;
}

export type MarkerParse =
  | { kind: 'own'; marker: ParsedMarker }
  | { kind: 'foreign'; channelId: string | undefined }
  | { kind: 'other' };

const SEPARATOR = ' | ';
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const SIGNATURE_OVERHEAD = ' sig='.length + 64;

// Worst-case lengths of the fields that do not come from the configuration.
const MAX_SLACK_ID = 16;
const MAX_TS = 20;
const MAX_ENTRIES_DIGITS = 2;

function header(f: MarkerFields): string {
  return (
    `${f.instance}:v1 w=${f.windowId} ch=${f.channelId} env=${f.env} t=${f.target}` +
    ` n=${String(f.entries)} u=${f.userId} ts=${f.ts}`
  );
}

function sign(text: string, key: Buffer): string {
  return createHmac('sha256', key).update(text).digest('hex');
}

/** Builds the comment. The message must already be comment-safe (DWA-MSG-005). */
export function formatMarker(f: MarkerFields, message: string, key?: Buffer): string {
  let line = header(f);
  if (key) line += ` sig=${sign(line, key)}`;
  return message === '' ? line : `${line}${SEPARATOR}${message}`;
}

/** DWA-CFG-013: the marker length that the message has to share 500 characters with. */
export function markerOverhead(opts: {
  instance: string;
  longestChannelId: number;
  longestEnv: number;
  longestTarget: number;
  signed: boolean;
}): number {
  const line = header({
    instance: opts.instance,
    windowId: 'a'.repeat(8),
    channelId: 'C'.repeat(Math.max(opts.longestChannelId, MAX_SLACK_ID)),
    env: 'E'.repeat(opts.longestEnv),
    target: 't'.repeat(opts.longestTarget),
    entries: 10 ** MAX_ENTRIES_DIGITS - 1,
    userId: 'U'.repeat(MAX_SLACK_ID),
    ts: '1'.repeat(MAX_TS),
  });
  return line.length + (opts.signed ? SIGNATURE_OVERHEAD : 0) + SEPARATOR.length;
}

export const MAX_COMMENT = 500;

const HEADER = new RegExp(
  '^(?<instance>[a-z0-9]{1,16}):v1' +
    ' w=(?<w>[a-z2-7]{8})' +
    ' ch=(?<ch>[A-Z0-9]{1,16})' +
    ' env=(?<env>[A-Za-z][A-Za-z0-9_.-]{0,31})' +
    ' t=(?<t>[a-z0-9][a-z0-9_.-]{0,62})' +
    ' n=(?<n>[1-9][0-9]?)' +
    ' u=(?<u>[A-Z0-9]{1,16})' +
    ' ts=(?<ts>[0-9]{1,12}\\.[0-9]{1,7})' +
    '(?: sig=(?<sig>[0-9a-f]{64}))?$',
);

/**
 * Strict parse (DWA-ST-006). Everything after the first " | " is the message and is never parsed.
 * `other`: not this deployment's prefix. `foreign`: our prefix, but a wrong format or signature.
 */
export function parseMarker(comment: string, instance: string, key?: Buffer): MarkerParse {
  if (!comment.startsWith(`${instance}:v1 `)) return { kind: 'other' };
  const cut = comment.indexOf(SEPARATOR);
  const head = cut === -1 ? comment : comment.slice(0, cut);
  const message = cut === -1 ? '' : comment.slice(cut + SEPARATOR.length);
  const m = HEADER.exec(head);
  const g = m?.groups;
  const channelHint = / ch=([A-Z0-9]{1,16}) /.exec(head)?.[1];
  if (!g || g.instance !== instance) return { kind: 'foreign', channelId: channelHint };
  const fields: MarkerFields = {
    instance,
    windowId: g.w ?? '',
    channelId: g.ch ?? '',
    env: g.env ?? '',
    target: g.t ?? '',
    entries: Number(g.n),
    userId: g.u ?? '',
    ts: g.ts ?? '',
  };
  if (key) {
    const expected = Buffer.from(sign(header(fields), key), 'hex');
    const given = g.sig === undefined ? Buffer.alloc(0) : Buffer.from(g.sig, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { kind: 'foreign', channelId: fields.channelId };
    }
  }
  return { kind: 'own', marker: { ...fields, message } };
}

/** The marker key (marker_key_env): 32 bytes written as 64 hex characters. */
export function parseMarkerKey(hex: string): Buffer {
  const t = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(t)) throw new Error('the marker key must be 32 random bytes as 64 hex characters');
  return Buffer.from(t, 'hex');
}

/** DWA-ST-001: 8 characters from [a-z2-7], from a cryptographically secure source. */
export function newWindowId(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(8);
  let id = '';
  for (const b of bytes) id += ID_ALPHABET.charAt(b & 31);
  return id;
}
