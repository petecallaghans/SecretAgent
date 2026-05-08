import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatForTelegram, chunkRaw, renderForStream } from '../src/telegram.js';

const MAX = 4096;

describe('formatForTelegram', () => {
  it('escapes HTML special chars', () => {
    const out = formatForTelegram('5 < 10 & 20 > 1');
    assert.equal(out, '5 &lt; 10 &amp; 20 &gt; 1');
  });

  it('converts headings to bold', () => {
    assert.equal(formatForTelegram('# Hello'), '<b>Hello</b>');
    assert.equal(formatForTelegram('### Foo Bar'), '<b>Foo Bar</b>');
  });

  it('strips horizontal rules', () => {
    assert.equal(formatForTelegram('a\n---\nb').trim(), 'a\n\nb');
  });

  it('converts bold/italic/strikethrough', () => {
    assert.equal(formatForTelegram('**bold**'), '<b>bold</b>');
    assert.equal(formatForTelegram('*italic*'), '<i>italic</i>');
    assert.equal(formatForTelegram('~~struck~~'), '<s>struck</s>');
  });

  it('preserves code blocks with escaped contents', () => {
    const out = formatForTelegram('```\nif (a < b) { x = "y"; }\n```');
    assert.match(out, /<pre><code>/);
    assert.match(out, /a &lt; b/);
  });

  it('preserves inline code', () => {
    assert.equal(formatForTelegram('use `npm run dev`'), 'use <code>npm run dev</code>');
  });
});

describe('chunkRaw', () => {
  it('returns single chunk when small', () => {
    const chunks = chunkRaw('hello world');
    assert.deepEqual(chunks, ['hello world']);
  });

  it('splits long markdown so each chunk HTML fits MAX', () => {
    const para = 'lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(100);
    const text = (para + '\n\n').repeat(10);
    const chunks = chunkRaw(text);
    assert.ok(chunks.length > 1, 'should split into multiple chunks');
    for (const chunk of chunks) {
      const html = formatForTelegram(chunk);
      assert.ok(html.length <= MAX, `chunk HTML too long: ${html.length}`);
    }
  });

  it('handles dense special chars that expand under HTML escape', () => {
    const text = '<&>'.repeat(2000); // each char becomes 4-5x in HTML
    const chunks = chunkRaw(text);
    for (const chunk of chunks) {
      const html = formatForTelegram(chunk);
      assert.ok(html.length <= MAX, `chunk too long: ${html.length}`);
    }
  });

  it('prefers paragraph boundaries when available', () => {
    const block = 'word '.repeat(400); // ~2000 chars
    const text = block + '\n\nMARKER\n\n' + block + '\n\n' + block;
    const chunks = chunkRaw(text);
    assert.ok(chunks.length > 1, 'should split');
    // First chunk should end at a paragraph boundary, not mid-block
    assert.ok(
      chunks[0].endsWith(block.trimEnd()) || chunks[0].endsWith('MARKER'),
      `first chunk did not end at paragraph boundary: ...${chunks[0].slice(-40)}`,
    );
  });

  it('preserves all non-whitespace content across chunks', () => {
    const text = ('the quick brown fox jumps over the lazy dog\n').repeat(200);
    const chunks = chunkRaw(text);
    const orig = text.replace(/\s+/g, '');
    const joined = chunks.join('').replace(/\s+/g, '');
    assert.equal(joined, orig);
  });
});

describe('renderForStream', () => {
  it('returns HTML for short input', () => {
    const html = renderForStream('hello');
    assert.equal(html, 'hello');
  });

  it('truncates so HTML + cursor fits MAX', () => {
    const text = 'x'.repeat(5000);
    const html = renderForStream(text);
    assert.ok(html.length <= MAX - 4, `stream HTML too long: ${html.length}`);
  });

  it('handles HTML-expanding chars under truncation', () => {
    const text = '<'.repeat(2000);
    const html = renderForStream(text);
    assert.ok(html.length <= MAX - 4);
  });
});
