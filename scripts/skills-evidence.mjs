// Interpret supported native protocol evidence, never final assistant prose as invocation proof.
import { records } from './cli-evidence.mjs';
export function nativeStageComplete(result) {
  return (
    result?.artifact_integrity === 'FILESYSTEM VERIFIED' &&
    result?.codex?.discovery === 'REAL CODEX VERIFIED' &&
    result?.codex?.content === 'REAL CODEX VERIFIED' &&
    result?.claude?.invocation === 'REAL CLAUDE VERIFIED' &&
    result?.claude?.telemetry_observed === true
  );
}
export function codexSkillContentEvidence(events, expected) {
  for (const event of events) {
    const item = event.item;
    if (
      event.type !== 'item.completed' ||
      item?.type !== 'mcp_tool_call' ||
      item.server !== 'agentmind' ||
      item.tool !== 'skill_get' ||
      item.status !== 'completed' ||
      item.error ||
      item.result?.isError
    )
      continue;
    for (const block of item.result?.content ?? []) {
      let r;
      try {
        r = JSON.parse(block.text);
      } catch {
        continue;
      }
      if (
        r.version?.id === expected.version_id &&
        r.version?.project_id === expected.project_id &&
        r.version?.content_hash === expected.digest &&
        r.version.files?.some(
          (file) => file.path === 'references/notes.md' && file.content.includes(expected.marker),
        )
      )
        return {
          content: 'REAL CODEX VERIFIED',
          meaning:
            'Exact approved content resolved in a fresh native Codex MCP session; native skill invocation is not attested.',
        };
    }
  }
  throw new Error('No correlated exact-version native Codex content result.');
}
export function claudeExperienceEvidence(events, saved) {
  return claudeToolResult(events, 'mcp__agentmind__experience_search', (_input, content) =>
    records(content).some(
      (r) =>
        r.id === saved.id &&
        r.project_id === saved.project_id &&
        r.problem === saved.problem &&
        r.solution === saved.solution &&
        r.source_agent === 'codex' &&
        r.approval_status === saved.approval_status &&
        r.verification_status === 'unverified',
    ),
  );
}
export function claudeToolResult(events, name, predicate = () => true) {
  const calls = new Map();
  for (const event of events)
    for (const block of event.message?.content ?? [])
      if (block.type === 'tool_use' && block.name === name) calls.set(block.id, block.input);
  for (const event of events)
    for (const block of event.message?.content ?? []) {
      if (block.type !== 'tool_result' || block.is_error || !calls.has(block.tool_use_id)) continue;
      if (predicate(calls.get(block.tool_use_id), block.content))
        return { tool: name, matched: true };
    }
  throw new Error('Missing correlated native tool-use/result evidence.');
}
export function claudeSkillEvidence(events, name, notePath, marker) {
  claudeToolResult(events, 'Skill', (input) => input?.skill === name);
  claudeToolResult(
    events,
    'Read',
    (input, content) => input?.file_path === notePath && JSON.stringify(content).includes(marker),
  );
  return {
    discovery: 'REAL CLAUDE VERIFIED',
    invocation: 'REAL CLAUDE VERIFIED',
    content: 'REAL CLAUDE VERIFIED',
  };
}
export function codexDiscoveryEvidence(result, root, name, path) {
  const row = result?.data?.find((entry) => entry.cwd === root);
  if (
    !row ||
    row.errors?.some((e) => e.path === path) ||
    !row.skills?.some(
      (skill) => skill.name === name && skill.path === path && skill.enabled === true,
    )
  )
    throw new Error('Native Codex did not recognize the exact enabled skill path.');
  return { discovery: 'REAL CODEX VERIFIED', name, path };
}
