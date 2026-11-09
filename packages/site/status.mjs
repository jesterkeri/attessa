// The one switch for what is live. site.config.json `live` names each feature that isn't live for everyone yet.
// Pages hold their final wording, and anything only true before launch sits in a block:
//   <!--notlive:seller-->shown until the feature is live<!--/notlive-->
//   <!--live:seller-->shown once it is live<!--/live-->
// `all` is on only when every feature is. A page's title and description are one-line comments themselves, so inside
// those lines write {{#notlive seller}}..{{/notlive}} and {{#live seller}}..{{/live}} instead.
// Set the key to true in site.config.json and rebuild, and every such block changes together.
// test/status-switch.test.mjs refuses a true key while its work is unfinished, so a flip needs the real work.
export const FEATURES = ['seller', 'verify', 'viaBuy', 'releaseVerify', 'statusVerdicts', 'recentCalls'];

export function readLive(config) {
  const live = config.live ?? {};
  for (const [k, v] of Object.entries(live)) {
    if (!FEATURES.includes(k)) throw new Error(`site.config.json: live.${k} is not a known feature`);
    if (typeof v !== 'boolean') throw new Error(`site.config.json: live.${k} must be true or false`);
  }
  const flags = Object.fromEntries(FEATURES.map(k => [k, live[k] === true]));
  return { ...flags, all: FEATURES.every(k => flags[k]) };
}

const BLOCK = /<!--(live|notlive):(\w+)-->([\s\S]*?)<!--\/\1-->|\{\{#(live|notlive) (\w+)\}\}([\s\S]*?)\{\{\/\4\}\}/g;
const TOKEN = /<!--\/?(live|notlive)\b[^>]*-->|\{\{[#/](live|notlive)[^}]*\}\}/;

export function applyStatus(html, live) {
  const out = html.replace(BLOCK, (_, k1, key1, body1, k2, key2, body2) => {
    const kind = k1 ?? k2, key = key1 ?? key2, body = body1 ?? body2;
    if (!(key in live)) throw new Error(`unknown live feature in a page: ${key}`);
    if (TOKEN.test(body)) throw new Error(`nested live block for ${key}`);
    return (kind === 'live') === live[key] ? body : '';
  });
  const left = TOKEN.exec(out);
  if (left) throw new Error(`unbalanced live block: ${left[0]}`);
  return out;
}
