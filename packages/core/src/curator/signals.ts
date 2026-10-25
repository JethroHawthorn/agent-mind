import type { EventEvidence, SkillEvidence } from './data.js';
export function extractCuratorSignals(skill: SkillEvidence, events: EventEvidence[], asOf: string) {
  const sessions = new Map<string, Set<string>>();
  for (const e of events)
    if (e.skill_id === skill.skill_id && e.session_id) {
      const set = sessions.get(e.session_id) ?? new Set<string>();
      set.add(e.version_id);
      sessions.set(e.session_id, set);
    }
  const uncertain = new Set(
    [...sessions].filter(([, versions]) => versions.size > 1).map(([session]) => session),
  );
  const sampled = [
    ...new Map(
      events.filter((e) => e.version_id === skill.version_id).map((e) => [e.event_id, e]),
    ).values(),
  ].slice(0, 24);
  const failures = sampled.filter((e) => e.event_type === 'task_failed');
  const attested = failures.filter(
    (e) =>
      e.category === 'operator_confirmed' &&
      e.verification === 'operator_confirmed' &&
      e.method === 'local-tty-outcome-v1' &&
      e.operator_authorized,
  );
  const reported = failures.filter((e) => !attested.includes(e));
  const distinct = (rows: EventEvidence[]) =>
    new Set(rows.flatMap((e) => (e.task_id ? [e.task_id] : []))).size;
  const outcomes = new Map<string, Set<string>>();
  for (const e of sampled)
    if (e.task_id && e.event_type.startsWith('task_')) {
      const set = outcomes.get(e.task_id) ?? new Set<string>();
      set.add(e.event_type);
      outcomes.set(e.task_id, set);
    }
  const conflicting = [...outcomes.values()].some(
    (s) => s.has('task_succeeded') && s.has('task_failed'),
  );
  const observed = sampled.filter(
    (e) =>
      e.source_cli === 'claude' &&
      e.category === 'native_hook' &&
      e.verification === 'observed' &&
      e.method === 'claude-skill-tool-v1' &&
      e.event_type === 'invoked' &&
      e.session_id &&
      !uncertain.has(e.session_id),
  );
  const recentSuccess = sampled.some(
    (e) =>
      e.event_type === 'task_succeeded' &&
      e.category === 'operator_confirmed' &&
      e.verification === 'operator_confirmed' &&
      e.operator_authorized &&
      Date.parse(asOf) - Date.parse(e.received_at) <= 30 * 86400000,
  );
  return {
    sampled,
    failures,
    attested,
    reported,
    attested_tasks: distinct(attested),
    reported_tasks: distinct(reported),
    independent_failure_tasks: distinct(failures),
    unknown: sampled.filter((e) => e.event_type === 'task_unknown'),
    conflicting,
    observed_sessions: new Set(observed.map((e) => e.session_id)).size,
    uncertain_version: sampled.some((e) => e.session_id && uncertain.has(e.session_id)),
    recentSuccess,
    evaluation_gap:
      skill.evaluation_result !== 'PASS' ||
      skill.evaluation_policy?.startsWith('static-contract') === true,
  };
}
