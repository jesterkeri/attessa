import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

/**
 * Snapshot checks against FLOWS.md itself, not a copy: a FLOWS §6 sample block must appear, contiguous and
 * in order, in the CLI's transcript. Rules, applied the same way to both sides:
 * - `→ ` starts a CLI output line in FLOWS transcripts; it marks output, the CLI doesn't print it (as T15's lines).
 * - Hex values are placeholders in FLOWS (`0x…`, `0xabc…`, `0x7f3b…22`, `0xGATE…01`): any hex token matches any.
 * - ` …` (space, ellipsis) is FLOWS eliding the rest of a line or a run of lines.
 * - `slots` name the other sample values a test can't reproduce (a time of day, a block number), each with the
 *   pattern it may be in the output. Every other character must be equal.
 */

const FLOWS = readFileSync(new URL('../../../FLOWS.md', import.meta.url), 'utf8').split('\n');

/** The `nth` fenced block after the first line that starts with `marker`. */
export function flowsBlock(marker: string, nth = 0): string[] {
  let i = FLOWS.findIndex((l) => l.startsWith(marker));
  if (i < 0) throw new Error(`FLOWS.md has no line starting with ${JSON.stringify(marker)}`);
  for (let n = 0; ; n++) {
    while (FLOWS[i] !== '```') i++;
    const start = ++i;
    while (FLOWS[i] !== '```') i++;
    if (n === nth) return FLOWS.slice(start, i);
    i++;
  }
}

/** The output lines of `block` after the `$ <command>` line, up to the next command, comment or blank line. */
export function flowsOutput(block: string[], command?: string): string[] {
  let i = 0;
  if (command !== undefined) {
    i = block.findIndex((l) => l.startsWith(`$ ${command}`));
    if (i < 0) throw new Error(`FLOWS block has no "$ ${command}"`);
    i++;
  }
  const out: string[] = [];
  for (; i < block.length; i++) {
    const l = block[i]!;
    if (l.startsWith('$ ') || l.startsWith('#') || l.trim() === '') {
      if (out.length > 0) break;
      continue;
    }
    out.push(l.startsWith('→ ') ? l.slice(2) : l);
  }
  return out;
}

const HEX = /0x[0-9A-Za-z]*…[0-9A-Za-z]*|0x[0-9a-fA-F]+/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function flowsPattern(lines: string[], slots: Array<[string, string]> = []): RegExp {
  let text = lines.join('\n').replace(HEX, '0x…');
  const tokens: string[] = [];
  for (const [literal, pattern] of slots) {
    if (!text.includes(literal)) throw new Error(`slot ${JSON.stringify(literal)} is not in the FLOWS text`);
    text = text.split(literal).join(`\u0000${tokens.length}\u0000`);
    tokens.push(pattern);
  }
  text = text.replace(/ …(?= |$|\n)/g, '\u0001');
  const src = esc(text)
    .replace(/\u0000(\d+)\u0000/g, (_m, n: string) => `(?:${tokens[Number(n)]})`)
    .replace(/\u0001/g, '[\\s\\S]*?');
  return new RegExp(src);
}

export function normalizeOutput(lines: string[], hosts: Record<string, string> = {}): string {
  let text = lines.join('\n');
  for (const [from, to] of Object.entries(hosts)) text = text.split(from).join(to);
  return text.replace(HEX, '0x…');
}

/** Asserts the FLOWS lines appear, contiguous, in the transcript. */
export function expectFlows(transcript: string[], flows: string[], o: { slots?: Array<[string, string]>; hosts?: Record<string, string> } = {}): void {
  expect(flows.length).toBeGreaterThan(0);
  expect(normalizeOutput(transcript, o.hosts)).toMatch(flowsPattern(flows, o.slots));
}
