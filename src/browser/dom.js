globalThis.__avCreateDOM = function createSemanticDOM() {
  const protectedInput = element => {
    if (typeof window.__avAssessAction !== 'function' || typeof window.__avInspectElement !== 'function') return true;
    const label = element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('name') || '';
    return window.__avAssessAction(window.__avInspectElement(element, 'set_value', label)).reason === 'private_input';
  };
  let privateTexts;
  const redactText = (value, refresh = false) => {
    let text = String(value || '');
    if (refresh || !privateTexts) {
      privateTexts = new Set();
      const roots = [document];
      for (const root of roots) {
        for (const element of root.querySelectorAll('input,textarea,select,[contenteditable]')) {
          if (!protectedInput(element)) continue;
          for (const secret of [element.value, element.textContent, element.isContentEditable ? element.innerText : '']) {
            if (typeof secret === 'string' && secret.length) privateTexts.add(secret);
          }
        }
        for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    for (const secret of privateTexts) text = text.split(secret).join('[redacted]');
    return text;
  };
  const clean = value => redactText(value).replace(/\s+/g, ' ').trim();
  const safeText = element => redactText(element && (element.innerText || element.textContent) || '', true);
  const recovery = (err, detail = {}) => ({ ok: false, status: 'needs_agent_review', reason: err.toLowerCase(), err, ...detail,
    instruction: '刷新 map/view/find，检查实际节点和页面证据后重选目标；不要猜 URL、换站或绕过安全策略。' });

  const ROLES = {
    A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', IMG: 'image',
    LI: 'listitem', UL: 'list', TR: 'row', TD: 'cell', TH: 'columnheader',
    NAV: 'navigation', FORM: 'form', LABEL: 'label', TABLE: 'table'
  };

  const hidden = el => {
    const st = getComputedStyle(el);
    return st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0;
  };
  const sized = el => {
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  };
  const vis = el => !hidden(el) && sized(el);

  const hitTest = (pointX, pointY) => {
    let receiver = document.elementFromPoint(pointX, pointY);
    const visited = new Set();
    while (receiver?.shadowRoot && !visited.has(receiver.shadowRoot)) {
      const root = receiver.shadowRoot;
      visited.add(root);
      if (typeof root.elementFromPoint !== 'function') break;
      const inner = root.elementFromPoint(pointX, pointY);
      if (!inner || inner === receiver) break;
      receiver = inner;
    }
    return receiver;
  };

  const editorCapability = el => {
    const driver = el.tagName === 'TEXTAREA' ? 'native_textarea'
      : el.isContentEditable && !el.parentElement?.isContentEditable ? 'contenteditable' : null;
    if (!driver) return null;
    const unavailable = reason => ({ driver, supported: false, reason, complete_value: false });
    if (!vis(el)) return unavailable('editor_not_visible');
    const rect = el.getBoundingClientRect();
    let left = rect.left, right = rect.left + rect.width, top = rect.top, bottom = rect.top + rect.height;
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode?.().host) {
      const identifier = String(ancestor.className || '') + ' ' + String(ancestor.getAttribute('data-editor-proxy') || '');
      if (/(?:CodeMirror|cm-editor|monaco-editor|editor-input-proxy)/i.test(identifier)
        || ancestor.getAttribute('data-editor-proxy') !== null) return unavailable('custom_editor_input_proxy');
      const style = getComputedStyle(ancestor);
      if (hidden(ancestor)) return unavailable('editor_not_visible');
      if (ancestor === el) continue;
      const boundary = ancestor.getBoundingClientRect();
      if (/^(?:hidden|clip)$/.test(style.overflowX || style.overflow || '')) {
        left = Math.max(left, boundary.left); right = Math.min(right, boundary.left + boundary.width);
      }
      if (/^(?:hidden|clip)$/.test(style.overflowY || style.overflow || '')) {
        top = Math.max(top, boundary.top); bottom = Math.min(bottom, boundary.top + boundary.height);
      }
      if (right - left < 2 || bottom - top < 2) return unavailable('editor_clipped');
    }
    if (driver === 'contenteditable' && !['pre', 'pre-wrap', 'break-spaces'].includes(getComputedStyle(el).whiteSpace)) {
      return unavailable('editor_whitespace_not_preserved');
    }
    return { driver, supported: true, reason: null, complete_value: true };
  };

  const editorValue = el => {
    if (el.tagName === 'TEXTAREA') return String(el.value || '');
    let text = String(el.innerText || el.textContent || '');
    const last = el.lastElementChild;
    if (el.isContentEditable && last && /^(DIV|P)$/.test(last.tagName) && last.childNodes.length === 1
      && last.firstChild.tagName === 'BR' && text.endsWith('\n\n')) text = text.slice(0, -1);
    return text;
  };

  const labelControl = label => {
    if (label.tagName !== 'LABEL') return null;
    if (label.control) return label.control;
    const root = label.getRootNode ? label.getRootNode() : document;
    const forId = label.getAttribute('for');
    return (forId && root.getElementById && root.getElementById(forId))
      || label.querySelector('input,select,textarea');
  };

  const roleOf = el => {
    const a = el.getAttribute('role');
    if (a) return a;
    const t = el.tagName;
    if (t === 'INPUT') {
      const ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'search') return 'searchbox';
      if (ty === 'file') return 'fileinput';
      if (ty === 'submit' || ty === 'button') return 'button';
      return 'textbox';
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    return ROLES[t] || null;
  };

  const labelNameOf = el => {
    const id = el.getAttribute('id');
    if (id) {
      try {
        const root = el.getRootNode ? el.getRootNode() : document;
        const l = root.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (l) { const t = clean(l.textContent); if (t) return t; }
      } catch (e) {  }
    }
    const wrap = el.closest && el.closest('label');
    if (wrap) { const t = clean(wrap.textContent); if (t) return t; }
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = clean(lb.split(/\s+/).map(x => (document.getElementById(x) || {}).textContent || '').join(' '));
      if (t) return t;
    }
    return '';
  };

  const nameOf = el => {
    const isControl = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)
      || ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio'].includes(roleOf(el));
    if (isControl) {
      const ln = labelNameOf(el);
      if (ln) return ln.slice(0, 120);
    }
    for (const c of [
      el.getAttribute('aria-label'), el.getAttribute('alt'), el.getAttribute('title'),
      el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) ? el.value : '',
      el.getAttribute('placeholder'), el.getAttribute('name'),
      ['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable && protectedInput(el) ? '' : el.textContent
    ]) {
      const v = clean(c);
      if (v) return v.slice(0, 120);
    }
    return '';
  };

  const cls = el => (typeof el.className === 'string' ? el.className : '') + ' '
    + (el.getAttribute('data-testid') || '') + ' ' + (el.getAttribute('name') || '') + ' '
    + (el.getAttribute('id') || '');

  const effectsOf = el => {
    const tag = el.tagName, role = roleOf(el), href = el.closest('a[href]') ? el.closest('a[href]').getAttribute('href') : '';
    if (role === 'fileinput') return { effects: ['file_upload', 'network_request'], reversible: false };
    const c = cls(el).toLowerCase();
    const ariaExpanded = el.getAttribute('aria-expanded');
    const inForm = !!(el.form || el.closest('form'));

    if (role === 'textbox' || role === 'searchbox' || tag === 'TEXTAREA') return { effects: ['field.value'], reversible: true };
    if (role === 'checkbox') return { effects: ['boolean_toggled'], reversible: true };
    if (role === 'radio') return { effects: ['selection'], reversible: true };
    if (role === 'combobox') return { effects: ['selection', 'list_may_replace'], reversible: false };
    if (ariaExpanded !== null) return { effects: ['panel_visibility', 'aria_expanded'], reversible: true };
    if (inForm && (tag === 'BUTTON' || tag === 'INPUT') && el.type === 'submit') return { effects: ['form_submit', 'network_request', 'page_state_may_reset'], reversible: false };

    const innerLink = tag === 'A' ? null : el.querySelector('a[href]');
    if (innerLink) {
      const ih = innerLink.getAttribute('href') || '';
      if (!/^javascript:/.test(ih)) {
        if (innerLink.getAttribute('target') === '_blank') return { effects: ['open_new_tab'], reversible: true };
        if (ih && !ih.startsWith('#')) return { effects: ['navigate'], reversible: true };
      }
    }
    if (href && el.closest('a') && el.closest('a').target === '_blank') return { effects: ['open_new_tab'], reversible: true };
    if (href) {
      if (href.startsWith('#')) return { effects: ['scroll_to_anchor'], reversible: true };
      if (/^(javascript:|$)/.test(href)) return { effects: ['inline_script'], reversible: false };
      if (/download|\/file|\.pdf|\.zip/i.test(href)) return { effects: ['download'], reversible: false };
      if (/logout|signout|delete|remove|unsubscribe/i.test(href + c)) return { effects: ['destructive'], reversible: false };
      return { effects: ['navigate'], reversible: true };
    }

    if (/tab|tag|chip|filter|menu|category|sort|segment|pill|option/.test(c)) return { effects: ['filter_or_view_switch', 'list_replaces'], reversible: true };
    if (/more|load|next|pagination|page-?num|infinite/.test(c)) return { effects: ['items_append_or_replace'], reversible: false };
    if (/toggle|collapse|expand|accordion|dropdown|drawer|modal|close/.test(c)) return { effects: ['visibility_toggled'], reversible: true };
    if (/like|fav|collect|star|vote|follow|upvote/.test(c)) return { effects: ['user_state_change', 'requires_auth_maybe'], reversible: true };
    if (/search|btn|button|submit|go\b/.test(c)) return { effects: ['network_request', 'list_replaces'], reversible: false };
    return { effects: ['state_change'], reversible: true };
  };

  const preconditionsOf = el => {
    const p = [];
    if (el.disabled) p.push('enabled');
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) p.push('scroll_into_view');
    if (el.closest('[aria-hidden="true"]')) p.push('visible');

    const tag = el.tagName, c = cls(el).toLowerCase();

    const eff = effectsOf(el).effects;
    if (eff.includes('form_submit')) {
      const form = el.closest('form');
      const box = form && form.querySelector('input[type=search],input[type=text],input[name=q],input[name=wd],input[name=keyword],textarea');
      if (box && !String(box.value || '').trim()) p.push('requires_nonempty_input');
    }
    return p;
  };

  const fallbackName = el => {
    const img = el.querySelector('img[alt],img[src]');
    if (img) {
      const a = clean(img.getAttribute('alt'));
      if (a) return a.slice(0, 60);
      const src = img.getAttribute('src') || '';
      const f = src.split('?')[0].split('/').pop();
      if (f) return 'img:' + f.slice(0, 40);
    }
    const labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      const t = clean(labelled.split(/\s+/).map(id => (document.getElementById(id) || {}).textContent || '').join(' '));
      if (t) return t.slice(0, 60);
    }
    const svgT = el.querySelector('svg title');
    if (svgT) { const t = clean(svgT.textContent); if (t) return t.slice(0, 60); }
    const cls2 = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    if (cls2) return '⟨' + (roleOf(el) || 'clickable') + ':' + cls2.slice(0, 24) + '⟩';
    return '';
  };


  const uploadDropTarget = element => element.tagName === 'INPUT' && element.type === 'file'
    ? element.closest('[ondrop],[dropzone],[data-dropzone],file-attachment,[class*=dropzone],[class*=drop-zone],[class*=upload-target],[class*=drop-target]') : null;
  const uploadCapability = element => element.tagName === 'INPUT' && element.type === 'file' ? {
    native_input: true, multiple: !!element.multiple, directory_input: element.hasAttribute('webkitdirectory'),
    drop_target_inferred: !!uploadDropTarget(element), accept: element.getAttribute('accept') || '',
    selected_count: element.files?.length || 0,
  } : null;
  return { clean, safeText, recovery, hidden, sized, vis, hitTest, editorCapability, editorValue, labelControl, roleOf, labelNameOf, nameOf, cls, effectsOf, preconditionsOf, fallbackName, uploadDropTarget, uploadCapability };
};
