import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

export function prepareFileSelection(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 100 || paths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error('files requires 1–100 explicit absolute paths');
  const canonical = new Set();
  const inventory = [];
  let bytes = 0;
  const inspect = (path, name, depth = 0) => {
    if (depth > 32) throw new Error('Upload directory depth limit exceeded');
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error('Upload symlinks are not supported');
    if (entry.isDirectory()) {
      for (const child of readdirSync(path).sort()) inspect(join(path, child), name + '/' + child, depth + 1);
      return;
    }
    if (!entry.isFile()) throw new Error('Upload requires regular files');
    if (inventory.length >= 1000 || bytes + entry.size > 128 * 1024 * 1024) throw new Error('Upload exceeds 1000 files or 128 MiB');
    bytes += entry.size;
    inventory.push({ name, bytes: entry.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
  };
  const selections = paths.map(path => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error('Upload symlinks are not supported');
    const canonicalPath = realpathSync(path);
    if (canonical.has(canonicalPath)) throw new Error('Duplicate upload selection');
    canonical.add(canonicalPath);
    const name = basename(canonicalPath);
    inspect(canonicalPath, name);
    return { path: canonicalPath, name, kind: entry.isDirectory() ? 'directory' : 'file' };
  });
  if (!inventory.length) throw new Error('Upload selection has no files');
  if (new Set(inventory.map(file => file.name)).size !== inventory.length) throw new Error('Ambiguous upload names');
  const fingerprint = createHash('sha256').update(JSON.stringify({ selections, inventory })).digest('hex');
  return { selections, inventory, file_count: inventory.length, total_bytes: bytes, fingerprint };
}

export function fileSelectionSummary(selection) {
  return { file_count: selection.file_count, total_bytes: selection.total_bytes,
    selections: selection.selections.map(({ name, kind }) => ({ name, kind })),
    fingerprint: selection.fingerprint };
}
