import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AgentMindError } from './errors.js';
import type { ProjectScope } from './project.js';
import { resolveProject } from './project.js';
import { inspectPackage, matchesRecord } from './skill-distribution-files.js';
import type { InstallationRecord } from './skill-distribution-model.js';
import { skillNameSchema } from './skill-model.js';
import { SkillStore } from './skill-store.js';
import { SkillUsageService, usageObservationId } from './skill-usage.js';

export const usageCapabilities = Object.freeze({
  codex: {
    adapter: 'explicit-mcp-v1',
    native_skill_invocation: false,
    reason:
      'No documented dedicated skill invocation hook is assumed. Generic tool/Stop events do not prove skill invocation.',
  },
  claude: {
    adapter: 'claude-skill-tool-v1',
    events: ['PreToolUse', 'PostToolUse'],
    tool: 'Skill',
    direct_slash_command: false,
    reason:
      'Direct slash expansion bypasses Skill tool hooks. Expansion payload lacks a stable invocation ID; it is not deduplicated into invented invocations.',
  },
});
// Deliberately strips extra fields, including transcript_path, prompt, args, responses and permission flags.
const claudeHookSchema = z.object({
  hook_event_name: z.enum(['PreToolUse', 'PostToolUse']),
  session_id: z.string().min(1).max(200),
  cwd: z.string().min(1).max(4096),
  tool_use_id: z.string().min(1).max(200),
  tool_name: z.literal('Skill'),
  tool_input: z.object({ skill: skillNameSchema }),
});
export function collectClaudeUsage(
  db: Database.Database,
  scope: ProjectScope,
  installationId: unknown,
  payload: unknown,
  enabled = true,
) {
  if (!enabled) return { stored: false, disabled: true };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 65536)
    throw new AgentMindError('INVALID_HOOK_INPUT', 'Hook payload exceeds the local byte limit.');
  const p = claudeHookSchema.safeParse(payload);
  const id = z.uuid().safeParse(installationId);
  if (!p.success || !id.success) return { stored: false, unsupported: true };
  // Validate cwd against the configured root without trusting the payload to select a project ID/key.
  resolveProject(scope.root, p.data.cwd);
  const row = db
    .prepare(
      `SELECT * FROM skill_installations WHERE id=? AND project_id=? AND target='claude' AND status='installed'`,
    )
    .get(id.data, scope.id) as InstallationRecord | undefined;
  if (!row || !matchesRecord(inspectPackage(row.destination), row))
    throw new AgentMindError(
      'USAGE_INSTALLATION_MISMATCH',
      'Hook does not match an intact managed Claude installation.',
    );
  const skill = new SkillStore(db, scope).getIdentity(row.skill_id);
  if (skill.name !== p.data.tool_input.skill) return { stored: false, unrelated: true };
  return new SkillUsageService(db, scope, 'claude', enabled).observeHook({
    schema_version: 1,
    event_id: usageObservationId(
      `claude:${scope.id}:${id.data}:${p.data.session_id}:${p.data.tool_use_id}:${p.data.hook_event_name}`,
    ),
    version_id: row.version_id,
    artifact_digest: row.installed_digest,
    installation_id: id.data,
    session_id: p.data.session_id,
    event_type: p.data.hook_event_name === 'PreToolUse' ? 'invoked' : 'executed',
  });
}
