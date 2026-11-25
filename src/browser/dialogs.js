globalThis.__avReadDialogs = function readSemanticDialogs({ nodes, map, clean, vis }) {
  return Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open],[role="alert"]'))
    .filter(vis).slice(0, 8).map(element => {
      const text = String(element.innerText || element.textContent || '').slice(0, 3000);
      return { name: clean(element.getAttribute('aria-label') || element.querySelector('h1,h2,h3,[role="heading"]')?.textContent || 'dialog'),
        text, kind: /切屏|screen.?switch|监考|proctor/i.test(text) ? 'proctoring' : 'dialog',
        controls: nodes.filter(node => map.get(node.id) && element.contains(map.get(node.id)) && node.actions.length)
          .slice(0, 12).map(node => ({ id: node.id, name: node.name, role: node.role, states: node.states, actions: node.actions })) };
    });
};
