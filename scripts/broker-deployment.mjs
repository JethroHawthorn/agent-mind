// Read-only plan/render tool. Never invokes sudo, launchctl, chown, account creation or SQLite.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { validateBrokerConfig } from '../packages/core/dist/index.js';

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    'broker-user': { type: 'string' },
    plist: { type: 'boolean' },
  },
  strict: true,
  allowPositionals: false,
});
if (
  !values.config ||
  !values['broker-user'] ||
  !/^[a-z_][a-z0-9_-]{0,62}$/i.test(values['broker-user'])
)
  throw new Error('Provide config and administrator-reviewed broker-user.');
const c = validateBrokerConfig(JSON.parse(readFileSync(values.config, 'utf8')));
const node = `${c.runtime_root}/bin/node`;
const entry = `${c.runtime_root}/packages/mcp-server/dist/broker.js`;
const escaped = (s) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const args = ['/usr/bin/env', '-i', node, entry, '--config', values.config];
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>local.agentmind.broker</string>
<key>UserName</key><string>${escaped(values['broker-user'])}</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${escaped(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${escaped(c.runtime_root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
if (values.plist) process.stdout.write(plist);
else
  console.log(
    JSON.stringify({
      status: 'PLAN ONLY',
      deployed: false,
      os_isolation: 'NOT VERIFIED',
      changes_performed: false,
      required_uid: c.broker_uid,
      required_operator_gid: c.operator_gid,
      preflight_command: [node, entry, '--config', values.config, '--preflight'],
      service_definition:
        'Render with --plist; administrator must verify broker-user matches broker_uid before installation.',
      steps: [
        'Provision and independently verify distinct accounts/groups without delegated agent privilege.',
        'Install a reviewed self-contained root-owned runtime, including Node and native helper.',
        'Stop supervised writers; backup via SQLite backup API, verify checksum/integrity/FKs, copy into broker-private storage.',
        'Provision 0700 broker registry, 0711 socket directory and per-project 0750 broker-owned publication roots/groups.',
        'Install root-owned broker/client configuration; preserve validated legacy scope IDs.',
        'Run read-only preflight with the installed Node; it never migrates or binds sockets.',
        'Render and plutil-lint the LaunchDaemon; administrator installs and bootstraps it explicitly.',
        'Run actual separate-identity disposable OS acceptance before declaring deployment verified.',
      ],
    }),
  );
