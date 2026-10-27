import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { firstCompatible, installedSdks } from './lib/peer-build.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: true,
  options: { sdk: { type: 'string' }, help: { type: 'boolean' } },
});
if (values.help) {
  console.log(
    'Usage: pnpm build:peer [ABSOLUTE_SDK | --sdk PATH]\nDefault: probe selected SDK then up to five installed SDKs; compile and run native credential/descriptor selftests before atomic publication. Explicit SDK disables fallback. macOS only.',
  );
} else {
  try {
    if (process.platform !== 'darwin') throw Error('PROTECTED_PLATFORM_UNSUPPORTED');
    if (positionals.length > 1 || (values.sdk && positionals.length))
      throw Error('INVALID_ARGUMENTS');
    const query = (args) => {
      const r = spawnSync('/usr/bin/xcrun', args, {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 8192,
      });
      if (r.status !== 0) throw Error('XCRUN_UNAVAILABLE');
      return r.stdout.trim();
    };
    const compiler = realpathSync(query(['--find', 'clang']));
    const explicit = values.sdk ?? positionals[0];
    const sdks = explicit
      ? [realpathSync(resolve(explicit))]
      : installedSdks(realpathSync(query(['--sdk', 'macosx', '--show-sdk-path'])), [
          dirname(realpathSync(query(['--sdk', 'macosx', '--show-sdk-path']))),
          '/Library/Developer/CommandLineTools/SDKs',
        ]);
    const output = resolve('native/bin/agentmind-peer');
    mkdirSync(dirname(output), { recursive: true });
    const temp = mkdtempSync(join(dirname(output), '.peer-build-'));
    const executable = join(temp, 'agentmind-peer');
    const attempts = [];
    try {
      const selected = firstCompatible(sdks, (sdk) => {
        const r = spawnSync(
          compiler,
          [
            '-std=c11',
            '-O2',
            '-Wall',
            '-Wextra',
            '-Werror',
            '-isysroot',
            sdk,
            'native/peer.c',
            '-o',
            executable,
          ],
          { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 },
        );
        if (r.status !== 0) {
          attempts.push({
            sdk,
            status: r.error?.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'COMPILE_FAILED',
          });
          return false;
        }
        for (const check of ['selftest', 'selftest-invalid', 'selftest-fds']) {
          if (
            spawnSync(executable, [check], {
              env: {},
              encoding: 'utf8',
              timeout: 3000,
              maxBuffer: 8192,
            }).status !== 0
          ) {
            attempts.push({ sdk, status: 'SELFTEST_FAILED' });
            return false;
          }
        }
        attempts.push({ sdk, status: 'COMPILE_AND_PRIMITIVES_PASS' });
        return true;
      });
      if (!selected) throw Error('NO_COMPATIBLE_INSTALLED_SDK; existing helper retained');
      renameSync(executable, output);
      console.log(
        JSON.stringify({
          schema_version: 1,
          compiler,
          selected_sdk: selected,
          explicit_sdk: !!explicit,
          attempts,
          artifact_updated: true,
          os_deployment: 'NOT_VERIFIED',
        }),
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  } catch (error) {
    const reason = [
      'PROTECTED_PLATFORM_UNSUPPORTED',
      'INVALID_ARGUMENTS',
      'XCRUN_UNAVAILABLE',
      'NO_COMPATIBLE_INSTALLED_SDK; existing helper retained',
    ].includes(error.message)
      ? error.message
      : 'BUILD_INPUT_OR_TOOLCHAIN_UNAVAILABLE; existing helper retained';
    console.error(`PEER_BUILD_FAILED: ${reason}`);
    process.exitCode = 1;
  }
}
