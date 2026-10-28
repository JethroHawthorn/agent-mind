import { createHash } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { AgentMindError } from './errors.js';
import {
  type InstallationManifest,
  type InstallationRecord,
  installationManifestSchema,
} from './skill-distribution-model.js';
import { hashSkillFiles, skillFilesSchema } from './skill-model.js';

export const INSTALLATION_MANIFEST = '.agentmind-install.json';
export const digestText = (text: string) => createHash('sha256').update(text).digest('hex');
export function fileIdentity(path: string): string {
  const s = lstatSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}
export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Repeated ancestry checks mitigate accidental/routine substitutions, not a hostile same-UID openat race. */
export function inspectPath(base: string, path: string) {
  const rel = relative(base, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
    throw new AgentMindError('UNSAFE_DESTINATION', 'Destination escapes the authorized root.');
  const result: Array<{ path: string; identity: string | null }> = [];
  let cursor = base;
  for (const part of ['', ...rel.split(sep).filter(Boolean)]) {
    if (part) cursor = join(cursor, part);
    if (!pathExists(cursor)) {
      result.push({ path: cursor, identity: null });
      continue;
    }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(cursor) !== cursor)
      throw new AgentMindError(
        'UNSAFE_DESTINATION',
        'Destination ancestry must contain ordinary canonical directories, without symlinks.',
      );
    result.push({ path: cursor, identity: fileIdentity(cursor) });
  }
  return result;
}
/** Namespace durability barrier. Fails closed if this filesystem cannot synchronize directories. */
export function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    if (!fstatSync(fd).isDirectory()) throw new Error('not directory');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export type PublicationPermissions = Readonly<{ gid: number }>;
export function createSafeDirectories(
  base: string,
  path: string,
  permissions?: PublicationPermissions,
) {
  inspectPath(base, path);
  const rel = relative(base, path);
  let cursor = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    inspectPath(base, dirname(cursor));
    if (!pathExists(cursor)) {
      mkdirSync(cursor, { mode: 0o700 });
      syncDirectory(dirname(cursor));
      if (permissions) {
        chownSync(cursor, -1, permissions.gid);
        chmodSync(cursor, 0o750);
      }
    }
    inspectPath(base, cursor);
  }
}
function readOrdinaryFile(path: string, max: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw new Error('unsupported file');
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      length += count;
      if (length > max) throw new Error('file grew beyond bound');
      if (count === 0) break;
    }
    if (fstatSync(fd).size !== stat.size || length !== stat.size) throw new Error('file changed');
    const bytes = buffer.subarray(0, length);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('invalid utf8');
    return text;
  } finally {
    closeSync(fd);
  }
}
export function inspectPackage(path: string) {
  if (!pathExists(path)) return { status: 'missing' as const };
  try {
    const root = lstatSync(path);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('not directory');
    const identity = fileIdentity(path);
    const manifestText = readOrdinaryFile(join(path, INSTALLATION_MANIFEST), 8192);
    const manifest = installationManifestSchema.parse(JSON.parse(manifestText));
    const files: Array<{ path: string; content: string }> = [];
    let nodes = 0;
    const directories: string[] = [];
    const walk = (folder: string) => {
      const entries = readdirSync(folder).sort();
      if (nodes + entries.length > 4096) throw new Error('too many entries');
      for (const entry of entries) {
        nodes++;
        const full = join(folder, entry);
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) throw new Error('symlink');
        if (stat.isDirectory()) {
          directories.push(relative(path, full).split(sep).join('/'));
          walk(full);
        } else {
          const name = relative(path, full).split(sep).join('/');
          if (name === INSTALLATION_MANIFEST) continue;
          if (files.length >= 32) throw new Error('too many files');
          files.push({ path: name, content: readOrdinaryFile(full, 262144) });
        }
      }
    };
    walk(path);
    const expectedDirs = new Set<string>();
    for (const file of files) {
      const parts = file.path.split('/');
      parts.pop();
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        expectedDirs.add(current);
      }
    }
    if (
      directories.some((dir) => !expectedDirs.has(dir)) ||
      directories.length !== expectedDirs.size
    )
      throw new Error('unexpected directory');
    const digest = hashSkillFiles(files);
    if (fileIdentity(path) !== identity) throw new Error('substitution');
    return {
      status: 'present' as const,
      identity,
      manifest,
      manifest_hash: digestText(manifestText),
      content_digest: digest,
    };
  } catch {
    return { status: 'unsafe' as const };
  }
}
export function matchesRecord(
  observed: ReturnType<typeof inspectPackage>,
  record: InstallationRecord,
): boolean {
  return (
    record.status === 'installed' &&
    observed.status === 'present' &&
    observed.identity === record.root_identity &&
    observed.manifest_hash === record.manifest_hash &&
    observed.content_digest === record.installed_digest &&
    observed.manifest.installed_digest === record.installed_digest &&
    observed.manifest.registry_digest === record.installed_digest &&
    observed.manifest.installation_id === record.id &&
    observed.manifest.destination === record.destination &&
    observed.manifest.version_id === record.version_id &&
    observed.manifest.project_id === record.project_id &&
    observed.manifest.skill_id === record.skill_id &&
    observed.manifest.target === record.target &&
    observed.manifest.scope === record.scope
  );
}
export function materializePackage(
  base: string,
  path: string,
  files: Array<{ path: string; content: string }>,
  manifest: InstallationManifest,
  permissions?: PublicationPermissions,
) {
  files = skillFilesSchema.parse(files);
  manifest = installationManifestSchema.parse(manifest);
  if (
    hashSkillFiles(files) !== manifest.registry_digest ||
    manifest.installed_digest !== manifest.registry_digest
  )
    throw new AgentMindError('STAGING_INTEGRITY_ERROR', 'Package and manifest digest mismatch.');
  inspectPath(base, dirname(path));
  mkdirSync(path, { mode: 0o700 });
  if (permissions) {
    chownSync(path, -1, permissions.gid);
    chmodSync(path, 0o750);
  }
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const dest = join(path, file.path);
    createSafeDirectories(base, dirname(dest), permissions);
    const fd = openSync(
      dest,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, file.content, 'utf8');
      if (permissions) {
        fchownSync(fd, -1, permissions.gid);
        fchmodSync(fd, 0o640);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  const fd = openSync(
    join(path, INSTALLATION_MANIFEST),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(manifest), 'utf8');
    if (permissions) {
      fchownSync(fd, -1, permissions.gid);
      fchmodSync(fd, 0o640);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // File data was fsynced above; flush child namespaces before making the root visible.
  const syncTree = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const child = join(folder, name);
      if (lstatSync(child).isDirectory()) syncTree(child);
    }
    syncDirectory(folder);
  };
  syncTree(path);
  syncDirectory(dirname(path));
  const staged = inspectPackage(path);
  if (
    staged.status !== 'present' ||
    staged.content_digest !== manifest.registry_digest ||
    staged.manifest_hash !== digestText(JSON.stringify(manifest))
  )
    throw new AgentMindError(
      'STAGING_INTEGRITY_ERROR',
      'Staged artifact does not exactly match the approved snapshot.',
    );
  return staged;
}
export function moveChecked(base: string, from: string, to: string) {
  inspectPath(base, dirname(from));
  inspectPath(base, dirname(to));
  if (pathExists(to))
    throw new AgentMindError('DISTRIBUTION_CONFLICT', 'Move destination already exists.');
  renameSync(from, to);
  syncDirectory(dirname(to));
  if (dirname(from) !== dirname(to)) syncDirectory(dirname(from));
  inspectPath(base, dirname(from));
  inspectPath(base, dirname(to));
}
export function deleteCheckedPackage(base: string, path: string, record: InstallationRecord) {
  inspectPath(base, dirname(path));
  if (!matchesRecord(inspectPackage(path), record))
    throw new AgentMindError(
      'DISTRIBUTION_CONFLICT',
      'Refusing cleanup of changed or unproven content.',
    );
  rmSync(path, { recursive: true, force: false });
  syncDirectory(dirname(path));
}
