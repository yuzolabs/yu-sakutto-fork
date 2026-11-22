// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { LINE_TAG, applyTranslation, restoreSegment, showBilingual } from '@/dom/render';
import { buildSegment, type SegmentModel } from '@/dom/segment';

/**
 * X draws a multi-line post without `<br>`: the text node holds literal newlines and the post
 * text's CSS (`white-space: pre-wrap` / `break-spaces`) paints them. The translation has to
 * come back on the same lines whether or not the model kept the newlines, and restoring the
 * page has to put the original bytes back.
 */
function xPost(text: string, whiteSpace = 'break-spaces'): HTMLElement {
  const post = document.createElement('div');
  post.setAttribute('data-testid', 'tweetText');
  post.setAttribute('lang', 'en');
  const span = document.createElement('span');
  span.style.whiteSpace = whiteSpace;
  span.textContent = text;
  post.append(span);
  document.body.replaceChildren(post);
  return post;
}

function segment(block: Element): SegmentModel {
  const model = buildSegment(block);
  if (!model) throw new Error('missing segment');
  return model;
}

function translate(model: SegmentModel, render: (source: string) => string): Text[] {
  const created: Text[] = [];
  applyTranslation(model, render(model.source), created);
  return created;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('newlines painted by CSS', () => {
  it('keeps the lines when the model keeps the newlines', () => {
    const post = xPost('Good morning everyone.\nThe meeting starts at ten.');
    const model = segment(post);
    expect(model.source).toBe('<i1>Good morning everyone.\nThe meeting starts at ten.</i1>');

    translate(model, () => '<i1>皆さん、おはようございます。\n会議は10時に始まります。</i1>');
    expect(post.querySelector('span')?.textContent).toBe(
      '皆さん、おはようございます。\n会議は10時に始まります。',
    );
    expect(post.querySelectorAll('br')).toHaveLength(0);
  });

  it('puts the lines back when the model returns one line', () => {
    const post = xPost('Good morning everyone.\nThe meeting starts at ten.');
    const model = segment(post);

    translate(model, () => '<i1>皆さん、おはようございます。会議は10時に始まります。</i1>');
    expect(post.querySelector('span')?.textContent).toBe(
      '皆さん、おはようございます。\n会議は10時に始まります。',
    );
    // The lines live in the one text node; no `<br>` or wrapper is added to the page.
    expect(post.querySelector('span')?.childNodes).toHaveLength(1);
    expect(post.querySelectorAll('br')).toHaveLength(0);
  });

  it('keeps blank lines between paragraphs and the newlines after the last one', () => {
    // `Launch notes` and the hashtag are separate spans on X, with the blank line inside the
    // first span's text.
    document.body.innerHTML =
      '<div data-testid="tweetText" lang="en" style="white-space: pre-wrap"><span>Launch notes are out.\n\nRead them before Friday.\n\n</span><a href="/hashtag/release">#release</a></div>';
    const post = document.querySelector('div');
    if (!post) throw new Error('missing post');
    const model = segment(post);
    expect(model.source).toBe(
      '<i1>Launch notes are out.\n\nRead them before Friday.\n\n</i1><i2>#release</i2>',
    );

    translate(
      model,
      () => '<i1>リリースノートを公開しました。金曜日までに読んでください。</i1><i2>#release</i2>',
    );
    expect(post.querySelector('span')?.textContent).toBe(
      'リリースノートを公開しました。\n\n金曜日までに読んでください。\n\n',
    );
    expect(post.querySelector('a')?.textContent).toBe('#release');
  });

  it('restores a blank line the model dropped while keeping one newline', () => {
    const post = xPost('First paragraph here.\n\nSecond paragraph here.');
    const model = segment(post);

    translate(model, () => '<i1>最初の段落です。\n2番目の段落です。</i1>');
    expect(post.querySelector('span')?.textContent).toBe('最初の段落です。\n\n2番目の段落です。');
  });

  it('spreads a one-line English translation over the lines by sentences', () => {
    const post = xPost('Line one is here.\nLine two is here.\nLine three is here.', 'pre-wrap');
    const model = segment(post);

    translate(model, () => '<i1>First sentence. Second sentence. Third sentence.</i1>');
    expect(post.querySelector('span')?.textContent).toBe(
      'First sentence.\nSecond sentence.\nThird sentence.',
    );
  });

  it('keeps the model layout when it kept newlines but not the same number of lines', () => {
    const post = xPost('One short line.\nAnother short line.\nA third short line.');
    const model = segment(post);

    translate(model, () => '<i1>短い行です。別の短い行です。\n3つ目の短い行です。</i1>');
    expect(post.querySelector('span')?.textContent).toBe(
      '短い行です。別の短い行です。\n3つ目の短い行です。',
    );
  });

  it('treats <br> and painted newlines as line boundaries together', () => {
    document.body.innerHTML =
      '<div id="post" style="white-space: pre-wrap">Line one.\nLine two.<br>Line three.</div>';
    const post = document.querySelector('#post');
    if (!post) throw new Error('missing post');
    const before = post.innerHTML;
    const model = segment(post);
    expect(model.source).toBe('Line one.\nLine two.\nLine three.');

    const created = translate(model, () => '一行目です。二行目です。三行目です。');
    const [first, br, last] = [...post.childNodes];
    expect(first?.nodeValue).toBe('一行目です。\n二行目です。');
    expect(br?.nodeName).toBe('BR');
    expect(last?.nodeValue).toBe('三行目です。');
    expect(post.childNodes).toHaveLength(3);

    restoreSegment(model, created);
    expect(post.innerHTML).toBe(before);
  });

  it('leaves the layout newlines of white-space: normal text on one line', () => {
    document.body.innerHTML = `<p id="lead">First part of the sentence.
      Second part of the sentence.</p>`;
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing paragraph');
    const model = segment(lead);
    expect(model.source).toBe('First part of the sentence. Second part of the sentence.');

    translate(model, () => '文の最初の部分。文の2番目の部分。');
    expect(lead.textContent).toBe('文の最初の部分。文の2番目の部分。');
  });

  it('restores the original text, CRLF and all, byte for byte', () => {
    const post = xPost('Line one.\r\n\r\nLine two.\nLine three.');
    const before = post.innerHTML;
    const model = segment(post);
    expect(model.source).toBe('<i1>Line one.\n\nLine two.\nLine three.</i1>');

    const created = translate(model, () => '<i1>一行目。二行目。三行目。</i1>');
    expect(post.querySelector('span')?.textContent).toBe('一行目。\r\n\r\n二行目。\n三行目。');

    restoreSegment(model, created);
    expect(post.innerHTML).toBe(before);
    expect(post.querySelector('span')?.textContent).toBe('Line one.\r\n\r\nLine two.\nLine three.');
  });

  it('paints the bilingual line with its newlines and clears the rule for a one-line source', () => {
    const post = xPost('Good morning everyone.\nThe meeting starts at ten.');
    const model = segment(post);
    const created: Text[] = [];

    showBilingual(
      model,
      '<i1>皆さん、おはようございます。\n会議は10時に始まります。</i1>',
      created,
    );
    const line = post.querySelector<HTMLElement>(LINE_TAG);
    if (!line) throw new Error('missing bilingual line');
    expect(line.style.whiteSpace).toBe('pre-wrap');
    expect(line.textContent).toBe('皆さん、おはようございます。\n会議は10時に始まります。');
    // The original stays as it was, above the translation.
    expect(post.querySelector('span')?.textContent).toBe(
      'Good morning everyone.\nThe meeting starts at ten.',
    );

    // Painting the block again for a source without line breaks leaves no rule behind.
    const oneLine = { ...model, source: '<i1>Good morning everyone.</i1>' };
    showBilingual(oneLine, '<i1>皆さん、おはようございます。</i1>', created);
    const repainted = post.querySelector<HTMLElement>(LINE_TAG);
    expect(post.querySelectorAll(LINE_TAG)).toHaveLength(1);
    expect(repainted?.style.whiteSpace).toBe('');
    expect(repainted?.hasAttribute('style')).toBe(false);
    expect(repainted?.textContent).toBe('皆さん、おはようございます。');

    restoreSegment(model, created);
    expect(post.querySelector(LINE_TAG)).toBeNull();
  });

  it('paints the bilingual line of a <br> source with its newlines too', () => {
    document.body.innerHTML = '<p id="lines">First line<br>Second line</p>';
    const paragraph = document.querySelector('#lines');
    if (!paragraph) throw new Error('missing paragraph');
    const model = segment(paragraph);
    const created: Text[] = [];

    showBilingual(model, '一行目\n二行目', created);
    const line = paragraph.querySelector<HTMLElement>(LINE_TAG);
    expect(line?.style.whiteSpace).toBe('pre-wrap');
    expect(line?.textContent).toBe('一行目\n二行目');
  });
});
