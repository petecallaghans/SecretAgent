import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatForSlack, chunkForSlack } from '../src/channels/slack.js';

describe('formatForSlack', () => {
  it('converts bold and keeps italic distinct', () => {
    assert.equal(formatForSlack('**bold** and *italic*'), '*bold* and _italic_');
  });

  it('converts headings to bold lines', () => {
    assert.equal(formatForSlack('## Title'), '*Title*');
  });

  it('converts markdown links to slack links', () => {
    assert.equal(formatForSlack('[docs](https://example.com/x)'), '<https://example.com/x|docs>');
  });

  it('converts strikethrough', () => {
    assert.equal(formatForSlack('~~gone~~'), '~gone~');
  });

  it('leaves code blocks untouched', () => {
    const code = '```js\nconst x = "**not bold**";\n```';
    assert.equal(formatForSlack(code), code);
    assert.equal(formatForSlack('`**inline**`'), '`**inline**`');
  });
});

describe('chunkForSlack', () => {
  it('returns short text as one chunk', () => {
    assert.deepEqual(chunkForSlack('hello'), ['hello']);
  });

  it('splits long text at paragraph boundaries under the limit', () => {
    const para = 'x'.repeat(2000);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = chunkForSlack(text);
    assert.ok(chunks.length >= 2);
    for (const c of chunks) assert.ok(c.length <= 3900, `chunk too long: ${c.length}`);
    assert.equal(chunks.join('').replace(/\n/g, ''), text.replace(/\n/g, ''));
  });
});
