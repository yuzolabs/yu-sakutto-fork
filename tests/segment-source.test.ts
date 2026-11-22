// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildSegment, visibleOriginal } from '@/dom/segment';

describe('segment source', () => {
  it('keeps separators between links and leaves pronunciation out of the source', () => {
    document.body.innerHTML = `
      <p id="lead">Osaka (<span class="IPA">oːsaka</span>) is a <a href="/city">designated city</a>.<sup class="reference">[1]</sup></p>
      <p id="universities"><a href="/ou">Osaka University</a>, <a href="/omu">Osaka Metropolitan University</a></p>
      <p id="joined"><a href="/a">Osaka University</a><a href="/b">Osaka Metropolitan University</a></p>
    `;

    const lead = document.querySelector('#lead');
    const universities = document.querySelector('#universities');
    const joined = document.querySelector('#joined');
    if (!lead || !universities || !joined) throw new Error('missing paragraphs');

    const leadModel = buildSegment(lead);
    const listModel = buildSegment(universities);
    if (!leadModel || !listModel) throw new Error('missing segment');

    expect(leadModel.source).toContain('(');
    expect(leadModel.source).toContain('<i1>designated city</i1>');
    expect(leadModel.source).not.toContain('oːsaka');
    expect(leadModel.source).toMatch(/<i\d+>\[1\]<\/i\d+>/u);
    expect(listModel.source).toContain(', ');
    expect(visibleOriginal(universities)).toBe('Osaka University, Osaka Metropolitan University');
    expect(visibleOriginal(joined)).toBe('Osaka University Osaka Metropolitan University');
    expect(visibleOriginal(lead)).toContain('oːsaka');
    expect(visibleOriginal(lead)).toContain('[1]');
  });

  it('keeps an aria-hidden icon ligature out of the source and out of the translation', () => {
    // Material Symbols and friends paint a glyph from the literal word inside the span.
    // Sending that word to the model replaced it with a translated word, and the icon
    // then rendered that word's letters — a blank box or the wrong picture — in place of
    // the glyph. The decorative inline stays in the DOM and out of the segment.
    document.body.innerHTML = `
      <p id="lead">Search <span class="material-symbols-outlined" aria-hidden="true">search</span> models</p>
    `;
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing paragraph');
    const model = buildSegment(lead);
    if (!model) throw new Error('missing segment');

    expect(model.source).toContain('Search');
    expect(model.source).toContain('models');
    expect(model.source).not.toContain('search');
    expect(model.children).toHaveLength(0);
  });

  it('keeps a decorative separator between two links out of the source', () => {
    document.body.innerHTML = `
      <p id="lead"><a href="/a">Models</a><span aria-hidden="true">/</span><a href="/b">Datasets</a></p>
    `;
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing paragraph');
    const model = buildSegment(lead);
    if (!model) throw new Error('missing segment');

    expect(model.source).toContain('<i1>Models</i1>');
    expect(model.source).toContain('<i2>Datasets</i2>');
  });

  it.each(['pre', 'pre-wrap', 'pre-line', 'break-spaces'])(
    'keeps a newline that white-space: %s paints as a line of the source',
    (whiteSpace) => {
      // X draws a multi-line post with a literal `\n` in the text node and CSS that paints
      // it, never a `<br>`. Collapsing that newline into a space sent the post to the model
      // as one line.
      document.body.innerHTML = `<div id="post" style="white-space: ${whiteSpace}"><span>First line\nSecond line</span></div>`;
      const post = document.querySelector('#post');
      if (!post) throw new Error('missing post');
      const model = buildSegment(post);
      if (!model) throw new Error('missing segment');

      expect(model.source).toBe('<i1>First line\nSecond line</i1>');
      // The slot keeps the raw text node value, so restore puts the same bytes back.
      expect(model.children[0]?.gaps[0]?.[0]?.original).toBe('First line\nSecond line');
    },
  );

  it('reads white-space from a stylesheet and through inheritance', () => {
    document.head.innerHTML = '<style>.post-text { white-space: break-spaces; }</style>';
    document.body.innerHTML =
      '<div id="post" class="post-text"><span><em>Nested</em> first\nSecond</span></div>';
    const post = document.querySelector('#post');
    if (!post) throw new Error('missing post');
    const model = buildSegment(post);
    document.head.innerHTML = '';
    if (!model) throw new Error('missing segment');

    expect(model.source).toBe('<i2><i1>Nested</i1> first\nSecond</i2>');
  });

  it('still collapses the layout newlines of white-space: normal markup into a space', () => {
    document.body.innerHTML = `<p id="lead">
      First part of the sentence
      and the rest of it.
    </p>
    <div id="normal" style="white-space: normal"><span>One\nTwo</span></div>`;
    const lead = document.querySelector('#lead');
    const normal = document.querySelector('#normal');
    if (!lead || !normal) throw new Error('missing blocks');

    expect(buildSegment(lead)?.source).toBe('First part of the sentence and the rest of it.');
    expect(buildSegment(normal)?.source).toBe('<i1>One Two</i1>');
  });

  it('normalizes CRLF and keeps a blank line between painted paragraphs', () => {
    const post = document.createElement('div');
    post.style.whiteSpace = 'pre-wrap';
    post.append('First paragraph.\r\n\r\nSecond paragraph.\rThird line.\n\nLast.');
    document.body.replaceChildren(post);
    const model = buildSegment(post);
    if (!model) throw new Error('missing segment');

    expect(model.source).toBe('First paragraph.\n\nSecond paragraph.\nThird line.\n\nLast.');
    expect(model.gaps[0]?.[0]?.original).toBe(
      'First paragraph.\r\n\r\nSecond paragraph.\rThird line.\n\nLast.',
    );
  });

  it('keeps painted newlines inside a placeholder and a lone newline span out of the source', () => {
    // X puts a span that holds only `\n` between two hashtag lines. It has no words, so it
    // stays in the DOM painting its break instead of becoming an empty placeholder.
    document.body.innerHTML =
      '<div id="post" style="white-space: pre-wrap"><span>\nLaunch notes\n\n</span><a href="/hashtag/one">#one</a><span>\n</span><a href="/hashtag/two">#two</a></div>';
    const post = document.querySelector('#post');
    if (!post) throw new Error('missing post');
    const model = buildSegment(post);
    if (!model) throw new Error('missing segment');

    expect(model.source).toBe('<i1>\nLaunch notes\n\n</i1><i2>#one</i2><i3>#two</i3>');
    expect(model.children.map((child) => child.element.textContent)).toEqual([
      '\nLaunch notes\n\n',
      '#one',
      '#two',
    ]);
  });

  it('keeps a br-only inline element as a placeholder, as before painted newlines', () => {
    document.body.innerHTML =
      '<div id="mail" style="white-space: pre-wrap">Hello<span><br></span>World</div>';
    const mail = document.querySelector('#mail');
    if (!mail) throw new Error('missing mail');

    expect(buildSegment(mail)?.source).toBe('Hello<i1>\n</i1>World');
  });

  it('leaves an aria-hidden inline region to the block walk, as before this change', () => {
    // A decorative inline stays out of the parent's segment even when it wraps real text,
    // which is the pre-PR behaviour restored here. The block walk still descends into a
    // non-leaf `aria-hidden` region that contains blocks.
    document.body.innerHTML = `
      <p id="lead">Hello <span aria-hidden="true"><em>world</em></span> today</p>
    `;
    const lead = document.querySelector('#lead');
    if (!lead) throw new Error('missing paragraph');
    const model = buildSegment(lead);
    if (!model) throw new Error('missing segment');
    expect(model.source).not.toContain('world');
    expect(model.source).toContain('Hello');
    expect(model.source).toContain('today');
  });
});
