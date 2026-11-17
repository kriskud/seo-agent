// Small strict reader for Yandex's fixed XML response. No DTD/external entities.
// A stack validates nesting; CDATA and highlighting tags preserve text content.
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity];
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) || n === 0) throw new Error('Invalid XML character');
    return String.fromCodePoint(n);
  });
}

export function parseResults(xml) {
  const root = { name: '', text: '', children: [] };
  const stack = [root];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g;
  let end = 0;
  for (const m of xml.matchAll(tokens)) {
    if (m.index !== end) throw new Error('Malformed search XML');
    end = m.index + m[0].length;
    const token = m[0];
    const node = stack.at(-1);
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { node.text += token.slice(9, -3); continue; }
    if (token.startsWith('<!')) throw new Error('Unsupported XML declaration');
    if (token.startsWith('</')) {
      if (stack.length < 2 || token !== `</${node.name}>`) throw new Error('Malformed search XML');
      stack.pop(); stack.at(-1).text += node.text;
    } else if (token.startsWith('<')) {
      const name = /^<([\w:-]+)(?:\s[^<>]*?)?\s*\/?>$/.exec(token)?.[1];
      if (!name) throw new Error('Malformed search XML tag');
      const child = { name, text: '', children: [], tag: token };
      node.children.push(child);
      if (!token.endsWith('/>')) stack.push(child);
    } else node.text += decode(token);
  }
  if (end !== xml.length || stack.length !== 1 || root.children.length !== 1 || root.children[0].name !== 'yandexsearch') {
    throw new Error('Invalid Yandex XML response');
  }
  const all = (node, name) => node.children.flatMap(c => c.name === name ? [c] : all(c, name));
  const error = all(root, 'error')[0];
  if (error) {
    const code = /\bcode=["'](\d+)["']/.exec(error.tag)?.[1];
    if (code === '15') return []; // Documented "no results".
    const failure = new Error(`Yandex XML error ${code ?? 'unknown'}`);
    failure.fatal = true;
    throw failure;
  }
  if (!all(root, 'response').length || !all(root, 'results').length) throw new Error('Missing search results in XML');
  const field = (node, name) => all(node, name)[0]?.text.replace(/\s+/g, ' ').trim() ?? '';
  return all(root, 'doc').map(doc => ({
    url: field(doc, 'url'), title: field(doc, 'title'),
    snippet: all(doc, 'passage').map(p => p.text.replace(/\s+/g, ' ').trim()).join(' '),
    // modtime is NOT a publication date. Retain its original value separately.
    publishedAt: null, providerModifiedAt: field(doc, 'modtime') || null,
  }));
}
