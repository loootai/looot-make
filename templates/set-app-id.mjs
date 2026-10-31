// Rewrites the looot module prefix in every templates/<slug>/blueprint.json to your app's id in Make.
//   node templates/set-app-id.mjs <app id>        for example looot-abc123
// Find the id in the app's URL in Make, or in any blueprint you export from a scenario that uses the app.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];
if (!id || !/^[a-z][0-9a-z-]+[0-9a-z]$/.test(id)) {
  console.error('Usage: node templates/set-app-id.mjs <app id>   (lowercase letters, digits and hyphens, as Make shows it)');
  process.exit(2);
}
let files = 0;
for (const entry of await readdir(DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(DIR, entry.name, 'blueprint.json');
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) continue;
  const next = text.replace(/"app#[0-9a-z-]+:/g, `"app#${id}:`);
  if (next !== text) { await writeFile(file, next); files += 1; }
}
console.log(`rewrote ${files} blueprints to app#${id}`);
