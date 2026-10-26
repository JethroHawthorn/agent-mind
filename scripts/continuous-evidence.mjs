// Only completed native MCP tool results count; model prose is never tool evidence.
export function continuousToolEvidence(result) {
  if (result.exit_code !== 0 || result.failure) return [];
  const tools = new Set([
    'experience_record',
    'learning_signal_record',
    'skill_authoring_context',
    'skill_authoring_submit',
    'skill_discover',
    'skill_load',
    'skill_resource_get',
  ]);
  return result.events
    .flatMap((event) => {
      const item = event?.item;
      if (
        event?.type !== 'item.completed' ||
        item?.type !== 'mcp_tool_call' ||
        item.server !== 'agentmind' ||
        item.status !== 'completed' ||
        item.error ||
        item.result?.isError ||
        !tools.has(item.tool)
      )
        return [];
      const blocks = item.result?.content;
      if (!Array.isArray(blocks)) return [];
      for (const block of blocks) {
        if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 65536)
          continue;
        try {
          const data = JSON.parse(block.text);
          if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) continue;
          // IDs are references only. Callers must re-resolve them in the scoped registry.
          return [
            {
              tool: item.tool,
              id: data.experience?.id ?? data.signal?.id ?? data.id ?? data.proposal_id ?? null,
            },
          ];
        } catch {
          /* Unsupported content is not observed evidence. */
        }
      }
      return [];
    })
    .slice(0, 100);
}
