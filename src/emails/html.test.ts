import { describe, expect, it } from 'vitest'
import { escapeHtml, html, rawHtml, SafeHtml } from './html'

describe('escapeHtml', () => {
  it('escapes & < > " and apostrophe', () => {
    expect(escapeHtml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &#39;')
  })

  it('escapes the ampersand once, not twice', () => {
    expect(escapeHtml('<')).toBe('&lt;')
  })

  it('leaves plain text alone', () => {
    expect(escapeHtml('Hello, world 123')).toBe('Hello, world 123')
  })
})

describe('html tagged template', () => {
  it('returns SafeHtml', () => {
    expect(html`<p>x</p>`).toBeInstanceOf(SafeHtml)
    expect(html`<p>x</p>`.value).toBe('<p>x</p>')
  })

  it('escapes interpolated strings', () => {
    expect(html`<p>${'<script>alert(1)</script>'}</p>`.value).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('escapes quotes so attribute values cannot be broken out of', () => {
    expect(html`<a title="${'" onclick="x'}">`.value).toBe('<a title="&quot; onclick=&quot;x">')
  })

  it('renders numbers', () => {
    expect(html`<b>${482913}</b>`.value).toBe('<b>482913</b>')
  })

  it('inserts SafeHtml raw so nested templates compose without double escaping', () => {
    const inner = html`<b>${'a & b'}</b>`
    expect(html`<p>${inner}</p>`.value).toBe('<p><b>a &amp; b</b></p>')
  })

  it('flattens arrays, applying the same rules to each item', () => {
    const items = ['<x>', html`<i>1</i>`, 2]
    expect(html`<ul>${items}</ul>`.value).toBe('<ul>&lt;x&gt;<i>1</i>2</ul>')
  })

  it('flattens nested arrays', () => {
    expect(html`${[['a', ['<']], 'b']}`.value).toBe('a&lt;b')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['false', false],
  ])('renders %s as an empty string', (_label, value) => {
    expect(html`[${value}]`.value).toBe('[]')
  })

  it('renders null, undefined and false inside arrays as empty', () => {
    expect(html`[${['a', null, undefined, false, 'b']}]`.value).toBe('[ab]')
  })
})

describe('rawHtml', () => {
  it('is inserted unescaped', () => {
    expect(html`<p>${rawHtml('<b>&nbsp;</b>')}</p>`.value).toBe('<p><b>&nbsp;</b></p>')
  })

  it('returns SafeHtml with the markup as value', () => {
    expect(rawHtml('<hr>')).toBeInstanceOf(SafeHtml)
    expect(rawHtml('<hr>').value).toBe('<hr>')
  })
})
