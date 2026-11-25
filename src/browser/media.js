globalThis.__avMuteMedia = function muteMedia() {
    if (window.__avCurrentTabOnly) return;
    const kill = m => { try { m.muted = true; m.volume = 0; } catch {  } };
    const scan = root => {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('video,audio').forEach(kill);
    };
    try {
      if (!HTMLMediaElement.prototype.__avMuted) {
        const orig = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...a) {
          kill(this);
          return orig.apply(this, a);
        };
        HTMLMediaElement.prototype.__avMuted = true;
      }
    } catch {  }
    scan(document);
    try {
      if (window.__avMuteObserver) window.__avMuteObserver.disconnect();
      const obs = new MutationObserver(muts => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (/^(VIDEO|AUDIO)$/.test(n.tagName)) kill(n);
          else scan(n);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      window.__avMuteObserver = obs;
    } catch {  }
  };
