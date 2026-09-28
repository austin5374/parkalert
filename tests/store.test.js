import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-store-'));
const { loadFile, saveAtomic } = await import('../server/store.js');
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'parkalert-store-'));

test('a missing file is a fresh start', () => {
  assert.deepEqual(loadFile(path.join(dir(), 'trips.json'), {}), {});
});

test('an unreadable file is moved aside, never overwritten, and the backup is used', () => {
  const d = dir();
  const file = path.join(d, 'trips.json');
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ ABCDEF: { code: 'ABCDEF' } }));
  fs.writeFileSync(file, '{"ABCDEF": {"code": "ABC'); // cut off mid-write
  assert.deepEqual(loadFile(file, {}), { ABCDEF: { code: 'ABCDEF' } });
  const aside = fs.readdirSync(d).find((f) => f.startsWith('trips.json.corrupt-'));
  assert.ok(aside, 'the corrupt file is kept');
  assert.equal(fs.readFileSync(path.join(d, aside), 'utf8'), '{"ABCDEF": {"code": "ABC');
});

test('with no backup, an unreadable file still survives beside the fresh start', () => {
  const d = dir();
  const file = path.join(d, 'trips.json');
  fs.writeFileSync(file, 'not json');
  assert.deepEqual(loadFile(file, {}), {});
  assert.equal(fs.readdirSync(d).filter((f) => f.startsWith('trips.json.corrupt-')).length, 1);
});

test('saving keeps a daily backup of the file it replaces', () => {
  const d = dir();
  const file = path.join(d, 'trips.json');
  saveAtomic(file, { a: 1 }, 1, { keepBackup: true });
  assert.equal(fs.existsSync(`${file}.bak`), false); // nothing to back up yet
  saveAtomic(file, { a: 2 }, 1, { keepBackup: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { a: 1 });
  saveAtomic(file, { a: 3 }, 1, { keepBackup: true }); // same day: backup unchanged
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 3 });
});
