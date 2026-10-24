// Interpret native CLI tool events. Final assistant prose is never proof.
export function records(value) {
  if (typeof value === 'string') {
    try {
      return records(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(records);
  if (!value || typeof value !== 'object') return [];
  if (typeof value.id === 'string' && typeof value.content === 'string' && value.project_id)
    return [value];
  return Object.values(value).flatMap(records);
}

export function savedByCodex(events, marker) {
  for (const event of events) {
    const item = event.item;
    if (
      event.type !== 'item.completed' ||
      item?.type !== 'mcp_tool_call' ||
      item.server !== 'agentmind' ||
      item.tool !== 'memory_save' ||
      item.status !== 'completed' ||
      item.error ||
      item.result?.isError
    )
      continue;
    const memory = records(item.result).find(
      (memory) => memory.content.includes(marker) && memory.source_agent === 'codex',
    );
    if (memory) return memory;
  }
  throw new Error('Codex did not provide a successful memory_save tool result.');
}

export function retrievedByClaude(events, saved) {
  const calls = new Set(
    events.flatMap((event) =>
      (event.message?.content ?? [])
        .filter(
          (block) => block.type === 'tool_use' && block.name === 'mcp__agentmind__memory_search',
        )
        .map((block) => block.id),
    ),
  );
  for (const event of events) {
    for (const block of event.message?.content ?? []) {
      if (block.type !== 'tool_result' || block.is_error || !calls.has(block.tool_use_id)) continue;
      if (
        records(block.content).some(
          (memory) =>
            memory.id === saved.id &&
            memory.content === saved.content &&
            memory.source_agent === 'codex',
        )
      )
        return;
    }
  }
  throw new Error('Claude did not provide a matching memory_search tool result.');
}
