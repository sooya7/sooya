import { inflateRawSync } from 'node:zlib';

const MAX_EXTRACTED_CHARS = 80_000;

export type TextExtractionResult =
  | { status: 'ready'; text: string; metadata: { chars: number; truncated: boolean } }
  | { status: 'unsupported'; metadata: { reason: string } }
  | { status: 'failed'; error: string; metadata: { reason: string } };

const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/javascript', 'text/typescript',
  'text/css', 'text/html', 'text/xml', 'application/json', 'application/javascript', 'application/typescript',
  'application/xml', 'application/x-yaml', 'application/toml'
]);

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'html', 'htm',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'env', 'sql', 'sh', 'bash', 'py', 'java', 'go', 'rs', 'vue', 'svelte',
  'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'lua'
]);

export function extractText(data: Buffer, mime: string, filename?: string): TextExtractionResult {
  const normalizedMime = mime.split(';', 1)[0]!.trim().toLowerCase();
  const extension = filename?.split('.').pop()?.toLowerCase() ?? '';
  if (normalizedMime === 'application/pdf' || extension === 'pdf') return extractPdfText(data);
  if (normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || extension === 'docx') return extractDocxText(data);
  if (normalizedMime === 'application/zip' || extension === 'zip') return extractZipListing(data);
  if (!TEXT_MIMES.has(normalizedMime) && !TEXT_EXTENSIONS.has(extension)) {
    return { status: 'unsupported', metadata: { reason: 'format_not_supported' } };
  }
  if (data.includes(0)) return { status: 'unsupported', metadata: { reason: 'binary_content' } };
  try {
    const raw = data.toString('utf8').replace(/^\uFEFF/u, '');
    const chars = [...raw];
    const truncated = chars.length > MAX_EXTRACTED_CHARS;
    const text = chars.slice(0, MAX_EXTRACTED_CHARS).join('');
    if (!text.trim()) return { status: 'ready', text: '', metadata: { chars: 0, truncated: false } };
    return { status: 'ready', text, metadata: { chars: text.length, truncated } };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'text_decode_failed', metadata: { reason: 'decode_failed' } };
  }
}

function extractPdfText(data: Buffer): TextExtractionResult {
  if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) return { status: 'failed', error: 'invalid_pdf', metadata: { reason: 'invalid_pdf' } };
  const source = data.toString('latin1');
  const pieces: string[] = [];
  const literal = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*T[Jj]/gu;
  for (const match of source.matchAll(literal)) pieces.push(decodePdfLiteral(match[1]!));
  const text = pieces.join(' ').trim();
  if (!text) return { status: 'unsupported', metadata: { reason: 'no_text_layer' } };
  return readyResult(text);
}

function decodePdfLiteral(value: string): string {
  return value.replace(/\\([\\()])/gu, '$1').replace(/\\n/gu, '\n').replace(/\\r/gu, '\r').replace(/\\t/gu, '\t');
}

function extractDocxText(data: Buffer): TextExtractionResult {
  try {
    const entries = readZipEntries(data);
    const document = entries.find((entry) => entry.name === 'word/document.xml');
    if (!document) return { status: 'failed', error: 'docx_document_missing', metadata: { reason: 'docx_document_missing' } };
    const xml = document.data.toString('utf8');
    const text = decodeXml(xml.replace(/<w:tab\s*\/?>(?:<\/w:tab>)?/gu, '\t').replace(/<w:br\s*\/?>(?:<\/w:br>)?/gu, '\n').replace(/<\/w:p>/gu, '\n').replace(/<[^>]+>/gu, ''));
    if (!text.trim()) return { status: 'unsupported', metadata: { reason: 'docx_empty' } };
    return readyResult(text.trim());
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'docx_read_failed', metadata: { reason: 'docx_read_failed' } };
  }
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'");
}

function extractZipListing(data: Buffer): TextExtractionResult {
  try {
    const entries = readZipEntries(data);
    if (entries.length === 0) return { status: 'unsupported', metadata: { reason: 'zip_empty' } };
    const text = entries.map((entry) => `${entry.name}\t${entry.directory ? '目录' : `${entry.uncompressedSize} bytes`}`).join('\n');
    return { status: 'ready', text, metadata: { chars: text.length, truncated: false } };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'zip_read_failed', metadata: { reason: 'zip_read_failed' } };
  }
}

interface ZipEntry { name: string; directory: boolean; compressedSize: number; uncompressedSize: number; data: Buffer }

function readZipEntries(data: Buffer): ZipEntry[] {
  const eocd = findSignature(data, 0x06054b50, Math.max(0, data.length - 65_557));
  if (eocd < 0) throw new Error('invalid_zip');
  const count = data.readUInt16LE(eocd + 10);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) throw new Error('invalid_zip_directory');
    const method = data.readUInt16LE(cursor + 10);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const uncompressedSize = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    let entryData = Buffer.alloc(0);
    if (!name.endsWith('/')) {
      if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('invalid_zip_entry');
      const localNameLength = data.readUInt16LE(localOffset + 26);
      const localExtraLength = data.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = data.subarray(start, start + compressedSize);
      entryData = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : Buffer.alloc(0);
    }
    out.push({ name, directory: name.endsWith('/'), compressedSize, uncompressedSize, data: entryData });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

function findSignature(data: Buffer, signature: number, start: number): number {
  for (let index = data.length - 22; index >= start; index--) if (data.readUInt32LE(index) === signature) return index;
  return -1;
}

function readyResult(text: string): Extract<TextExtractionResult, { status: 'ready' }> {
  const chars = [...text];
  const truncated = chars.length > MAX_EXTRACTED_CHARS;
  const bounded = chars.slice(0, MAX_EXTRACTED_CHARS).join('');
  return { status: 'ready', text: bounded, metadata: { chars: bounded.length, truncated } };
}
