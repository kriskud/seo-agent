import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, atomToThreadText, fetchThread, threadRequestUrl, pickPending, buildPrompt, PROJECT_META } from './draft.mjs';

const threadAtom = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><author><name>/u/hero</name></author><content type="html">&lt;div&gt;BTN, 10bb, A5s — &lt;b&gt;shove&lt;/b&gt;?&lt;/div&gt;</content><link href="https://www.reddit.com/r/poker/comments/abc/"/><title>Push fold at 10bb?</title></entry>
<entry><author><name>/u/reg</name></author><content type="html">Snap shove.</content><link href="https://www.reddit.com/r/poker/comments/abc/c1/"/><title>/u/reg on Push fold at 10bb?</title></entry></feed>`;

test('reddit thread Atom flattens into post + comments', () => {
  const text = atomToThreadText(threadAtom);
  assert.match(text, /ПОСТ \(\/u\/hero\): Push fold at 10bb\?/);
  assert.match(text, /BTN, 10bb, A5s — shove/);
  assert.match(text, /КОММЕНТАРИЙ \(\/u\/reg\)\nSnap shove\./);
  assert.doesNotMatch(text, /undefined/);
  assert.throws(() => atomToThreadText('<html/>'), /Invalid Atom/);
  assert.throws(() => atomToThreadText('<feed></feed>'), /Empty Atom/);
});

test('html strips markup, decodes entities and caps length', () => {
  const text = htmlToText('<html><script>evil()</script><p>Push &amp; fold: <b>10bb</b>&nbsp;&lt;stack&gt;</p></html>');
  assert.equal(text, 'Push & fold: 10bb <stack>');
  assert.equal(htmlToText('<p>' + 'x'.repeat(9000) + '</p>').length, 8000);
});

test('reddit goes to www thread Atom, forums stay as-is', () => {
  assert.deepEqual(threadRequestUrl('https://reddit.com/r/poker/comments/abc'),
    { target: 'https://www.reddit.com/r/poker/comments/abc/.rss', isReddit: true });
  assert.deepEqual(threadRequestUrl('https://forum.gipsyteam.ru/index.php?viewtopic=1'),
    { target: 'https://forum.gipsyteam.ru/index.php?viewtopic=1', isReddit: false });
});

test('reddit fetches vps2-first, forums local-first, each falls back', () => {
  const localCalls = [];
  const local = url => { localCalls.push(url); return '<p>forum text</p>'; };
  const remote = url => { assert.match(url, /www\.reddit\.com.*\.rss/); return threadAtom; };
  assert.match(fetchThread('https://reddit.com/r/poker/comments/abc', local, remote), /Push fold at 10bb/);
  assert.deepEqual(localCalls, []); // для reddit локальный транспорт не трогаем
  assert.equal(fetchThread('https://forum.gipsyteam.ru/index.php?viewtopic=1', local, () => { throw new Error('no'); }), 'forum text');
  const dead = () => { throw new Error('vps2 curl exited 22'); };
  assert.match(fetchThread('https://reddit.com/r/poker/comments/abc', () => threadAtom, dead), /Push fold at 10bb/);
  assert.throws(() => fetchThread('https://reddit.com/r/poker/comments/abc', dead, dead), /vps2 curl/);
});

test('pending = relevant without existing draft, bounded by limit', () => {
  const rows = [
    { id: 'a'.repeat(64), status: 'relevant' },
    { id: 'b'.repeat(64), status: 'relevant' },
    { id: 'c'.repeat(64), status: 'maybe' },
    { id: 'd'.repeat(64), status: 'relevant' },
  ];
  const drafted = new Set(['b'.repeat(12)]);
  assert.deepEqual(pickPending(rows, id => drafted.has(id)).map(r => r.id[0]), ['a', 'd']);
  assert.deepEqual(pickPending(rows, id => drafted.has(id), 1).map(r => r.id[0]), ['a']);
});

test('prompt carries assets, constraints, platform tone and thread text', () => {
  for (const [project, meta] of Object.entries(PROJECT_META)) {
    const row = { platform: 'reddit', url: 'https://reddit.com/r/poker/comments/abc/', title: 't' };
    const prompt = buildPrompt(row, 'THREAD BODY', meta);
    assert.ok(prompt.includes(meta.about));
    for (const [url] of meta.assets) assert.ok(prompt.includes(url), `${project}: ${url}`);
    assert.match(prompt, /Максимум ОДНА ссылка/);
    assert.match(prompt, /бонус-коды CoinPoker/);
    assert.match(prompt, /SKIP/);
    assert.match(prompt, /THREAD BODY/);
    assert.match(prompt, /Определи язык треда/);
  }
  const ruRow = { platform: 'gipsyteam', url: 'https://forum.gipsyteam.ru/x', title: 't' };
  assert.match(buildPrompt(ruRow, 'x', PROJECT_META.drill), /Тред русскоязычный/);
});
