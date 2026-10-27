import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** Canonical installed SDKs only; aliases do not cause repeated probes. */
export function installedSdks(defaultSdk, roots = [dirname(defaultSdk)]) {
  const candidates = [defaultSdk];
  for (const root of roots) {
    try {
      const names = readdirSync(root).filter((name) =>
        /^MacOSX(?:\d+(?:\.\d+)*)?\.sdk$/.test(name),
      );
      names.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      candidates.push(...names.map((name) => join(root, name)));
    } catch {
      /* A missing optional SDK root is not a build permission bypass. */
    }
  }
  const canonical = [];
  for (const path of candidates) {
    try {
      const p = realpathSync(path);
      if (!canonical.includes(p)) canonical.push(p);
    } catch {}
  }
  return canonical.slice(0, 6);
}
/** Probe failures never change the output artifact. An explicit SDK is passed as a singleton. */
export function firstCompatible(candidates, probe) {
  for (const sdk of candidates.slice(0, 6)) if (probe(sdk)) return sdk;
  return null;
}
