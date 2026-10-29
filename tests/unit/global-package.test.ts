import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { packageCLI } from '../../scripts/package-cli.mjs';

it('packages existing compiled handlers with closed relative imports, runtime assets and an executable npm bin', () => {
  const runtime = packageCLI();
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const entry = resolve(manifest.bin.agentmind);
  expect(existsSync(entry)).toBe(true);
  expect(readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  expect(statSync(entry).mode & 0o111).toBe(0o111);
  expect(manifest.license).toBe('UNLICENSED');
  for (const lifecycle of ['install', 'postinstall', 'preinstall', 'prepare'])
    expect(manifest.scripts[lifecycle]).toBeUndefined();
  expect(JSON.stringify(manifest.dependencies)).not.toMatch(/workspace:|file:|link:/);
  expect(existsSync(join(runtime, 'skills/agentmind-router/SKILL.md'))).toBe(true);
  const walk = (directory: string) => {
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, file.name);
      if (file.isDirectory()) walk(path);
      else {
        expect(path).not.toMatch(/\.map$|\.ts$|\.db$|\.node$/);
        const text = readFileSync(path, 'utf8');
        expect(text).not.toContain(process.cwd());
        if (!path.endsWith('.js') && !path.endsWith('.mjs')) continue;
        expect(text).not.toContain('@agentmind/core');
        const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
        for (const statement of source.statements) {
          if (
            !(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ||
            !statement.moduleSpecifier ||
            !ts.isStringLiteral(statement.moduleSpecifier)
          )
            continue;
          const spec = statement.moduleSpecifier.text;
          if (spec.startsWith('.'))
            expect(existsSync(resolve(dirname(path), spec)), `${path}: ${spec}`).toBe(true);
          else if (!spec.startsWith('node:')) {
            const owner = spec.startsWith('@')
              ? spec.split('/').slice(0, 2).join('/')
              : spec.split('/')[0];
            expect(Object.keys(manifest.dependencies)).toContain(owner);
          }
        }
      }
    }
  };
  walk(runtime);
});
