/**
 * RFC 8785 JSON Canonicalization Scheme. ECMAScript's JSON serialisation of
 * primitives is the one RFC 8785 specifies, and `Array.prototype.sort` without a
 * comparator orders keys by UTF-16 code units, as RFC 8785 §3.2.3 requires.
 */
export function jcs(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (/\p{Cs}/u.test(value)) throw new TypeError('JCS: lone surrogate in string');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const members = Object.keys(obj)
      .sort()
      .map((k) => `${jcs(k)}:${jcs(obj[k])}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`JCS: unsupported type ${typeof value}`);
}
