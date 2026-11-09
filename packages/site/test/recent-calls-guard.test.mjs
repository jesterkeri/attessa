// Adversary probe (commit 53a5e45). Spec: test/status-switch.test.mjs "no flag is on while its work is unfinished"
// must refuse a true flag while its work isn't done. live.recentCalls turns explorer.html's "This list isn't built yet.
// It will show the latest settlements, read from Celo events." into "The latest settlements, read from Celo events."
// That feed is TASKS.md T46 ("Recent calls feed from settlement events"). The guard's NEEDS names T45 (wire the
// payment check UI, which reads one transaction), so T45 ticked + T46 unticked lets the flag go on and the page
// state a feed that does not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const guard = readFileSync(`${repo}/packages/site/test/status-switch.test.mjs`, 'utf8');
const tasks = readFileSync(`${repo}/TASKS.md`, 'utf8');

test('the recentCalls guard waits for the task that builds the recent calls feed', () => {
  const feed = tasks.match(/^- \[[ x]\] (T\d+\w*) Recent calls feed/m)?.[1];
  assert.ok(feed, 'precondition: TASKS.md has a task for the recent calls feed');
  const needs = guard.match(/recentCalls: \{ tasks: \[([^\]]*)\] \}/)?.[1];
  assert.ok(needs, 'precondition: NEEDS.recentCalls is a task list');
  assert.ok(needs.includes(`'${feed}'`), `NEEDS.recentCalls is [${needs}] but the feed that the flipped sentence describes is ${feed}`);
});
