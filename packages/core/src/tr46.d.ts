// tr46 ships no types. Only what origin.ts uses.
declare module 'tr46' {
  const tr46: { toUnicode(domain: string): { domain: string; error: boolean } };
  export default tr46;
}
declare module 'tr46/lib/regexes.js' {
  const regexes: { combiningClassVirama: RegExp; validZWNJ: RegExp };
  export default regexes;
}
