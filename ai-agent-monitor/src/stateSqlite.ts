import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const SQLITE_HEADER_TEXT = 'SQLite format 3\u0000';
const SQLITE_HEADER_SIZE = 100;
const WAL_HEADER_SIZE = 32;
const WAL_FRAME_HEADER_SIZE = 24;

type AppStorageName = 'Cursor' | 'Antigravity';

interface ProtoNode {
  fieldNumber: number;
  wireType: number;
  raw: Buffer;
  text?: string;
  varint?: number;
  children?: ProtoNode[];
  decodedBase64Children?: ProtoNode[];
}

export interface AntigravityModelCatalogEntry {
  id?: number;
  label: string;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function buildAppStoragePathCandidates(
  appName: AppStorageName,
  ...segments: string[]
): string[] {
  const home = os.homedir();
  const appRoots = appName === 'Cursor'
    ? [
        path.join(home, '.config', 'Cursor'),
        path.join(home, 'Library', 'Application Support', 'Cursor'),
      ]
    : [
        path.join(home, '.config', 'Anti-Gravity'),
        path.join(home, '.config', 'Antigravity'),
        path.join(home, 'Library', 'Application Support', 'Anti-Gravity'),
        path.join(home, 'Library', 'Application Support', 'Antigravity'),
      ];

  return appRoots.map((root) => path.join(root, ...segments));
}

export async function firstExistingPath(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export async function readMergedSqliteKeyMap(
  dbPath: string,
  keys: string[]
): Promise<Record<string, string>> {
  if (keys.length === 0) {
    return {};
  }

  for (const candidatePath of [dbPath, `${dbPath}.backup`]) {
    if (!(await pathExists(candidatePath))) {
      continue;
    }

    const rows = await queryMergedSqliteRows<{ key: string; value: string }>(
      candidatePath,
      `SELECT key, value FROM ItemTable WHERE key IN (${keys.map(quoteSqliteString).join(', ')})`
    );

    if (rows.length === 0) {
      continue;
    }

    const map: Record<string, string> = {};
    for (const row of rows) {
      if (typeof row.key === 'string' && typeof row.value === 'string') {
        map[row.key] = row.value;
      }
    }

    if (Object.keys(map).length > 0) {
      return map;
    }
  }

  return {};
}

export async function queryMergedSqliteRows<T extends Record<string, unknown>>(
  dbPath: string,
  sql: string
): Promise<T[]> {
  const tempDbPath = path.join(
    os.tmpdir(),
    `ai-token-analytics-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
  );

  try {
    const merged = await createMergedSqliteBuffer(dbPath);
    await fs.writeFile(tempDbPath, merged);

    // Try 'sqlite3' from PATH first, then fall back to full path.
    // The extension host process may have a limited PATH that does not
    // include /usr/bin, so the bare name can fail with ENOENT.
    const sqlite3Candidates = process.platform === 'win32'
      ? ['sqlite3']
      : ['sqlite3', '/usr/bin/sqlite3'];
    let lastError: unknown;

    for (const bin of sqlite3Candidates) {
      try {
        const { stdout } = await execFileAsync(bin, ['-json', tempDbPath, sql], {
          maxBuffer: 24 * 1024 * 1024,
        });
        return JSON.parse(stdout || '[]') as T[];
      } catch (err) {
        lastError = err;
      }
    }

    // Log the failure so it shows in the output channel instead of
    // being silently swallowed (the previous catch-all hid real errors).
    console.debug('[ai-token-analytics] sqlite3 query failed:', lastError);
    return [];
  } catch (err) {
    console.debug('[ai-token-analytics] createMergedSqliteBuffer failed:', err);
    return [];
  } finally {
    await fs.rm(tempDbPath, { force: true }).catch(() => undefined);
  }
}

export async function createMergedSqliteBuffer(dbPath: string): Promise<Buffer<ArrayBufferLike>> {
  const rawDb = Buffer.from(await fs.readFile(dbPath));
  const walPath = `${dbPath}-wal`;
  let merged: Buffer<ArrayBufferLike> = Buffer.from(rawDb);

  if (await pathExists(walPath)) {
    const rawWal = Buffer.from(await fs.readFile(walPath));
    if (rawWal.length >= WAL_HEADER_SIZE) {
      merged = mergeWalPages(rawDb, rawWal);
    }
  }

  if (merged.length >= SQLITE_HEADER_SIZE && merged.subarray(0, 16).toString('utf8') === SQLITE_HEADER_TEXT) {
    merged[18] = 1;
    merged[19] = 1;
  }

  return merged;
}

export function extractAntigravitySelectedModelName(
  modelPreferencesValue: string | undefined,
  userStatusValue: string | undefined
): string | undefined {
  const selectedModelId = extractAntigravitySelectedModelId(modelPreferencesValue);
  const catalog = extractAntigravityModelCatalog(userStatusValue);

  if (selectedModelId !== undefined) {
    const exactMatch = catalog.find((entry) => entry.id === selectedModelId);
    if (exactMatch) {
      return exactMatch.label;
    }
  }

  return catalog[0]?.label;
}

export function extractAntigravityModelCatalog(
  userStatusValue: string | undefined
): AntigravityModelCatalogEntry[] {
  const root = parseBase64Protobuf(userStatusValue);
  if (root.length === 0) {
    return [];
  }

  const catalog = new Map<string, AntigravityModelCatalogEntry>();

  const visit = (nodes: readonly ProtoNode[]) => {
    for (const node of nodes) {
      const nested = getNestedProtoNodes(node);
      const label = nested.find((candidate) =>
        candidate.fieldNumber === 1
          && typeof candidate.text === 'string'
          && looksLikeModelLabel(candidate.text)
      )?.text;

      if (label) {
        const idNode = nested.find((candidate) => candidate.fieldNumber === 2);
        const id = idNode
          ? findFirstVarint(getNestedProtoNodes(idNode))
          : findFirstVarint(nested);

        catalog.set(label, {
          id,
          label,
        });
      }

      if (node.children?.length) {
        visit(node.children);
      }
      if (node.decodedBase64Children?.length) {
        visit(node.decodedBase64Children);
      }
    }
  };

  visit(root);
  return [...catalog.values()];
}

function extractAntigravitySelectedModelId(
  modelPreferencesValue: string | undefined
): number | undefined {
  const nodes = parseBase64Protobuf(modelPreferencesValue);
  const fromSentinel = findSelectedModelId(nodes);
  if (fromSentinel !== undefined) {
    return fromSentinel;
  }

  if (!modelPreferencesValue) {
    return undefined;
  }

  try {
    const decodedText = Buffer.from(modelPreferencesValue, 'base64').toString('utf8');
    const base64Candidates = decodedText.match(/[A-Za-z0-9+/=]{4,}/g) ?? [];
    for (const candidate of base64Candidates) {
      try {
        const nested = parseProtoMessage(Buffer.from(candidate, 'base64'));
        const nestedId = findFirstVarint(nested.nodes);
        if (nestedId !== undefined) {
          return nestedId;
        }
      } catch {
        // Ignore malformed nested base64 fragments.
      }
    }
  } catch {
    // Ignore malformed model preference payloads.
  }

  return findFirstVarint(nodes);
}

function mergeWalPages(
  rawDb: Buffer<ArrayBufferLike>,
  rawWal: Buffer<ArrayBufferLike>
): Buffer<ArrayBufferLike> {
  if (rawDb.length < SQLITE_HEADER_SIZE) {
    return Buffer.from(rawDb);
  }

  const pageSize = readSqlitePageSize(rawDb);
  const walPageSize = rawWal.readUInt32BE(8) || pageSize;
  const effectivePageSize = walPageSize === 0 ? pageSize : walPageSize;
  const frameSize = WAL_FRAME_HEADER_SIZE + effectivePageSize;
  const availableFrames = Math.floor(Math.max(0, rawWal.length - WAL_HEADER_SIZE) / frameSize);

  if (availableFrames <= 0) {
    return Buffer.from(rawDb);
  }

  const walSalt1 = rawWal.readUInt32BE(16);
  const walSalt2 = rawWal.readUInt32BE(20);
  const frames: Array<{ pageNumber: number; dbSize: number; pageOffset: number }> = [];
  let lastCommittedFrameIndex = -1;
  let lastCommittedDbSize = Math.max(1, Math.ceil(rawDb.length / effectivePageSize));
  let maxPageNumber = Math.max(1, Math.ceil(rawDb.length / effectivePageSize));

  for (let index = 0; index < availableFrames; index += 1) {
    const frameOffset = WAL_HEADER_SIZE + (index * frameSize);
    const pageNumber = rawWal.readUInt32BE(frameOffset);
    const dbSize = rawWal.readUInt32BE(frameOffset + 4);
    const frameSalt1 = rawWal.readUInt32BE(frameOffset + 8);
    const frameSalt2 = rawWal.readUInt32BE(frameOffset + 12);

    if (pageNumber <= 0 || frameSalt1 !== walSalt1 || frameSalt2 !== walSalt2) {
      continue;
    }

    frames.push({
      pageNumber,
      dbSize,
      pageOffset: frameOffset + WAL_FRAME_HEADER_SIZE,
    });

    maxPageNumber = Math.max(maxPageNumber, pageNumber);
    if (dbSize > 0) {
      lastCommittedFrameIndex = frames.length - 1;
      lastCommittedDbSize = dbSize;
    }
  }

  if (frames.length === 0) {
    return Buffer.from(rawDb);
  }

  const committedFrameCount = lastCommittedFrameIndex >= 0
    ? lastCommittedFrameIndex + 1
    : frames.length;
  const targetPageCount = Math.max(lastCommittedDbSize, maxPageNumber, Math.ceil(rawDb.length / effectivePageSize));
  const merged = Buffer.alloc(targetPageCount * effectivePageSize);
  rawDb.copy(merged, 0, 0, Math.min(rawDb.length, merged.length));

  for (let index = 0; index < committedFrameCount; index += 1) {
    const frame = frames[index];
    const destinationOffset = (frame.pageNumber - 1) * effectivePageSize;
    rawWal.copy(
      merged,
      destinationOffset,
      frame.pageOffset,
      frame.pageOffset + effectivePageSize
    );
  }

  const finalSize = Math.max(
    rawDb.length,
    (lastCommittedFrameIndex >= 0 ? lastCommittedDbSize : maxPageNumber) * effectivePageSize
  );
  return Buffer.from(merged.subarray(0, finalSize));
}

function readSqlitePageSize(buffer: Buffer): number {
  const pageSize = buffer.readUInt16BE(16);
  return pageSize === 1 ? 65536 : pageSize;
}

function quoteSqliteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseBase64Protobuf(value: string | undefined): ProtoNode[] {
  if (!value) {
    return [];
  }

  try {
    const decoded = Buffer.from(value, 'base64');
    return parseProtoMessage(decoded).nodes;
  } catch {
    return [];
  }
}

function parseProtoMessage(buffer: Buffer): { nodes: ProtoNode[]; complete: boolean } {
  const nodes: ProtoNode[] = [];
  let offset = 0;

  try {
    while (offset < buffer.length) {
      const tag = readVarint(buffer, offset);
      offset = tag.nextOffset;
      const fieldNumber = Number(tag.value >> 3n);
      const wireType = Number(tag.value & 0x07n);

      if (fieldNumber <= 0) {
        return { nodes, complete: false };
      }

      if (wireType === 0) {
        const value = readVarint(buffer, offset);
        offset = value.nextOffset;
        nodes.push({
          fieldNumber,
          wireType,
          raw: buffer.subarray(tag.offset, value.nextOffset),
          varint: toSafeInteger(value.value),
        });
        continue;
      }

      if (wireType === 1) {
        if (offset + 8 > buffer.length) {
          return { nodes, complete: false };
        }

        nodes.push({
          fieldNumber,
          wireType,
          raw: buffer.subarray(tag.offset, offset + 8),
        });
        offset += 8;
        continue;
      }

      if (wireType === 2) {
        const length = readVarint(buffer, offset);
        offset = length.nextOffset;
        const byteLength = Number(length.value);
        const endOffset = offset + byteLength;
        if (byteLength < 0 || endOffset > buffer.length) {
          return { nodes, complete: false };
        }

        const slice = buffer.subarray(offset, endOffset);
        offset = endOffset;
        const nested = parseProtoMessage(slice);
        const text = extractPrintableText(slice);
        const decodedBase64Children = text && looksLikeBase64(text)
          ? parseDecodedBase64Children(text)
          : undefined;

        nodes.push({
          fieldNumber,
          wireType,
          raw: buffer.subarray(tag.offset, endOffset),
          text,
          children: nested.complete && nested.nodes.length > 0 ? nested.nodes : undefined,
          decodedBase64Children: decodedBase64Children && decodedBase64Children.length > 0
            ? decodedBase64Children
            : undefined,
        });
        continue;
      }

      if (wireType === 5) {
        if (offset + 4 > buffer.length) {
          return { nodes, complete: false };
        }

        nodes.push({
          fieldNumber,
          wireType,
          raw: buffer.subarray(tag.offset, offset + 4),
        });
        offset += 4;
        continue;
      }

      return { nodes, complete: false };
    }

    return { nodes, complete: true };
  } catch {
    return { nodes, complete: false };
  }
}

function parseDecodedBase64Children(text: string): ProtoNode[] | undefined {
  try {
    const decoded = Buffer.from(text, 'base64');
    const nested = parseProtoMessage(decoded);
    return nested.complete && nested.nodes.length > 0
      ? nested.nodes
      : undefined;
  } catch {
    return undefined;
  }
}

function getNestedProtoNodes(node: ProtoNode): ProtoNode[] {
  return [
    ...(node.children ?? []),
    ...(node.decodedBase64Children ?? []),
  ];
}

function findFirstVarint(nodes: readonly ProtoNode[]): number | undefined {
  for (const node of nodes) {
    if (typeof node.varint === 'number') {
      return node.varint;
    }

    const nested = getNestedProtoNodes(node);
    if (nested.length > 0) {
      const nestedVarint = findFirstVarint(nested);
      if (nestedVarint !== undefined) {
        return nestedVarint;
      }
    }
  }

  return undefined;
}

function findSelectedModelId(nodes: readonly ProtoNode[]): number | undefined {
  for (const node of nodes) {
    const nested = getNestedProtoNodes(node);
    const keyNode = nested.find((candidate) =>
      candidate.fieldNumber === 1
        && typeof candidate.text === 'string'
        && candidate.text.includes('last_selected_agent_model_sentinel_key')
    );

    if (keyNode) {
      const valueNode = nested.find((candidate) => candidate.fieldNumber === 2);
      const selectedId = valueNode
        ? findFirstVarint(getNestedProtoNodes(valueNode))
        : findFirstVarint(nested);
      if (selectedId !== undefined) {
        return selectedId;
      }
    }

    if (node.children?.length) {
      const childSelectedId = findSelectedModelId(node.children);
      if (childSelectedId !== undefined) {
        return childSelectedId;
      }
    }

    if (node.decodedBase64Children?.length) {
      const decodedSelectedId = findSelectedModelId(node.decodedBase64Children);
      if (decodedSelectedId !== undefined) {
        return decodedSelectedId;
      }
    }
  }

  return undefined;
}

function looksLikeModelLabel(value: string): boolean {
  return /^(Gemini|Claude|GPT|Cursor|Kimi|Grok|Llama|DeepSeek|Mistral|Qwen)/i.test(value)
    && value.length <= 96;
}

function extractPrintableText(buffer: Buffer): string | undefined {
  try {
    const text = buffer.toString('utf8');
    const nonPrintable = text.replace(/[\x20-\x7e\n\r\t]/g, '');
    if (nonPrintable.length > Math.max(2, text.length * 0.1)) {
      return undefined;
    }

    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
  } catch {
    return undefined;
  }
}

function looksLikeBase64(value: string): boolean {
  return value.length >= 8
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/=]+$/.test(value);
}

function readVarint(buffer: Buffer, offset: number): {
  offset: number;
  nextOffset: number;
  value: bigint;
} {
  let result = 0n;
  let shift = 0n;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = BigInt(buffer[cursor]);
    result |= (byte & 0x7fn) << shift;
    cursor += 1;

    if ((byte & 0x80n) === 0n) {
      return {
        offset,
        nextOffset: cursor,
        value: result,
      };
    }

    shift += 7n;
  }

  throw new Error('Unexpected end of varint');
}

function toSafeInteger(value: bigint): number {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
}
