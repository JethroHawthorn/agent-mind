// Developer-only architecture/contract gate. No model, authentication or live registry access.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import ts from 'typescript';
import * as core from '../packages/core/dist/index.js';
import { createBrokerMcpServer } from '../packages/mcp-server/dist/broker-mcp.js';
import { DAILY_TOOLS } from '../packages/mcp-server/dist/codex/configuration.js';
import { outputSchemas, toolErrorSchema } from '../packages/mcp-server/dist/mcp-output.js';

export const repository = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const slash = (p) => p.replaceAll('\\', '/');
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, stable(x)]),
        )
      : v;
export const serialize = (v) => `${JSON.stringify(stable(v), null, 2)}\n`;
const sha = (v) => createHash('sha256').update(v).digest('hex');
export function cycles(edges) {
  let next = 0;
  const seen = new Map(),
    low = new Map(),
    stack = [],
    active = new Set(),
    out = [];
  const walk = (v) => {
    seen.set(v, next);
    low.set(v, next++);
    stack.push(v);
    active.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!seen.has(w)) {
        walk(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (active.has(w)) low.set(v, Math.min(low.get(v), seen.get(w)));
    }
    if (low.get(v) === seen.get(v)) {
      const group = [];
      let w;
      do {
        w = stack.pop();
        active.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1 || (edges.get(v) ?? []).includes(v)) out.push(group.sort());
    }
  };
  for (const v of edges.keys()) if (!seen.has(v)) walk(v);
  return out.sort((a, b) => a.join().localeCompare(b.join()));
}
export function analyzeSources() {
  const files = [];
  function scan(root) {
    for (const entry of readdirSync(join(repository, root), { withFileTypes: true })) {
      const p = `${root}/${entry.name}`;
      if (entry.isDirectory()) scan(p);
      else if (entry.name.endsWith('.ts')) files.push(p);
    }
  }
  for (const dir of ['packages/core/src', 'packages/mcp-server/src']) scan(dir);
  files.sort();
  const graph = new Map(files.map((p) => [p, []])),
    all = new Map(files.map((p) => [p, []])),
    imports = [],
    cli = [],
    violations = [],
    grantConsumers = [],
    dynamic = [];
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(join(repository, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const spec = node.moduleSpecifier.text;
        let target = spec.startsWith('.')
          ? slash(
              relative(
                repository,
                resolve(repository, dirname(file), spec.replace(/\.js$/, '.ts')),
              ),
            )
          : spec === '@agentmind/core'
            ? 'packages/core/src/index.ts'
            : null;
        const typeOnly =
          !!node.isTypeOnly ||
          !!node.importClause?.isTypeOnly ||
          !!(
            node.importClause &&
            !node.importClause.name &&
            node.importClause.namedBindings &&
            ts.isNamedImports(node.importClause.namedBindings) &&
            node.importClause.namedBindings.elements.length &&
            node.importClause.namedBindings.elements.every((e) => e.isTypeOnly)
          );
        if (target && !graph.has(target)) {
          violations.push({ file, rule: 'UNRESOLVED_LOCAL_IMPORT', target });
          target = null;
        }
        imports.push({ file, specifier: spec, target, type_only: typeOnly });
        if (!typeOnly && !target && !spec.startsWith('.') && !spec.startsWith('node:')) {
          const owner = file.split('/').slice(0, 2).join('/');
          const dependencies =
            JSON.parse(readFileSync(join(repository, owner, 'package.json'), 'utf8'))
              .dependencies ?? {};
          const name = spec.startsWith('@')
            ? spec.split('/').slice(0, 2).join('/')
            : spec.split('/')[0];
          if (!Object.hasOwn(dependencies, name))
            violations.push({ file, rule: 'UNDECLARED_RUNTIME_DEPENDENCY', dependency: name });
        }
        if (target) {
          all.get(file).push(target);
          if (!typeOnly) graph.get(file).push(target);
        }
        if (file.startsWith('packages/core/') && spec.startsWith('@modelcontextprotocol/'))
          violations.push({ file, rule: 'CORE_IMPORTS_TRANSPORT' });
        if (
          spec.includes('/tests/') ||
          spec.includes('/scripts/') ||
          (file.startsWith('packages/core/') && target?.startsWith('packages/mcp-server/'))
        )
          violations.push({ file, rule: 'LAYER_VIOLATION' });
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        const spec = node.argument.literal.text;
        const target = spec.startsWith('.')
          ? slash(
              relative(
                repository,
                resolve(repository, dirname(file), spec.replace(/\.js$/, '.ts')),
              ),
            )
          : null;
        if (target && all.has(target)) {
          all.get(file).push(target);
          imports.push({ file, specifier: spec, target, type_only: true });
        }
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.getText(source) === 'consumeOperatorGrant') {
          grantConsumers.push({
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            args: node.arguments.length,
          });
          if (node.arguments.length !== 3 || node.arguments[2]?.getText(source) !== 'this.db')
            violations.push({ file, rule: 'GRANT_WITHOUT_REGISTRY_BINDING' });
        }
        if (node.expression.getText(source) === 'parseArgs') {
          const arg = node.arguments[0];
          if (arg && ts.isObjectLiteralExpression(arg)) {
            const opts = arg.properties.find((p) => p.name?.getText(source) === 'options');
            if (
              opts &&
              ts.isPropertyAssignment(opts) &&
              ts.isObjectLiteralExpression(opts.initializer)
            )
              cli.push({
                file,
                options: opts.initializer.properties
                  .filter(ts.isPropertyAssignment)
                  .map((p) => ({
                    name: p.name.getText(source).replace(/^['"]|['"]$/g, ''),
                    definition: p.initializer.getText(source).replace(/\s+/g, ' '),
                  }))
                  .sort((a, b) => a.name.localeCompare(b.name)),
              });
          }
        }
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(source) === 'require'
        ) {
          if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
            violations.push({ file, rule: 'DYNAMIC_RUNTIME_IMPORT_UNKNOWN' });
          dynamic.push({
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            literal: !!node.arguments[0] && ts.isStringLiteral(node.arguments[0]),
            specifier:
              node.arguments[0] && ts.isStringLiteral(node.arguments[0])
                ? node.arguments[0].text
                : null,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return {
    schema_version: 1,
    files: files.length,
    imports,
    cli_options: cli,
    runtime_cycles: cycles(graph),
    including_type_cycles: cycles(all),
    grant_consumers: grantConsumers,
    dynamic_imports: dynamic,
    violations,
  };
}
export async function mcpContract() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'am-architecture-'))),
    home = join(root, 'home');
  // SQLite/MCP create all mutable fixtures under this private root; no provider is invoked.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(home, { mode: 0o700 });
  const client = new Client({ name: 'architecture-contract-client', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(repository, 'packages/mcp-server/dist/index.js'),
      '--project-root',
      root,
      '--db',
      join(root, 'registry.db'),
      '--enable-learning',
      '--enable-authoring',
      '--enable-curator',
      '--enable-retrieval',
    ],
    cwd: root,
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: home, LANG: 'C', TZ: 'UTC' },
  });
  transport.stderr?.on('data', () => {});
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        const { tools } = await client.listTools();
        return tools
          .map(({ name, inputSchema, outputSchema, annotations }) => ({
            name,
            inputSchema,
            outputSchema: outputSchema ?? null,
            annotations: annotations ?? {},
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('MCP_CONTRACT_TIMEOUT')), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
}
async function brokerMcpContract() {
  // Software transport contract only. Does not attest protected peer authentication.
  const server = createBrokerMcpServer({}, async () => {
    throw Error('NO_EXECUTION_IN_CONTRACT_CAPTURE');
  });
  const client = new Client({ name: 'broker-contract-capture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    return (await client.listTools()).tools
      .map(({ name, inputSchema, outputSchema, annotations }) => ({
        name,
        inputSchema,
        outputSchema: outputSchema ?? null,
        annotations: annotations ?? {},
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close();
    await server.close();
  }
}
export async function currentContract() {
  const z = createRequire(new URL('../packages/core/package.json', import.meta.url))('zod');
  const schemas = {};
  for (const [name, value] of Object.entries(core))
    if (value && typeof value === 'object' && value._zod && typeof value.parse === 'function')
      schemas[name] = z.toJSONSchema(value, { io: 'input', unrepresentable: 'any' });
  const analysis = analyzeSources();
  return {
    schema_version: 1,
    freeze: 'v1-architecture-candidate',
    release_approved: false,
    core_exports: Object.keys(core).sort(),
    runtime_manifests: ['packages/core/package.json', 'packages/mcp-server/package.json'].map(
      (path) => ({ path, manifest: JSON.parse(readFileSync(join(repository, path), 'utf8')) }),
    ),
    toolchain: (() => {
      const p = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
      return { engines: p.engines, packageManager: p.packageManager };
    })(),
    lockfile_sha256: sha(readFileSync(join(repository, 'pnpm-lock.yaml'))),
    workspace_policy_sha256: sha(readFileSync(join(repository, 'pnpm-workspace.yaml'))),
    core_input_schemas: schemas,
    mcp: await mcpContract(),
    daily_tools: [...DAILY_TOOLS].sort(),
    daily_output_contracts: Object.fromEntries(
      Object.entries(outputSchemas).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }),
      ]),
    ),
    tool_error_contract: z.toJSONSchema(toolErrorSchema, { target: 'draft-7', io: 'output' }),
    broker_mcp: await brokerMcpContract(),
    cli_options: analysis.cli_options,
    storage_schema: core.SCHEMA_VERSION,
    package_format_sources: [
      'packages/core/src/skill-model.ts',
      'packages/core/src/skill-distribution-model.ts',
      'packages/core/src/behavioral/model.ts',
    ].map((p) => ({ path: p, sha256: sha(readFileSync(join(repository, p))) })),
    release_boundaries: core.releaseBoundaryStatus(),
    broker_agent_operations: [...core.agentOperations].sort(),
    broker_agent_schema_source_sha256: sha(
      readFileSync(join(repository, 'packages/mcp-server/src/broker-mcp.ts')),
    ),
    runtime_cycles: analysis.runtime_cycles,
    runtime_dependencies: [
      ...new Set(
        analysis.imports
          .filter((i) => !i.type_only && !i.target)
          .map((i) => `${i.file.split('/')[1]}:${i.specifier}`),
      ),
    ].sort(),
    dynamic_imports: analysis.dynamic_imports.map(({ file, specifier }) => ({ file, specifier })),
  };
}
export async function checkArchitecture() {
  const analysis = analyzeSources(),
    actual = await currentContract(),
    path = join(repository, 'contracts/v1.json');
  const contract_matches =
    existsSync(path) && serialize(actual) === serialize(JSON.parse(readFileSync(path, 'utf8')));
  const forbidden = actual.mcp.filter((t) =>
    /approve|promote|rollback|deactivate|operator_|distribution_|db_|review_decide|confirm_outcome/.test(
      t.name,
    ),
  );
  return {
    schema_version: 1,
    status: contract_matches && !analysis.violations.length && !forbidden.length ? 'PASS' : 'FAIL',
    contract_matches,
    contract_sha256: sha(serialize(actual)),
    mcp_tools: actual.mcp.length,
    missing_output_schemas: actual.mcp.filter((t) => t.outputSchema === null).map((t) => t.name),
    forbidden_mcp_tools: forbidden.map((t) => t.name),
    ...analysis,
    evidence: 'STATIC_TYPESCRIPT_GRAPH_AND_DISPOSABLE_GENERIC_MCP_NOT_NATIVE_OS_OR_SANDBOX',
    release_approved: false,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { 'write-freeze': { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    });
    if (values['write-freeze']) {
      writeFileSync(join(repository, 'contracts/v1.json'), serialize(await currentContract()));
      process.stdout.write(
        'V1 contract candidate written; review required, no release authorization.\n',
      );
    } else {
      const r = await checkArchitecture();
      process.stdout.write(serialize(r));
      process.exitCode = r.status === 'PASS' ? 0 : 1;
    }
  } catch {
    process.stderr.write(
      'Architecture check failed safely. Build first; no live state or model was accessed.\n',
    );
    process.exitCode = 1;
  }
}
