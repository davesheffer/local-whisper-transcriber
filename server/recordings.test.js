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

  test('pickExt prefers a known file extension, then mimetype', () => {
    expect(pickExt('audio/webm', 'call.m4a')).toBe('m4a');
    expect(pickExt('audio/ogg;codecs=opus', 'blob')).toBe('ogg');
    expect(pickExt('', 'evil.exe')).toBe('webm');
  });
});
