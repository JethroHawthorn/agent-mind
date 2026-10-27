import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROVIDERS, type Provider } from '../../packages/mcp-server/src/installer/model.js';
import { UnifiedInstaller } from '../../packages/mcp-server/src/installer/service.js';
/** Public CLI contract doubles only. Real MCP/storage code is exercised separately. */
export function installerFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-unified- 空间 '))),
    home = join(root, 'fake-home');
  mkdirSync(home);
  const executables = {} as Record<Provider, string>;
  for (const id of PROVIDERS) {
    const path = join(root, `fake-${id}.cjs`);
    writeFileSync(
      path,
      `#!${process.execPath}\nconst fs=require('fs'),p=require('path'),a=process.argv.slice(2),id=${JSON.stringify(id)};\nif(a.includes('--version')){console.log(id==='codex'?'codex-cli 0.163.0':'2.1.310');process.exit(0);}\nif(a.includes('--help')){console.log('--json --scope --strict-mcp-config --no-session-persistence add list --output-format --prompt --approval-mode plan --allowed-mcp-server-names');process.exit(0);}\nif(id==='claude'){
 const file=p.join(process.env.HOME,'fixture-user-mcp.json');let store={};try{store=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
 if(a[1]==='get'&&store[a[2]]){const e=store[a[2]];console.log('Scope: User config\\n  Command: '+e.command+'\\n  Args: '+e.args.join(' ')+'\\n');process.exit(0);}
 if(a[1]==='add-json'){store[a[4]]=JSON.parse(a[5]);fs.writeFileSync(file,JSON.stringify(store),{mode:0o600});process.exit(0);}
 if(a[1]==='remove'){delete store[a[4]];fs.writeFileSync(file,JSON.stringify(store));process.exit(0);}
}
if(id==='codex'){let text='';try{text=fs.readFileSync(p.join(process.env.CODEX_HOME,'config.toml'),'utf8');}catch{};const rows=[];for(const b of text.split(/(?=^\\[)/m)){const m=b.match(/^\\[mcp_servers\\.([^\\]]+)\\]/);if(!m)continue;const v={};for(const l of b.split('\\n').slice(1)){const kv=l.match(/^([a-z_]+) *= *(.*)/);if(kv)try{v[kv[1]]=JSON.parse(kv[2]);}catch{}};rows.push({name:m[1],enabled_tools:v.enabled_tools,transport:{command:v.command,args:v.args,cwd:null}});}if(a[1]==='list'){console.log(JSON.stringify(rows));process.exit(0);}if(a[1]==='get'){const r=rows.find(x=>x.name===a[2]);if(r){console.log(JSON.stringify(r));process.exit(0);}}}\nconsole.error('No MCP server named "'+a[2]+'"');process.exit(1);\n`,
      { mode: 0o700 },
    );
    chmodSync(path, 0o700);
    executables[id] = path;
  }
  const options = {
    root,
    home,
    database: join(root, 'registry.db'),
    router: readFileSync('skills/agentmind-router/SKILL.md', 'utf8'),
    adapters: Object.fromEntries(
      PROVIDERS.map((id) => [id, resolve(`packages/mcp-server/dist/${id}/adapter.js`)]),
    ) as Record<Provider, string>,
    executables,
    systemDefaults: join(home, 'system-defaults.json'),
    systemSettings: join(home, 'system-settings.json'),
  };
  return {
    root,
    home,
    options,
    service: new UnifiedInstaller(options),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
