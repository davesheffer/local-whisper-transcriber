const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore, pickExt } = require('./recordings');

let dir;
let store;

function tmpAudio(bytes = 1024) {
  const p = path.join(os.tmpdir(), `rec-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recordings-test-'));
  store = createStore(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recordings store', () => {
  test('save moves the upload in and writes metadata', async () => {
    const tmp = tmpAudio(2048);
    const created = new Date(2026, 10, 15, 9, 5, 7).getTime();
    const meta = await store.save({ tmpPath: tmp, originalName: 'blob', mimetype: 'audio/webm;codecs=opus', name: ' Standup ', duration: '61000', created });

    expect(meta.id).toBe('2026-11-15_09-05-07');
    expect(meta.name).toBe('Standup');
    expect(meta.file).toBe('2026-11-15_09-05-07.webm');
    expect(meta.size).toBe(2048);
    expect(meta.duration).toBe(61000);
    expect(meta.transcript).toBeNull();
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(path.join(dir, meta.file))).toBe(true);
    expect(await store.list()).toEqual([meta]);
  });

  test('ids stay unique when two recordings start in the same second', async () => {
    const created = Date.now();
    const a = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm', created });
    const b = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm', created });
    expect(b.id).toBe(`${a.id}-2`);
  });

  test('list is newest first and skips corrupt metadata', async () => {
    const older = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm', created: 1000000 });
    const newer = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm', created: 2000000 });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    expect((await store.list()).map((m) => m.id)).toEqual([newer.id, older.id]);
  });

  test('rename validates and persists', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await expect(store.rename(m.id, '   ')).rejects.toMatchObject({ status: 400 });
    expect((await store.rename(m.id, 'Client call')).name).toBe('Client call');
    expect((await store.get(m.id)).name).toBe('Client call');
  });

  test('transcript text goes to .txt, status merges into metadata', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await store.setTranscript(m.id, { status: 'running', model: 'base' });
    const done = await store.setTranscript(m.id, { status: 'done', text: 'שלום עולם' });
    expect(done.transcript).toMatchObject({ status: 'done', model: 'base', chars: 9, preview: 'שלום עולם' });
    expect(done.transcript.text).toBeUndefined();
    expect(await store.readTranscript(m.id)).toBe('שלום עולם');
  });

  test('concurrent updates to one recording are not lost', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await Promise.all([
      store.setTranscript(m.id, { status: 'running', model: 'small' }),
      store.rename(m.id, 'Renamed'),
      store.setTranscript(m.id, { language: 'he' }),
    ]);
    const meta = await store.get(m.id);
    expect(meta.name).toBe('Renamed');
    expect(meta.transcript).toMatchObject({ status: 'running', model: 'small', language: 'he' });
  });

  test('remove moves every file into _deleted', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await store.setTranscript(m.id, { status: 'done', text: 'hi' });
    await store.remove(m.id);
    expect(await store.list()).toEqual([]);
    const trash = fs.readdirSync(path.join(dir, '_deleted')).sort();
    expect(trash).toEqual([`${m.id}.json`, `${m.id}.txt`, m.file].sort());
  });

  test('rejects ids that could escape the folder', async () => {
    for (const bad of ['../x', '..\\x', 'a/b', '', 'x'.repeat(81)]) {
      await expect(store.get(bad)).rejects.toMatchObject({ status: 400 });
    }
    await expect(store.get('missing')).rejects.toMatchObject({ status: 404 });
  });

  test('markInterrupted flags jobs that were running at shutdown', async () => {
    const a = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm', created: 1000000 });
    const b = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm', created: 2000000 });
    await store.setTranscript(a.id, { status: 'running' });
    await store.setTranscript(b.id, { status: 'done', text: 'x' });
    expect(await store.markInterrupted()).toBe(1);
    expect((await store.get(a.id)).transcript.status).toBe('interrupted');
    expect((await store.get(b.id)).transcript.status).toBe('done');
  });

  test('concurrent saves in the same second never share an id or lose audio', async () => {
    const created = new Date(2026, 10, 15, 10, 0, 0).getTime();
    const metas = await Promise.all([1, 2, 3, 4].map((n) => store.save({ tmpPath: tmpAudio(100 * n), mimetype: 'audio/webm', created })));
    expect(new Set(metas.map((m) => m.id)).size).toBe(4);
    expect(metas.map((m) => fs.statSync(path.join(dir, m.file)).size).sort()).toEqual([100, 200, 300, 400]);
  });

  test('a deleted id is not reused, so trash is never overwritten', async () => {
    const created = new Date(2026, 10, 15, 11, 0, 0).getTime();
    const a = await store.save({ tmpPath: tmpAudio(111), mimetype: 'audio/webm', created });
    await store.remove(a.id);
    const b = await store.save({ tmpPath: tmpAudio(222), mimetype: 'audio/webm', created });
    expect(b.id).not.toBe(a.id);
    await store.remove(b.id);
    expect(fs.statSync(path.join(dir, '_deleted', a.file)).size).toBe(111);
    expect(fs.statSync(path.join(dir, '_deleted', b.file)).size).toBe(222);
  });

  test('list and markInterrupted ignore non-recording json files', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await store.setTranscript(m.id, { status: 'running' });
    fs.writeFileSync(path.join(dir, 'null.json'), 'null');
    fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ id: '../evil', file: 'x' }));
    expect((await store.list()).map((x) => x.id)).toEqual([m.id]);
    expect(await store.markInterrupted()).toBe(1);
  });

  test('out-of-range created timestamps fall back to now', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm', created: 1e20 });
    expect(m.id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    expect(Math.abs(m.created - Date.now())).toBeLessThan(60000);
  });

  test('metadata pointing outside the store is rejected by get and skipped by list', async () => {
    const outside = tmpAudio();
    const planted = { id: '2026-01-01_00-00-00', name: 'x', file: outside, transcript: null };
    fs.writeFileSync(path.join(dir, `${planted.id}.json`), JSON.stringify(planted));
    await expect(store.get(planted.id)).rejects.toMatchObject({ status: 500 });
    await expect(store.remove(planted.id)).rejects.toMatchObject({ status: 500 });
    expect(await store.list()).toEqual([]);
    expect(fs.existsSync(outside)).toBe(true);
    fs.unlinkSync(outside);

    const mismatched = { id: '2026-01-02_00-00-00', name: 'y', file: '2026-01-02_00-00-00.webm', transcript: null };
    fs.writeFileSync(path.join(dir, '2026-01-03_00-00-00.json'), JSON.stringify(mismatched));
    await expect(store.get('2026-01-03_00-00-00')).rejects.toMatchObject({ status: 500 });
  });

  test('completeTranscript writes sorted segments and flags them in metadata', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    const segs = [{ start: 4.2, end: 6, text: 'second' }, { start: 0, end: 4.2, text: 'first' }];
    const meta = await store.completeTranscript(m.id, { status: 'done', text: 'first second' }, segs);
    expect(meta.transcript).toMatchObject({ status: 'done', chars: 12, preview: 'first second', segments: true, edited: false });
    expect(meta.transcript.text).toBeUndefined();
    expect(await store.readTranscript(m.id)).toBe('first second');
    expect(await store.readSegments(m.id)).toEqual([{ start: 0, end: 4.2, text: 'first' }, { start: 4.2, end: 6, text: 'second' }]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  test('readSegments and readSummary 404 when missing, 400 on bad ids', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await expect(store.readSegments(m.id)).rejects.toMatchObject({ status: 404 });
    await expect(store.readSummary(m.id)).rejects.toMatchObject({ status: 404 });
    expect(() => store.readSegments('../x')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => store.readSummary('a/b')).toThrow(expect.objectContaining({ status: 400 }));
  });

  test('re-transcription backs up the old text to .prev.txt and drops stale segments', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await store.completeTranscript(m.id, { status: 'done', text: 'v1' }, [{ start: 0, end: 1, text: 'v1' }]);
    expect(fs.existsSync(path.join(dir, `${m.id}.prev.txt`))).toBe(false);
    await store.completeTranscript(m.id, { status: 'done', text: 'v2' }, [{ start: 0, end: 1, text: 'v2' }]);
    expect(fs.readFileSync(path.join(dir, `${m.id}.prev.txt`), 'utf8')).toBe('v1');
    const meta = await store.completeTranscript(m.id, { status: 'done', text: 'v3' }, []);
    expect(fs.readFileSync(path.join(dir, `${m.id}.prev.txt`), 'utf8')).toBe('v2');
    expect(await store.readTranscript(m.id)).toBe('v3');
    expect(meta.transcript.segments).toBe(false);
    await expect(store.readSegments(m.id)).rejects.toMatchObject({ status: 404 });
  });

  test('editTranscript writes text and segments and marks the transcript edited', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await store.completeTranscript(m.id, { status: 'done', text: 'helo world' }, [{ start: 0, end: 2, text: 'helo world' }]);
    const meta = await store.editTranscript(m.id, { text: 'hello world', segments: [{ start: 0, end: 2, text: 'hello world', extra: 1 }] });
    expect(meta.transcript).toMatchObject({ status: 'done', chars: 11, preview: 'hello world', segments: true, edited: true });
    expect(await store.readTranscript(m.id)).toBe('hello world');
    expect(await store.readSegments(m.id)).toEqual([{ start: 0, end: 2, text: 'hello world' }]);

    expect(fs.existsSync(path.join(dir, `${m.id}.prev.txt`))).toBe(false); // edits are not re-transcriptions
  });

  test('a text-only edit or empty segments retire the old segments to _deleted', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await store.completeTranscript(m.id, { status: 'done', text: 'a b' }, [{ start: 0, end: 1, text: 'a b' }]);
    const textOnly = await store.editTranscript(m.id, { text: 'just text' });
    expect(textOnly.transcript).toMatchObject({ edited: true, segments: false });
    expect(await store.readTranscript(m.id)).toBe('just text');
    await expect(store.readSegments(m.id)).rejects.toMatchObject({ status: 404 });
    expect(fs.readdirSync(path.join(dir, '_deleted'))).toEqual([`${m.id}.segments.json`]);

    await store.editTranscript(m.id, { text: 'again', segments: [{ start: 0, end: 1, text: 'again' }] });
    const emptied = await store.editTranscript(m.id, { text: 'again', segments: [] });
    expect(emptied.transcript).toMatchObject({ edited: true, segments: false });
    await expect(store.readSegments(m.id)).rejects.toMatchObject({ status: 404 });
    expect(fs.readdirSync(path.join(dir, '_deleted'))).toHaveLength(2);
  });

  test('editTranscript refuses (409) unless the transcript is done', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await expect(store.editTranscript(m.id, { text: 'x' })).rejects.toMatchObject({ status: 409 });
    for (const status of ['running', 'error', 'cancelled', 'interrupted']) {
      await store.setTranscript(m.id, { status });
      await expect(store.editTranscript(m.id, { text: 'x' })).rejects.toMatchObject({ status: 409 });
    }
    expect(fs.existsSync(path.join(dir, `${m.id}.txt`))).toBe(false);
  });

  test('completeTranscript still saves the text when segments or the backup cannot be written', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await store.completeTranscript(m.id, { status: 'done', text: 'v1' }, [{ start: 0, end: 1, text: 'v1' }]);
    // A directory where the tmp files go makes both writes fail.
    fs.mkdirSync(path.join(dir, `${m.id}.segments.json.tmp`));
    fs.mkdirSync(path.join(dir, `${m.id}.prev.txt.tmp`));
    const meta = await store.completeTranscript(m.id, { status: 'done', text: 'v2' }, [{ start: 0, end: 1, text: 'v2' }]);
    expect(meta.transcript).toMatchObject({ status: 'done', segments: false, edited: false, chars: 2 });
    expect(await store.readTranscript(m.id)).toBe('v2');
    await expect(store.readSegments(m.id)).rejects.toMatchObject({ status: 404 }); // stale v1 segments dropped
    expect(fs.existsSync(path.join(dir, `${m.id}.prev.txt`))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  test('re-transcribing moves user-edited segments to _deleted instead of unlinking them', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await store.completeTranscript(m.id, { status: 'done', text: 'v1' }, [{ start: 0, end: 1, text: 'v1' }]);
    await store.editTranscript(m.id, { text: 'mine', segments: [{ start: 0, end: 1, text: 'mine' }] });
    const meta = await store.completeTranscript(m.id, { status: 'done', text: 'v2' }, []);
    expect(meta.transcript).toMatchObject({ segments: false, edited: false });
    const trashed = path.join(dir, '_deleted', `${m.id}.segments.json`);
    expect(JSON.parse(fs.readFileSync(trashed, 'utf8'))).toEqual([{ start: 0, end: 1, text: 'mine' }]);
    expect(fs.readFileSync(path.join(dir, `${m.id}.prev.txt`), 'utf8')).toBe('mine');
  });

  test('editTranscript rejects bad input with 400 and leaves files alone', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await store.completeTranscript(m.id, { status: 'done', text: 'orig' }, [{ start: 0, end: 1, text: 'orig' }]);
    const bad = [
      undefined, null, [], {}, { text: 5 }, { text: 'x'.repeat(5 * 1024 * 1024 + 1) },
      { text: 'ok', segments: 'nope' }, { text: 'ok', segments: null },
      { text: 'ok', segments: [{ start: -1, end: 1, text: 'a' }] },
      { text: 'ok', segments: [{ start: 0, end: Infinity, text: 'a' }] },
      { text: 'ok', segments: [{ start: '0', end: 1, text: 'a' }] },
      { text: 'ok', segments: [{ start: 0, end: 1, text: 7 }] },
      { text: 'ok', segments: [null] },
      { text: 'ok', segments: new Array(50001).fill({ start: 0, end: 1, text: '' }) },
    ];
    for (const body of bad) await expect(store.editTranscript(m.id, body)).rejects.toMatchObject({ status: 400 });
    await expect(store.editTranscript('missing', { text: 'x' })).rejects.toMatchObject({ status: 404 });
    expect(await store.readTranscript(m.id)).toBe('orig');
    expect(await store.readSegments(m.id)).toEqual([{ start: 0, end: 1, text: 'orig' }]);
    expect((await store.get(m.id)).transcript.edited).toBe(false);
  });

  test('putSummary stores json + markdown and a truncated meta.summary', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    const summary = { version: 1, lang: 'he', title: 't'.repeat(250), tldr: 'd'.repeat(600), keyPoints: ['a'], qa: [] };
    const meta = await store.putSummary(m.id, { summary, markdown: '# Notes' });
    expect(meta.summary.title).toBe('t'.repeat(200));
    expect(meta.summary.tldr).toBe('d'.repeat(500));
    expect(typeof meta.summary.updatedAt).toBe('number');
    expect(await store.readSummary(m.id)).toEqual(summary);
    expect(fs.readFileSync(path.join(dir, `${m.id}.summary.md`), 'utf8')).toBe('# Notes');

    const odd = await store.putSummary(m.id, { summary: { title: 42, tldr: ['x'] }, markdown: '' });
    expect(odd.summary).toMatchObject({ title: '', tldr: '' });
  });

  test('putSummary rejects bad input with 400', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    const bad = [
      undefined, null, {}, { summary: null, markdown: '' }, { summary: [], markdown: '' }, { summary: 'x', markdown: '' },
      { summary: new Date(), markdown: '' }, { summary: {}, markdown: 5 }, { summary: {} },
      { summary: {}, markdown: 'x'.repeat(5 * 1024 * 1024 + 1) },
    ];
    for (const body of bad) await expect(store.putSummary(m.id, body)).rejects.toMatchObject({ status: 400 });
    await expect(store.putSummary('missing', { summary: {}, markdown: '' })).rejects.toMatchObject({ status: 404 });
    expect(fs.existsSync(path.join(dir, `${m.id}.summary.json`))).toBe(false);
    expect((await store.get(m.id)).summary).toBeNull();
  });

  test('deleteSummary moves summary files to _deleted and clears meta.summary', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await store.putSummary(m.id, { summary: { title: 'A' }, markdown: '# A' });
    const meta = await store.deleteSummary(m.id);
    expect(meta.summary).toBeNull();
    await expect(store.readSummary(m.id)).rejects.toMatchObject({ status: 404 });
    expect(fs.readdirSync(path.join(dir, '_deleted')).sort()).toEqual([`${m.id}.summary.json`, `${m.id}.summary.md`]);
    await store.putSummary(m.id, { summary: { title: 'B' }, markdown: '# B' });
    await store.deleteSummary(m.id);
    expect(fs.readdirSync(path.join(dir, '_deleted'))).toHaveLength(4); // earlier trash is never overwritten
    await expect(store.deleteSummary('missing')).rejects.toMatchObject({ status: 404 });
  });

  test('list items carry summary and transcript flags without reading extra files', async () => {
    const a = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm', created: 1000000 });
    const b = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm', created: 2000000 });
    await store.completeTranscript(a.id, { status: 'done', text: 'x' }, [{ start: 0, end: 1, text: 'x' }]);
    await store.editTranscript(a.id, { text: 'y', segments: [{ start: 0, end: 1, text: 'y' }] });
    await store.putSummary(a.id, { summary: { title: 'Plan', tldr: 'Short' }, markdown: '' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await store.list();
    expect(warn).not.toHaveBeenCalled(); // .segments.json / .summary.json are not mistaken for metadata
    warn.mockRestore();
    expect(items.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(items[0]).toMatchObject({ summary: null, transcript: null });
    expect(items[1].summary).toMatchObject({ title: 'Plan', tldr: 'Short' });
    expect(items[1].transcript).toMatchObject({ segments: true, edited: true, status: 'done' });

    await store.setTranscript(b.id, { status: 'running' });
    expect((await store.list())[0].transcript).toMatchObject({ status: 'running', segments: false, edited: false });
  });

  test('remove moves every per-recording file into _deleted', async () => {
    const m = await store.save({ tmpPath: tmpAudio(), mimetype: 'audio/webm' });
    await store.completeTranscript(m.id, { status: 'done', text: 'v1' }, [{ start: 0, end: 1, text: 'v1' }]);
    await store.completeTranscript(m.id, { status: 'done', text: 'v2' }, [{ start: 0, end: 1, text: 'v2' }]);
    await store.putSummary(m.id, { summary: { title: 'T' }, markdown: '# T' });
    await store.remove(m.id);
    const suffixes = ['.json', '.txt', '.segments.json', '.summary.json', '.summary.md', '.prev.txt'];
    expect(fs.readdirSync(path.join(dir, '_deleted')).sort()).toEqual([m.file, ...suffixes.map((s) => `${m.id}${s}`)].sort());
    expect(fs.readdirSync(dir)).toEqual(['_deleted']);
    expect(await store.list()).toEqual([]);
  });

  test('pickExt prefers a known file extension, then mimetype', () => {
    expect(pickExt('audio/webm', 'call.m4a')).toBe('m4a');
    expect(pickExt('audio/ogg;codecs=opus', 'blob')).toBe('ogg');
    expect(pickExt('', 'evil.exe')).toBe('webm');
  });
});
