(() => {
  if (typeof globalThis.__avCompilePage !== 'function') throw new Error('Load the AgentViews browser source through src/browser/source.mjs');
  const previous = window.__av && window.__av.snapshot;
  window.__avDocumentId = window.__avDocumentId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
  if (window.__av && typeof window.__av.dispose === 'function') window.__av.dispose();
  window.__avRevision = (window.__avRevision || 0) + 1;
  window.__avGuardHit = null;
  window.__avGuardKey = null;
  window.__avGuardText = null;
  window.__avLastHit = null;
  globalThis.__avMuteMedia();
  const stats = globalThis.__avCompilePage();
  const pageText = window.__av.pageText();
  window.__av.snapshot = window.__avSemanticPage(window.__av.nodes, { revision: window.__avRevision, documentId: window.__avDocumentId,
    url: location.href, title: document.title, dialogs: window.__av.dialogs,
    frames: window.__av.frames, frames_total: window.__av.frames_total, frames_truncated: window.__av.frames_truncated,
    text: pageText.slice(0, 12000), text_truncated: pageText.length > 12000, text_total_length: pageText.length });
  window.__av.diff = window.__avDiffPages(previous, window.__av.snapshot);
  return stats;
})();
