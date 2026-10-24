import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

try {
  const { values } = parseArgs({
    options: {
      client: { type: 'string' },
      'project-root': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (
    !['codex', 'claude'].includes(values.client) ||
    !values['project-root'] ||
    !isAbsolute(values['project-root'])
  ) {
    throw new Error('Use --client codex|claude --project-root /absolute/project.');
  }
  const project = realpathSync(values['project-root']);
  if (!statSync(project).isDirectory()) throw new Error('Project must be a directory.');
  const target = join(
    project,
    values.client === 'codex' ? '.agents' : '.claude',
    'skills',
    'reflect',
  );
  if (existsSync(target))
    throw new Error('A reflect skill already exists; inspect it before installing.');
  let ancestor = dirname(target);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const rel = relative(project, realpathSync(ancestor));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Skill directory points outside the project.');
  mkdirSync(dirname(target), { recursive: true });
  cpSync(fileURLToPath(new URL('../skills/reflect', import.meta.url)), target, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  if (values.client === 'claude') {
    const file = join(target, 'SKILL.md');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(/^---\n/, '---\ndisable-model-invocation: true\n'),
    );
  }
  console.log(`Installed explicit-invocation reflect skill for ${values.client}; restart the CLI.`);
} catch (error) {
  // Only controlled setup errors are useful; filesystem diagnostics can contain private paths.
  const known = ['Use --client', 'Project must', 'A reflect', 'Skill directory'];
  console.error(
    known.some((prefix) => error.message.startsWith(prefix))
      ? error.message
      : 'Skill installation failed; check project directory permissions.',
  );
  process.exitCode = 1;
}
