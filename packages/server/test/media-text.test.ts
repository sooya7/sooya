import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers/harness.js';
import { extractText } from '../src/media/text-extractor.js';
import { resolveVisualTime } from '../src/core/visual-time.js';

let h: Harness | null = null;
afterEach(async () => { if (h) await h.cleanup(); h = null; });

describe('file text extraction', () => {
  it.each([
    ['text/plain', 'notes.txt', '你好，SOOYA'],
    ['text/markdown', 'readme.md', '# 标题\n正文'],
    ['text/csv', 'data.csv', 'name,value\nsooya,1'],
    ['application/json', 'data.json', '{"name":"sooya"}'],
    ['text/x-typescript', 'app.ts', 'const answer = 42;']
  ])('extracts bounded text from %s', (mime, name, source) => {
    const result = extractText(Buffer.from(source), mime, name);
    expect(result.status).toBe('ready');
    expect(result.text).toContain(source.split('\n')[0]!);
    expect(result.metadata?.truncated).toBe(false);
  });

  it('marks binary formats unsupported instead of inventing file contents', () => {
    const result = extractText(Buffer.from([0, 1, 2, 3]), 'application/octet-stream', 'archive.bin');
    expect(result.status).toBe('unsupported');
    expect(result.text).toBeUndefined();
  });

  it('reads a PDF text layer without claiming image-only PDFs are readable', () => {
    const result = extractText(Buffer.from('%PDF-1.7 BT (Hello PDF) Tj ET %%EOF', 'latin1'), 'application/pdf', 'note.pdf');
    expect(result.status).toBe('ready');
    expect(result.text).toContain('Hello PDF');
  });

  it('reads DOCX paragraphs and lists ZIP entries without unpacking them', () => {
    const docx = storedZip([{ name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p></w:body></w:document>' }]);
    const document = extractText(docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'note.docx');
    expect(document.status).toBe('ready');
    expect(document.text).toContain('Hello DOCX');

    const archive = extractText(storedZip([{ name: 'folder/', data: Buffer.alloc(0) }, { name: 'folder/a.txt', data: Buffer.from('secret') }]), 'application/zip', 'archive.zip');
    expect(archive.status).toBe('ready');
    expect(archive.text).toContain('folder/a.txt');
    expect(archive.text).toContain('6 bytes');
  });

  it('persists extraction status through the media job and publishes an update', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await h.app.services.mediaStore.save({ kind: 'file', origin: 'upload', data: Buffer.from('hello'), declaredMime: 'text/plain', filename: 'hello.txt' });
    h.app.repos.mediaText.upsert({ mediaId: row.id, status: 'pending' });
    h.app.repos.jobs.enqueue('media.extract_text', { mediaId: row.id });

    await h.app.services.worker.drain();

    const text = h.app.repos.mediaText.get(row.id);
    expect(text?.status).toBe('ready');
    expect(text?.text).toBe('hello');
    expect(h.app.repos.events.since(0).some((event) => event.type === 'media.updated' && event.payload.mediaId === row.id)).toBe(true);
  });

  it('keeps file claims truthful in context before and after extraction', async () => {
    h = await createHarness({ startWorkers: false });
    const row = await h.app.services.mediaStore.save({ kind: 'file', origin: 'upload', data: Buffer.from('正文'), declaredMime: 'text/plain', filename: 'note.txt' });
    h.app.repos.mediaText.upsert({ mediaId: row.id, status: 'pending' });
    h.app.repos.messages.create({ role: 'user', parts: [{ type: 'file', mediaId: row.id }] });
    const options = { recentMessages: 10, memoryLimit: 0, allowVision: false, stickerCatalogue: '', voiceMoods: '', capabilityNotes: [], contextWindow: 8_000, maxOutputTokens: 1_000, visualTime: resolveVisualTime({ now: '2026-08-26T05:17:23.000Z' }) };

    const pending = await h.app.services.context.build(h.app.config.getPersona(), '', options);
    expect(JSON.stringify(pending.turns)).toContain('正文正在解析');
    await h.app.services.worker.drain();
    const ready = await h.app.services.context.build(h.app.config.getPersona(), '', options);
    expect(JSON.stringify(ready.turns)).toContain('正文');
    expect(JSON.stringify(ready.turns)).not.toContain('当前无法读取正文');
  });
});

function storedZip(entries: Array<{ name: string; data: Buffer | string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    data.copy(local, 30 + name.length);
    locals.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}
