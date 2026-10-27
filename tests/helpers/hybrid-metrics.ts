export function qualityMetrics(
  cases: {
    relevant: string[];
    names: string[];
    bytes: number;
    latency_ms: number;
    outcome: string;
  }[],
) {
  const positives = cases.filter((c) => c.relevant.length),
    negatives = cases.filter((c) => !c.relevant.length);
  const labels = positives.reduce((n, c) => n + c.relevant.length, 0);
  const recall = (k: number) =>
    positives.reduce(
      (n, c) => n + c.names.slice(0, k).filter((x) => c.relevant.includes(x)).length,
      0,
    ) / labels;
  const single = cases.filter((c) => c.outcome === 'RECOMMEND_ONE');
  const lat = cases.map((c) => c.latency_ms).sort((a, b) => a - b);
  return {
    queries: cases.length,
    positive_queries: positives.length,
    relevant_labels: labels,
    recall_at_1: recall(1),
    recall_at_5: recall(5),
    recall_at_10: recall(10),
    mrr:
      positives.reduce((n, c) => {
        const i = c.names.findIndex((x) => c.relevant.includes(x));
        return n + (i < 0 ? 0 : 1 / (i + 1));
      }, 0) / positives.length,
    no_match_correct: negatives.filter((c) => c.names.length === 0).length,
    no_match_total: negatives.length,
    no_match_accuracy: negatives.filter((c) => c.names.length === 0).length / negatives.length,
    wrong_single_recommendations: single.filter((c) => !c.relevant.includes(c.names[0] ?? ''))
      .length,
    single_recommendations: single.length,
    wrong_single_rate: single.length
      ? single.filter((c) => !c.relevant.includes(c.names[0] ?? '')).length / single.length
      : null,
    average_response_bytes: cases.reduce((n, c) => n + c.bytes, 0) / cases.length,
    estimated_tokens_bytes_div_4: cases.reduce((n, c) => n + c.bytes / 4, 0) / cases.length,
    tool_calls: cases.length,
    p50_ms: lat[Math.floor(lat.length * 0.5)],
    p95_ms: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))],
  };
}
