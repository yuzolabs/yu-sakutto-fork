import { describe, expect, it } from 'vitest';
import {
  chunkForTranslation,
  hasSentenceTerminator,
  joinTranslatedSentences,
  sentenceSeparator,
  splitForTranslation,
} from '@/engine/text/sentences';

const LONG_EN =
  'Modern browsers can translate pages on the device itself. ' +
  'That keeps the text private while the reader scrolls through a long document. ' +
  'A paragraph with several sentences is split before it reaches the model. ' +
  'The first sentence can then appear while the rest is still being generated. ' +
  'This keeps the reading flow intact even on a slower machine.';

describe('sentence splitting', () => {
  it('keeps short paragraphs unchanged', () => {
    expect(splitForTranslation('Hello. World.')).toEqual(['Hello. World.']);
  });

  it('splits a long paragraph into sentences', () => {
    const parts = splitForTranslation(LONG_EN);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts[0]).toBe('Modern browsers can translate pages on the device itself.');
    expect(parts.join(' ')).toContain(
      'This keeps the reading flow intact even on a slower machine.',
    );
  });

  it('does not split after common abbreviations', () => {
    const text =
      'Dr. Smith reviewed the results carefully before the meeting. ' +
      'The team agreed with every point in the summary. ' +
      'We will publish the final version next week.';
    const parts = splitForTranslation(text, { sentenceThreshold: 60 });

    expect(parts[0]?.startsWith('Dr. Smith reviewed')).toBe(true);
  });

  it('does not split decimal numbers', () => {
    const text =
      'Version 3.14 of the tool shipped today with a smaller download. ' +
      'Users upgraded quickly and reported fewer crashes. ' +
      'The next release is planned for the end of the month.';
    const parts = splitForTranslation(text, { sentenceThreshold: 60 });

    expect(parts[0]).toContain('Version 3.14 of the tool');
    expect(parts.every((part) => !part.startsWith('14'))).toBe(true);
  });

  it('does not split inside URLs or placeholder tags', () => {
    const text =
      'Read https://example.com/a.b for details before you start. ' +
      'Click <a1>Settings. Then</a1> to pick a profile. ' +
      'Continue with the rest of the setup when you are ready. ' +
      'This extra sentence pushes the paragraph past the split threshold.';

    const parts = splitForTranslation(text, { sentenceThreshold: 80 });
    const joined = parts.join(' ');

    expect(joined).toContain('https://example.com/a.b');
    for (const part of parts) {
      const opens = part.match(/<a1>/g)?.length ?? 0;
      const closes = part.match(/<\/a1>/g)?.length ?? 0;
      expect(opens).toBe(closes);
    }
  });

  it('splits Japanese paragraphs on full stops', () => {
    const text =
      'ブラウザの中で翻訳すると、本文が端末の外に出ません。' +
      '長い段落は文ごとに分けてからモデルに渡します。' +
      '最初の文が先に表示されるので、待ち時間が短く感じられます。' +
      '残りの文は後から続けて表示されます。';

    const parts = splitForTranslation(text, { sentenceThreshold: 40 });
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe('ブラウザの中で翻訳すると、本文が端末の外に出ません。');
  });

  it('protects punctuation in email addresses at the start and after a delimiter', () => {
    const first = '山田。花子@example.jp に送ります。';
    const second = '別の宛先は (佐藤。太郎@example.org) です。';
    expect(splitForTranslation(first + second, { sentenceThreshold: 1 })).toEqual([first, second]);
  });

  it('hard splits very long sentences at spaces', () => {
    const text = `${'word '.repeat(200)}end.`;
    const parts = splitForTranslation(text, { sentenceThreshold: 100, maxChunkChars: 120 });

    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((part) => part.length <= 130)).toBe(true);
  });

  it('hard splits long text without spaces', () => {
    const text = '長'.repeat(1000);
    const parts = splitForTranslation(text, { sentenceThreshold: 300, maxChunkChars: 120 });

    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((part) => part.length <= 120)).toBe(true);
    expect(parts.join('')).toBe(text);
  });

  it('joins translated sentences with the target language spacing', () => {
    expect(joinTranslatedSentences([' First.', 'Second. '], 'en')).toBe('First. Second.');
    expect(joinTranslatedSentences(['最初。', '次。'], 'ja')).toBe('最初。次。');
    expect(joinTranslatedSentences(['短くします。', '次です。'], 'ja-easy')).toBe(
      '短くします。次です。',
    );
    expect(sentenceSeparator('zh-hant')).toBe('');
    expect(sentenceSeparator('ja-easy')).toBe('');
    expect(sentenceSeparator('ko')).toBe(' ');
  });

  it('keeps an ordinary paragraph whole so the model sees its context', () => {
    expect(chunkForTranslation(` ${LONG_EN} `)).toEqual([LONG_EN]);
  });

  it('cuts a very long paragraph only between sentences', () => {
    const text = Array.from({ length: 6 }, () => LONG_EN).join(' ');
    const pieces = chunkForTranslation(text, 600);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(600);
      expect(piece.endsWith('.')).toBe(true);
      expect(piece.split('. ').length).toBeGreaterThan(2);
    }
    expect(pieces.join(' ')).toBe(text);
  });
});

