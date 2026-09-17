/** Match only newly observed, complete persisted items in the explicitly bound task. */
export function confirmDelegatedDelivery({page, threadId, sourceThreadId, prompt, baselineTurnIds}) {
  if (page?.thread?.id !== threadId) return {status:'delivery_unknown', reason:'target_mismatch'};
  if (!Array.isArray(baselineTurnIds) || !Array.isArray(page.turns)) return {status:'delivery_unknown', reason:'missing_baseline_or_turns'};
  const baseline = new Set(baselineTurnIds);
  const expected = `<codex_delegation>\n  <source_thread_id>${sourceThreadId}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`;
  const matches = [];
  for (const turn of page.turns) {
    if (typeof turn.id !== 'string' || baseline.has(turn.id)) continue;
    for (const item of turn.items ?? []) {
      if (item.type !== 'functionCallOutput' || item.namespace !== 'codex_app' || item.name !== 'send_message_to_thread') continue;
      if (item.output?.truncated !== false || item.output.text !== expected) continue;
      matches.push({turnId:turn.id, itemId:item.id});
    }
  }
  if (matches.length !== 1) return {status:'delivery_unknown', reason:matches.length > 1 ? 'ambiguous_matches' : 'no_complete_new_match'};
  return {status:'delivered', ...matches[0], evidence:'persisted_delegation_exact_text'};
}
