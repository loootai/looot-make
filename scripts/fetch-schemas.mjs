// Downloads Make's own JSON schemas for custom app files into .cache/make-schemas.
// Source: the Make Apps SDK for VS Code (integromat/vscode-apps-sdk), pinned to one commit.
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SDK_COMMIT = '6ff5f3dd9960ccbeb24de3beb1cca935de89eaa0';
export const SCHEMA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'make-schemas', SDK_COMMIT);
const RAW = `https://raw.githubusercontent.com/integromat/vscode-apps-sdk/${SDK_COMMIT}`;
const FILES = {
  'makecomapp.schema.json': 'syntaxes/local-development/schemas/makecomapp.schema.json',
  ...Object.fromEntries(
    ['api', 'base', 'common', 'enums', 'epoch', 'groups', 'parameters', 'response', 'samples', 'sources'].map((name) => [
      `${name}.json`,
      `syntaxes/imljson/schemas/${name}.json`,
    ]),
  ),
};

/** Fetches every schema that is not in the cache yet. */
export async function fetchSchemas() {
  await mkdir(SCHEMA_DIR, { recursive: true });
  let downloaded = 0;
  for (const [name, source] of Object.entries(FILES)) {
    const target = path.join(SCHEMA_DIR, name);
    try {
      await access(target);
      continue;
    } catch {
      // not cached yet
    }
    const response = await fetch(`${RAW}/${source}`);
    if (!response.ok) throw new Error(`Could not download ${source}: HTTP ${response.status}`);
    await writeFile(target, await response.text());
    downloaded += 1;
  }
  return downloaded;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const downloaded = await fetchSchemas();
  console.log(`Make schemas at ${SDK_COMMIT.slice(0, 7)}: ${Object.keys(FILES).length} files, ${downloaded} downloaded`);
}
