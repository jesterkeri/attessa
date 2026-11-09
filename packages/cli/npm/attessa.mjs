#!/usr/bin/env node
// The package's entry point. node:sqlite prints an experimental warning on every run, which reads like a fault to someone
// using this tool. Only that one warning is dropped, and it has to happen before the bundle's imports load.
const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (warning === 'SQLite is an experimental feature and might change at any time' && rest[0] === 'ExperimentalWarning') return;
  return emit.call(process, warning, ...rest);
};
await import('./bin.mjs');
