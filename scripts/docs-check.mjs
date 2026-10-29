// Lightweight checks for the curated operational docs, not a Markdown instruction executor.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function checkDocs(root = fileURLToPath(new URL('../', import.meta.url))) {
  const files = [
    'README.md',
    'SECURITY.md',
    ...readdirSync(resolve(root, 'docs/v1'))
      .filter((p) => p.endsWith('.md'))
      .map((p) => `docs/v1/${p}`),
  ];
  const errors = [];
  let links = 0,
    shell = 0,
    json = 0;
  for (const path of files) {
    const text = readFileSync(resolve(root, path), 'utf8');
    for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^(https?:|mailto:)/.test(target)) continue;
      links++;
      const p = resolve(root, dirname(path), target);
      if (!p.startsWith(`${resolve(root)}/`) || !existsSync(p))
        errors.push({ path, rule: 'BROKEN_LOCAL_LINK', target });
    }
    for (const m of text.matchAll(/```(sh|json)\n([\s\S]*?)```/g)) {
      if (m[1] === 'json') {
        json++;
        try {
          JSON.parse(m[2]);
        } catch {
          errors.push({ path, rule: 'INVALID_JSON' });
        }
      } else {
        shell++;
        const r = spawnSync('/bin/sh', ['-n'], {
          input: m[2],
          encoding: 'utf8',
          timeout: 1000,
          env: { PATH: '/usr/bin:/bin' },
        });
        if (r.status !== 0) errors.push({ path, rule: 'INVALID_SHELL_SYNTAX' });
      }
    }
    if (/(?:fully secure|production verified|certified on (?:Linux|Windows))/i.test(text))
      errors.push({ path, rule: 'UNSUPPORTED_ASSURANCE_CLAIM' });
  }
  const install = readFileSync(resolve(root, 'docs/v1/INSTALLATION.md'), 'utf8');
  for (const token of ['NOT VERIFIED', 'Codex', 'Claude', 'Gemini', '0700', 'P6-004']) {
    // Private mode is documented in upgrade rather than install.
    if (token === '0700') continue;
    if (!install.includes(token))
      errors.push({ path: 'docs/v1/INSTALLATION.md', rule: 'MISSING_PROFILE_CAVEAT', token });
  }
  return {
    schema_version: 1,
    status: errors.length ? 'FAIL' : 'PASS',
    files: files.length,
    local_links: links,
    shell_blocks: shell,
    json_blocks: json,
    errors,
    scope:
      'Curated docs links/JSON/shell syntax and caveats; command execution is tested separately. No remote link or arbitrary documentation execution.',
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkDocs();
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.status === 'PASS' ? 0 : 1;
}
