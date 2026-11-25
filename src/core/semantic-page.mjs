export function semanticPage(nodes, metadata) {
  return {
    schema: 'avs.semantic-page/1', revision: metadata.revision, documentId: metadata.documentId,
    url: metadata.url, title: metadata.title, text: metadata.text || '',
    text_truncated: !!metadata.text_truncated, text_total_length: metadata.text_total_length,
    dialogs: metadata.dialogs || [],
    frames: metadata.frames || [], frames_total: metadata.frames_total || 0, frames_truncated: !!metadata.frames_truncated,
    nodes: nodes.map(node => ({ id: node.id, handle: node.handle, role: node.role, name: node.name,
      section: node.sec, states: [...node.states], actions: node.actions.map(action => ({ ...action })),
      confidence: node.confidence, provenance: node.provenance, checked: node.checked, value: node.value,
      value_truncated: node.value_truncated, value_length: node.value_length,
      selectionEvidence: node.selectionEvidence ? { ...node.selectionEvidence } : undefined,
      editor: node.editor,
      editor_capability: node.editor_capability ? { ...node.editor_capability } : undefined,
      upload_capability: node.upload_capability ? { ...node.upload_capability } : undefined,
      editor_whitespace_preserved: node.editor_whitespace_preserved,
      options: node.options?.map(option => ({ ...option })), optionsTotal: node.optionsTotal })),
    limitations: ['closed_shadow_roots', 'unobserved_frames', 'cross_origin_frames', 'custom_editor_input_proxies', 'canvas_content', 'inferred_action_effects'],
  };
}

export function boundSemanticPage(page, { full = false, max = 40 } = {}) {
  const limit = full ? page.nodes.length : Math.max(1, Math.min(200, Number(max) || 40));
  const textLimit = full ? 12000 : 4000;
  const textTruncated = page.text.length > textLimit;
  const headLimit = Math.floor(textLimit * 0.65);
  return { ...page, text: textTruncated ? page.text.slice(0, headLimit) + '\n…\n' + page.text.slice(-(textLimit - headLimit - 3)) : page.text,
    execution_gate: (page.dialogs || []).some(dialog => dialog.kind === 'proctoring')
      ? { mode: 'observe_only', reason: 'proctoring_notice_visible', requires_chat_reply: false }
      : { mode: 'inspect_before_action', requires_chat_reply: false },
    text_truncated: textTruncated || !!page.text_truncated, nodes: page.nodes.slice(0, limit), total_nodes: page.nodes.length,
    interaction_nodes: page.nodes.filter(node => ['textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'button'].includes(node.role))
      .sort((first, second) => Number(first.role === 'button') - Number(second.role === 'button')).slice(0, 40),
    truncated: textTruncated || page.nodes.length > limit };
}

export function diffSemanticPages(previous, current) {
  if (!previous || previous.url !== current.url || previous.documentId !== current.documentId) return { reset: true, added: current.nodes, removed: [], changed: [], ambiguous: [] };
  const key = node => [node.role, node.name, node.section].join('\u0000');
  const group = nodes => {
    const result = new Map();
    for (const node of nodes) result.set(key(node), [...(result.get(key(node)) || []), node]);
    return result;
  };
  const before = group(previous.nodes), after = group(current.nodes);
  const added = [], removed = [], changed = [], ambiguous = [];
  for (const identity of new Set([...before.keys(), ...after.keys()])) {
    const oldNodes = before.get(identity) || [], newNodes = after.get(identity) || [];
    if (oldNodes.length > 1 || newNodes.length > 1) { ambiguous.push(identity); continue; }
    if (!oldNodes.length) added.push(newNodes[0]);
    else if (!newNodes.length) removed.push(oldNodes[0]);
    else if (oldNodes[0].checked !== newNodes[0].checked || oldNodes[0].value !== newNodes[0].value
      || JSON.stringify(oldNodes[0].selectionEvidence) !== JSON.stringify(newNodes[0].selectionEvidence)
      || JSON.stringify(oldNodes[0].states) !== JSON.stringify(newNodes[0].states)
      || JSON.stringify(oldNodes[0].options) !== JSON.stringify(newNodes[0].options)
      || oldNodes[0].optionsTotal !== newNodes[0].optionsTotal
      || JSON.stringify(oldNodes[0].actions) !== JSON.stringify(newNodes[0].actions)) changed.push({ before: oldNodes[0], after: newNodes[0] });
  }
  return { reset: false, added, removed, changed, ambiguous };
}

export function verifySemanticPage(page, expected) {
  const checks = [];
  if (expected.choices !== undefined) {
    if (!Array.isArray(expected.choices) || !expected.choices.length || expected.choices.length > 20) checks.push({ assertion: 'valid_choices', passed: false });
    else for (const choice of expected.choices) {
      if (!choice || typeof choice !== 'object' || Array.isArray(choice) || choice.choices !== undefined) checks.push({ assertion: 'valid_choice', passed: false });
      else checks.push(...verifySemanticPage(page, choice).checks);
    }
  }
  if (expected.url !== undefined) checks.push({ assertion: 'url', expected: expected.url, actual: page.url, passed: page.url === expected.url });
  if (expected.contains !== undefined) checks.push({ assertion: 'contains', expected: expected.contains, passed: page.text.includes(expected.contains) });
  if (expected.name !== undefined || expected.role !== undefined) {
    const matches = page.nodes.filter(node => (expected.name === undefined || node.name === expected.name)
      && (expected.role === undefined || node.role === expected.role));
    checks.push({ assertion: 'unique_node', expected: { name: expected.name, role: expected.role }, matches: matches.length, passed: matches.length === 1 });
    for (const property of ['checked', 'selected', 'value']) {
      if (expected[property] === undefined) continue;
      const actual = matches.length === 1 ? property === 'selected' ? matches[0].states.includes('selected') : matches[0][property] : undefined;
      checks.push({ assertion: property, expected: expected[property], actual, passed: matches.length === 1 && actual === expected[property]
        && (property !== 'value' || matches[0].value_truncated !== true),
        ...(property === 'selected' && matches.length === 1 ? { evidence: matches[0].selectionEvidence } : {}) });
    }
  } else if (['checked', 'selected', 'value'].some(property => expected[property] !== undefined)) {
    checks.push({ assertion: 'selection_requires_target', passed: false });
  }
  return { ok: checks.every(check => check.passed), status: checks.every(check => check.passed) ? 'verified' : 'assertion_failed', checks, revision: page.revision };
}
