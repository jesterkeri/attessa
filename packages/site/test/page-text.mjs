// The text a page shows, one line per block, for the copy snapshot in pages.test.mjs.
// Tags, scripts, styles and inline SVG are dropped; the title and meta description are kept, since
// they are copy too. Markup-only changes (an icon, a class, a script tag) leave the text unchanged;
// any change to the words shows as a line diff in test/snapshots/text/.
const BLOCK = /^(address|article|aside|blockquote|br|button|caption|dd|details|dialog|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|label|legend|li|main|nav|ol|option|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)$/i;
const NL = '\u0000';

/** @param {string} s */
function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** @param {string} html */
export function pageText(html) {
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const description = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] ?? '';
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1];
  if (body === undefined) throw new Error('page has no <body>');
  const text = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1\s*>/gi, NL)
    // Line breaks inside <pre> are content (terminal output), so each becomes its own line.
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner) => NL + inner.replace(/\r?\n/g, NL) + NL)
    .replace(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi, (_, tag) => (BLOCK.test(tag) ? NL : ''));
  const lines = decode(text)
    .split(NL)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return [`title: ${decode(title).trim()}`, `description: ${decode(description).trim()}`, '', ...lines, ''].join('\n');
}
