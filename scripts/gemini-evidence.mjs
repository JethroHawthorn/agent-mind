// Only documented Gemini stream-json fields are recognized. No persistence or lifecycle effects.
// Schema source: google-gemini/gemini-cli packages/core/src/output/types.ts.
export function geminiCompleted(result) {
  if (!Array.isArray(result?.events)) return false;
  const final = result.events.filter((e) => e.type === 'result');
  return (
    result.exit_code === 0 &&
    !result.failure &&
    final.length === 1 &&
    final[0].status === 'success' &&
    !final[0].error &&
    !result.events.some((e) => e.type === 'error' && e.severity !== 'warning')
  );
}
export function geminiToolEvidence(result, name, predicate) {
  if (!geminiCompleted(result)) return false;
  const ids = new Set(),
    results = new Set();
  for (const event of result.events) {
    if (event.type === 'tool_use' && typeof event.tool_id === 'string') {
      if (ids.has(event.tool_id)) return false;
      ids.add(event.tool_id);
    }
    if (event.type === 'tool_result' && typeof event.tool_id === 'string') {
      if (results.has(event.tool_id) || !ids.has(event.tool_id)) return false;
      results.add(event.tool_id);
    }
  }
  const calls = new Map();
  for (const event of result.events) {
    if (
      event.type === 'tool_use' &&
      event.tool_name === name &&
      typeof event.tool_id === 'string'
    ) {
      if (calls.has(event.tool_id)) return false; // Ambiguous/replayed correlation is not proof.
      calls.set(event.tool_id, event.parameters);
    }
    if (
      event.type !== 'tool_result' ||
      !calls.has(event.tool_id) ||
      event.status !== 'success' ||
      event.error
    )
      continue;
    let output;
    try {
      output = JSON.parse(event.output);
    } catch {
      continue;
    }
    if (output?.isError === true) continue;
    const objects = [];
    function decode(value, depth = 0) {
      if (depth > 5 || !value) return;
      if (typeof value === 'string') {
        try {
          decode(JSON.parse(value), depth + 1);
        } catch {}
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 100)) decode(item, depth + 1);
        return;
      }
      if (typeof value === 'object') {
        if (value.isError === true) return;
        objects.push(value);
        for (const key of ['content', 'text', 'memories', 'experiences', 'skills'])
          decode(value[key], depth + 1);
      }
    }
    decode(output);
    if (predicate(calls.get(event.tool_id), objects)) return true;
  }
  return false;
}
