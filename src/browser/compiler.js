globalThis.__avCompilePage = function compileSemanticPage() {
  const { clean, safeText, recovery, hidden, sized, vis, hitTest, editorCapability, editorValue, labelControl, roleOf, labelNameOf, nameOf, cls, effectsOf, preconditionsOf, fallbackName, uploadDropTarget, uploadCapability } = globalThis.__avCreateDOM();
  const nodes = [], map = new Map(), frames = [];
  let framesTotal = 0;
  const practiceTask = ['practice', 'coding'].includes(window.__avPracticeKind);
  const codingTask = window.__avPracticeKind === 'coding';
  let seq = 0;
  const drop = { r1_nested_clickable: 0, r2_empty_name: 0, r3_hidden: 0, r4_text_not_actionable: 0, r5_zero_size_wrapper: 0, r6_label_name_carrier: 0 };

  const TEXT_MIN = 24, TEXT_MAX = 140, TEXT_BUDGET = 2600;
  const TEXT_TAGS = ["P", "LI", "BLOCKQUOTE", "PRE", "TD", "DD", "DT", "FIGCAPTION", "SUMMARY", "H1", "H2", "H3", "H4"];
  let textChars = 0, textBlocks = 0;

  const TEXT_PER_SEC = 3;
  const tsecCount = {};

  const kids = el => {
    const out = [...el.children];
    if (el.shadowRoot) out.push(...el.shadowRoot.children);
    return out;
  };

  let maxDepth = 0;
  const walk = (el, depth, sec, insideClickable) => {
    if (depth > maxDepth) maxDepth = depth;
    if (depth > 48) return;
    if (el.tagName === 'IFRAME') {
      framesTotal++;
      if (frames.length < 20) {
        let origin = null, sameOrigin = null;
        const sourceKind = el.hasAttribute('srcdoc') ? 'srcdoc' : el.getAttribute('src') ? 'url' : 'blank';
        try {
          const parent = new URL(location.href);
          const source = new URL(sourceKind === 'url' ? el.getAttribute('src') : location.href, parent);
          origin = source.origin;
          if (el.hasAttribute('sandbox') && !String(el.getAttribute('sandbox')).split(/\s+/).includes('allow-same-origin')) origin = 'null';
          sameOrigin = origin !== 'null' && origin === parent.origin;
        } catch {}
        frames.push({ index: framesTotal, name: clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('name') || 'iframe'),
          source_kind: sourceKind, origin, same_origin: sameOrigin, visible: vis(el),
          observation_complete: false, actions_supported: false, reason: 'frame_context_not_observed' });
      }
      return;
    }
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH'].includes(el.tagName)) return;
    if (hidden(el)) { drop.r3_hidden++; return; }
    const sizedEl = sized(el);

    const associated = labelControl(el);
    const control = associated && associated.tagName === 'INPUT' && /^(checkbox|radio|file)$/.test(associated.type)
      && !vis(associated) ? associated : el;
    const role = roleOf(control), st = getComputedStyle(el);
    const isForm = ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'fileinput'].includes(role);
    const clickable = role === 'button' || role === 'link' || role === 'tab'
      || st.cursor === 'pointer' || !!el.closest('a[href]');

    if (insideClickable && !isForm) { drop.r1_nested_clickable++; return; }

    if (el.tagName === 'LABEL') {
      if (associated && control === el) { drop.r6_label_name_carrier++; for (const c of kids(el)) walk(c, depth + 1, sec, insideClickable); return; }
    }

    let name = nameOf(control), synth = false;
    if (!name && clickable) {
      name = fallbackName(el) || ('⟨' + (role || 'clickable') + '⟩');
      synth = true;
    }

    if (!name && !isForm) { drop.r2_empty_name++; }
    else if ((clickable || role === 'heading' || isForm) && !sizedEl) {

      drop.r5_zero_size_wrapper++;
    }
    else if (clickable || role === 'heading' || isForm) {
      const id = 'd' + window.__avDocumentId + ':r' + window.__avRevision + ':n' + (++seq);
      const r = el.getBoundingClientRect();
      const inferred = clickable && !['button', 'link', 'tab', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio'].includes(role);
      const ef = effectsOf(control);
      const classSelected = ['checkbox', 'radio'].includes(role) && /(?:^|[\s_-])(?:checked|selected)(?:$|[\s_-])/.test(el.className || '');
      const editor = editorCapability(el);
      const codeValue = codingTask && editor?.supported
        && window.__avAssessAction({ ...window.__avInspectElement(el, 'set_value', name), effects: ['field.value'] }).ok ? editorValue(el) : undefined;

      nodes.push({
        id, role: role || (inferred ? 'clickable' : 'text'), name,

        handle: (role || (inferred ? 'clickable' : 'text')) + ':' + name.slice(0, 40),
        states: [
          /(^|\s)(selected|active|checked|current)(\s|$)/.test(el.className || '') && 'selected',
          classSelected && 'selected',
          control.disabled && 'disabled',
          control.readOnly && 'readonly',
          el.getAttribute('aria-expanded') === 'true' && 'expanded',
          el.getAttribute('aria-expanded') === 'false' && 'collapsed',
          (control.checked || control.getAttribute('aria-checked') === 'true') && 'checked',
          (el.selected || el.getAttribute('aria-selected') === 'true') && 'selected',
          (r.top < innerHeight && r.bottom > 0) ? 'onscreen' : 'offscreen'
        ].filter(Boolean),
        checked: ['checkbox', 'radio'].includes(role) ? !!control.checked : undefined,
        selectionEvidence: ['checkbox', 'radio'].includes(role) ? { nativeChecked: !!control.checked,
          ariaChecked: control.getAttribute('aria-checked'), classSelected, classSource: 'dom-heuristic' } : undefined,
        value: el.tagName === 'SELECT' ? el.value : codeValue?.slice(0, 50000),
        value_truncated: codeValue !== undefined ? codeValue.length > 50000 : undefined,
        value_length: codeValue?.length,
        editor: editor?.supported ? editor.driver : undefined,
        editor_capability: editor || undefined,
        upload_capability: uploadCapability(control) || undefined,
        editor_whitespace_preserved: el.isContentEditable ? ['pre', 'pre-wrap', 'break-spaces'].includes(st.whiteSpace) : undefined,
        options: el.tagName === 'SELECT' ? Array.from(el.options || []).slice(0, 80).map(option => ({
          name: clean(option.text), value: option.value, disabled: !!option.disabled, selected: !!option.selected
        })) : undefined,
        optionsTotal: el.tagName === 'SELECT' ? (el.options || []).length : undefined,
        actions: role === 'heading' && !clickable ? [] : [{
          verb: role === 'fileinput' ? 'upload_files' : isForm ? (['textbox', 'searchbox'].includes(role) ? 'set_value' : role === 'combobox' ? 'select' : 'set_checked') : 'click',
          params: role === 'fileinput' ? { files: 'absolute_paths', drop: 'boolean' } : isForm ? { [['textbox', 'searchbox'].includes(role) ? 'text' : role === 'combobox' ? 'option' : 'checked']: 'value' } : {},
          effects: ef.effects,
          reversible: ef.reversible,
          preconditions: [...new Set([...preconditionsOf(control), ...preconditionsOf(el)])]
        }],
        sec, bounds: [Math.round(r.x), Math.round(r.y)],
        provenance: synth ? 'dom-structural' : (role ? 'dom-aria' : (inferred ? 'dom-heuristic' : 'dom-text')),
        confidence: synth ? 0.4 : (role ? 0.95 : (inferred ? 0.6 : 0.8))
      });
      map.set(id, el);

      const childSec = (el.className && typeof el.className === 'string' && el.className.trim())
        ? el.className.trim().split(/\s+/)[0].slice(0, 20) : sec;
      for (const c of kids(el)) walk(c, depth + 1, childSec, !!clickable);
      return;
    } else if (sizedEl && textChars < TEXT_BUDGET && (tsecCount[sec] || 0) < TEXT_PER_SEC && (

      (TEXT_TAGS.includes(el.tagName) && !el.querySelector(TEXT_TAGS.join(",") + ",button,[role=button]"))
      || (el.children.length === 0 && (el.textContent || "").trim().length >= TEXT_MIN)
    )) {
      const raw = clean(el.textContent);
      if (raw.length < TEXT_MIN) { drop.r4_text_not_actionable++; }
      else {
        const id = 'd' + window.__avDocumentId + ':r' + window.__avRevision + ':n' + (++seq);
        const r = el.getBoundingClientRect();
        const txt = raw.slice(0, TEXT_MAX) + (raw.length > TEXT_MAX ? '…' : '');
        textChars += txt.length; textBlocks++;
        tsecCount[sec] = (tsecCount[sec] || 0) + 1;
        nodes.push({
          id, role: 'text', name: txt, handle: 'text:' + raw.slice(0, 40),
          states: [(r.top < innerHeight && r.bottom > 0) ? 'onscreen' : 'offscreen'].filter(Boolean),
          actions: [], sec, bounds: [Math.round(r.x), Math.round(r.y)],
          provenance: 'dom-text', confidence: 0.8
        });
        map.set(id, el);
        for (const child of kids(el)) walk(child, depth + 1, sec, insideClickable);
        return;
      }
    } else { drop.r4_text_not_actionable++; }

    const childSec = (el.className && typeof el.className === 'string' && el.className.trim())
      ? el.className.trim().split(/\s+/)[0].slice(0, 20) : sec;
    for (const c of kids(el)) walk(c, depth + 1, childSec, insideClickable);
  };
  if (document.body) walk(document.body, 0, 'body', false);

  const CAP = 10, lines = [];
  let cur = null, buf = [], cnt = 0;
  const flush = () => {
    if (buf.length) lines.push('[' + cur + '] ' + buf.join('  ') + (cnt > buf.length ? '  …+' + (cnt - buf.length) : ''));
    buf = []; cnt = 0;
  };
  for (const n of nodes) {
    if (n.role === 'text') continue;
    if (n.sec !== cur) { flush(); cur = n.sec; }
    cnt++;
    if (buf.length < CAP) {
      const st = n.states.includes('selected') ? '*' : (n.states.includes('offscreen') ? '~' : '');
      buf.push(n.id + st + '"' + n.name.slice(0, 44) + '"');
    }
  }
  flush();

  const tLines = [];
  {
    let tbuf = [], tcur = null;
    const pushT = () => { if (tbuf.length) tLines.push('[' + tcur + '] ' + tbuf.join(' ')); tbuf = []; };
    for (const n of nodes) {
      if (n.role !== 'text') continue;
      if (n.sec !== tcur) { pushT(); tcur = n.sec; }
      tbuf.push(n.id + '=\"' + n.name.slice(0, 60) + '\"');
      if (tbuf.length >= 4) pushT();
    }
    pushT();
  }
  const view = lines.join('\n') + (tLines.length ? '\n—— 内容 ——\n' + tLines.join('\n') : '');

  const SEL = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[onclick]';
  const audit = () => {
    const truth = [...document.querySelectorAll(SEL)].filter(vis);
    const emitted = nodes.filter(node => node.actions.length).map(node => map.get(node.id));
    const covered = truth.filter(el => emitted.includes(el));
    const missed = truth.filter(el => !covered.includes(el));
    const sample = missed.slice(0, 8).map(el => ({
      tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 28),
      name: clean(el.textContent || el.getAttribute('aria-label') || el.value).slice(0, 30),
      why: el.disabled ? 'disabled' : (!vis(el) ? 'invisible' : (el.getBoundingClientRect().width < 2 ? 'zero-size' : 'unreached'))
    }));
    return {
      truth_interactive: truth.length,
      covered: covered.length,
      recall: +(covered.length / Math.max(1, truth.length)).toFixed(3),
      missed: missed.length,
      missed_sample: sample
    };
  };

  const effectCoverage = () => {
    const byEffect = {};
    let generic = 0;
    for (const n of nodes) {
      const e = (n.actions[0] || {}).effects || ['none'];
      if (e.length === 1 && e[0] === 'state_change') generic++;
      for (const x of e) byEffect[x] = (byEffect[x] || 0) + 1;
    }
    return {
      total: nodes.length,
      typed: nodes.length - generic,
      generic,
      typed_ratio: +((nodes.length - generic) / Math.max(1, nodes.length)).toFixed(3),
      byEffect
    };
  };



  window.__av = {
    nodes, map, view, VERSION: '2.0', frames, frames_total: framesTotal, frames_truncated: framesTotal > frames.length,
    dialogs: globalThis.__avReadDialogs({ nodes, map, clean, vis }),
    stats: {
      kept: nodes.filter(n => n.role !== 'text').length,
      text_blocks: textBlocks,
      text_chars: textChars,
      max_depth: maxDepth,
      dropped_total: Object.values(drop).reduce((a, b) => a + b, 0),
      dropped_by_rule: drop,
      view_chars: view.length,
      outerHTML_KB: +(document.documentElement.outerHTML.length / 1024).toFixed(1),
      compression_x: +(document.documentElement.outerHTML.length / Math.max(1, view.length)).toFixed(1)
    },
    audit, effectCoverage,

    ...globalThis.__avCreateActions({ nodes, map, clean, safeText, recovery, hidden, sized, vis, hitTest, editorCapability, editorValue, labelControl, roleOf, labelNameOf, nameOf, cls, effectsOf, preconditionsOf, fallbackName, practiceTask, codingTask, uploadDropTarget, uploadCapability })
  };

  return window.__av.stats;
};