/**
 * X renders the text of a long post as a run of adjacent spans, so the segment text is
 * tiled placeholder pairs with no depth-zero text between them, and one span can hold
 * several paragraphs. A "Show more" expansion of such a post used to come back as one
 * unsplittable segment that was then painted as its own source text.
 */
function tiledPost(): string {
  const paragraph = (label: string): string =>
    `${label} holds several sentences with periods inside the span itself. `.repeat(4);
  const head = paragraph('The opening paragraph');
  const body = Array.from({ length: 14 }, (_, i) => paragraph(`Body paragraph ${i + 1}`)).join('');
  const tail = paragraph('The closing paragraph');
  return `<i1>${head}</i1><i2>${body}</i2><i3>${tail}</i3><i4>end</i4>`;
}

describe('splitting span-tiled text', () => {
  it('splits a tiled long post into prompt-sized pieces', () => {
    const text = tiledPost();
    expect(text.length).toBeGreaterThan(4000);
    const pieces = chunkForTranslation(text);
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.every((piece) => piece.length <= 600)).toBe(true);
  });

  it('still splits when the recovery splitter asks for tiny pieces', () => {
    const pieces = splitForTranslation(tiledPost(), { sentenceThreshold: 80, maxChunkChars: 160 });
    expect(pieces.length).toBeGreaterThan(5);
    expect(pieces.every((piece) => piece.length <= 160)).toBe(true);
  });

  it('splits a tiled Japanese post without spaces or terminators', () => {
    const body = 'この段落はスパンの中に複数の文を含みます'.repeat(150);
    const pieces = chunkForTranslation(`<i1>${body}</i1><i2>終わり</i2>`);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= 600)).toBe(true);
  });

  it('keeps placeholder pairs intact when depth-zero space exists', () => {
    const text =
      'First sentence sits outside any span. '.repeat(6) +
      '<i1>A short labeled span stays whole.</i1> ' +
      'Second block of sentences also sits outside. '.repeat(6);
    const pieces = chunkForTranslation(text, 200);
    for (const piece of pieces) {
      const opens = piece.match(/<i1>/g)?.length ?? 0;
      const closes = piece.match(/<\/i1>/g)?.length ?? 0;
      expect(opens).toBe(closes);
    }
  });
});

describe('sentence terminators', () => {
  it('detects a finished caption line, ignoring trailing closers', () => {
    expect(hasSentenceTerminator('The train left.')).toBe(true);
    expect(hasSentenceTerminator('The train left."')).toBe(true);
    expect(hasSentenceTerminator('駅を出た。')).toBe(true);
    expect(hasSentenceTerminator('駅を出た。」')).toBe(true);
    expect(hasSentenceTerminator('The train left')).toBe(false);
    expect(hasSentenceTerminator('')).toBe(false);
  });
});
