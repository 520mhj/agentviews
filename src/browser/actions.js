globalThis.__avCreateActions = function createSemanticActions(context) {
  const { nodes, map, clean, safeText, recovery, hidden, sized, vis, hitTest, editorCapability, editorValue, labelControl, roleOf, labelNameOf, nameOf, cls, effectsOf, preconditionsOf, fallbackName, uploadDropTarget, uploadCapability } = context;
  const assess = window.__avAssessAction;
  const inspect = window.__avInspectElement;
  const practiceTask = context.practiceTask === true;
  const codingTask = context.codingTask === true;
  const waits = new Set();
  const approvalTargets = window.__avApprovalTargets ||= new WeakMap();
  const targetIdentity = element => {
    if (!approvalTargets.has(element)) {
      window.__avApprovalSequence = (window.__avApprovalSequence || 0) + 1;
      approvalTargets.set(element, 'target-' + window.__avApprovalSequence);
    }
    return approvalTargets.get(element);
  };
  return {
    pageText() { return safeText(document.body); },
    byName(substr) {
      const q = String(substr || '').trim().toLowerCase();
      const CONTROLS = ['listitem', 'button', 'tab', 'checkbox', 'radio', 'option', 'menuitem', 'combobox', 'link'];

      const ACTIONABLE = ['link', 'button', 'tab', 'listitem', 'checkbox', 'radio', 'option', 'menuitem', 'combobox', 'textbox', 'searchbox'];
      const rank = n => {
        const s = (n.name || '').toLowerCase();
        if (s === q) return 0;
        if (s.startsWith(q)) return 1;
        if (s.includes(q)) return 2;
        return 3;
      };
      return nodes
        .map(n => ({ n, r: rank(n) }))
        .filter(x => x.r < 3)
        .sort((a, b) =>
          a.r - b.r ||
          (ACTIONABLE.includes(a.n.role) ? 0 : 1) - (ACTIONABLE.includes(b.n.role) ? 0 : 1) ||
          (CONTROLS.includes(a.n.role) ? 0 : 1) - (CONTROLS.includes(b.n.role) ? 0 : 1) ||
          (a.n.name || '').length - (b.n.name || '').length)
        .map(x => x.n);
    },

    dispose() {
      for (const finish of [...waits]) finish('cancelled');
      window.__avGuardHit = null;
      window.__avGuardKey = null;
      window.__avGuardText = null;
      window.__avLastHit = null;
      window.__avUploadInput = null;
      window.__avGuardUpload = null;
    },

    settle(maxMs = 4000) {
      const limit = Math.max(1, Math.min(30000, Number(maxMs) || 4000));
      return new Promise(resolve => {
        const started = performance.now();
        let quiet, hard, observer, done = false;
        const finish = reason => {
          if (done) return;
          done = true;
          observer?.disconnect();
          clearTimeout(quiet);
          clearTimeout(hard);
          waits.delete(finish);
          resolve({ settled_ms: Math.round(performance.now() - started), reason });
        };
        const armQuiet = () => { clearTimeout(quiet); quiet = setTimeout(() => finish('quiet'), 250); };
        waits.add(finish);
        try {
          observer = new MutationObserver(armQuiet);
          observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
          armQuiet();
          hard = setTimeout(() => finish('max'), limit);
        } catch { finish('unavailable'); }
      });
    },

    searchCandidates() {
      return nodes.filter(node => {
        const element = map.get(node.id);
        if (!element || !element.isConnected || !vis(element)) return false;
        if (!(element.tagName === 'TEXTAREA' || element.tagName === 'INPUT' && /^(text|search)$/i.test(element.type || 'text'))) return false;
        const info = inspect(element, 'press_enter', node.name);
        return info.safeSearch || /search|搜索|查询|检索|(?:^|[\s_-])(q|query|keyword|wd)(?:$|[\s_-])/i.test(info.searchEvidence);
      }).map(node => ({ id: node.id, name: node.name, role: node.role,
        evidence: inspect(map.get(node.id), 'press_enter', node.name).searchEvidence }));
    },

    act({ id, verb, text, name, role, option, checked, files, upload_mode, preview = false, approval }) {
      if (!id && name) {
        let candidates = window.__av.byName(name).filter(node => (!role || node.role === role)
          && (verb === 'click' ? node.actions.some(action => action.verb === 'click') : ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'fileinput'].includes(node.role)));
        const exact = candidates.filter(node => node.name.toLowerCase() === String(name).trim().toLowerCase());
        if (exact.length) candidates = exact;
        if (!candidates.length) return recovery('NO_SUCH_NAME');
        if (candidates.length !== 1) return recovery('AMBIGUOUS_NAME', { candidates: candidates.slice(0, 8).map(node => ({ id: node.id, role: node.role, name: node.name, section: node.sec })) });
        id = candidates[0].id;
      }
      if (id && /^d[^:]+:r\d+:/.test(id)) {
        if (!id.startsWith('d' + window.__avDocumentId + ':')) return recovery('STALE_DOCUMENT');
        if (!id.startsWith('d' + window.__avDocumentId + ':r' + window.__avRevision + ':')) return recovery('STALE_REVISION');
      }
      let el = map.get(id);
      if (!el) return recovery('NO_SUCH_NODE');
      if (!el.isConnected) return recovery('STALE_NODE');

      const label = el.tagName === 'LABEL' ? el : null;
      const associated = label && labelControl(label);
      if (associated) el = associated;
      if (!el.isConnected) return recovery('STALE_NODE');
      const labelChoice = verb === 'set_checked' && label && associated && el.tagName === 'INPUT'
        && /^(checkbox|radio)$/.test(el.type) && !vis(el);
      const labelFile = verb === 'upload_files' && label && associated && el.type === 'file' && !vis(el);
      let visual = labelChoice || labelFile ? label : el;
      if (verb === 'upload_files') {
        const capability = uploadCapability(el);
        if (!capability || !files || !Array.isArray(files.selections) || !files.file_count) return recovery('INVALID_FILE_INPUT');
        if (upload_mode === 'drop') {
          visual = uploadDropTarget(el);
          if (!visual || !vis(visual)) return recovery('UPLOAD_DROP_TARGET_UNAVAILABLE');
        } else {
          if (!capability.multiple && files.selections.length > 1) return recovery('UPLOAD_MULTIPLE_UNSUPPORTED');
          if (files.selections.some(selection => selection.kind === 'directory') && !capability.directory_input) return recovery('UPLOAD_DIRECTORY_REQUIRES_DROP');
        }
      }
      if (labelChoice) {
        for (let ancestor = el.parentElement; ancestor && ancestor !== label && label.contains(ancestor); ancestor = ancestor.parentElement) {
          if (vis(ancestor)) { visual = ancestor; break; }
        }
      }
      const check = target => {
        if (typeof assess !== 'function' || typeof inspect !== 'function') {
          return { ok: false, status: 'needs_user_action', reason: 'safety_policy_missing', instruction: '安全策略不可用，停止自动操作并反馈用户。' };
        }
        const detail = inspect(target, verb, nameOf(target) || name || '');
        if (verb === 'upload_files') detail.context = '';
        detail.practiceTask = practiceTask;
        detail.effects = verb === 'press_enter' ? (target.form || target.closest('form') ? ['form_submit'] : []) : effectsOf(target).effects;
        const permission = assess(detail);
        if (preview || approval || permission.confirmation_required) {
          const form = target.form || target.closest('form');
          const fields = form ? Array.from(form.querySelectorAll('input,textarea,select')).map(field => ({
            identity: targetIdentity(field), type: field.type || '', name: field.getAttribute('name'),
            value: field.value || '', checked: !!field.checked,
          })) : [];
          const scope = JSON.stringify({ document: window.__avDocumentId, url: location.href,
            target: targetIdentity(target), tag: target.tagName, detail, fields,
            upload: verb === 'upload_files' ? { mode: upload_mode, drop_target: targetIdentity(uploadDropTarget(target) || target), capability: uploadCapability(target) } : undefined });
          if (approval && (approval.scope !== scope || !Number.isFinite(approval.expires_at) || Date.now() >= approval.expires_at)) return recovery('CONFIRMATION_PAGE_CHANGED');
          if (preview) return { ...permission, approval_scope: scope };
          if (!permission.ok && !approval) return { ...permission, approval_scope: scope };
          if (!permission.ok && !permission.confirmation_required) return permission;
        } else if (!permission.ok) return permission;
        if (practiceTask && globalThis.__avReadDialogs({ nodes, map, clean, vis }).some(dialog => dialog.kind === 'proctoring')) {
          return recovery('PROCTORING_NOTICE_VISIBLE', { instruction: '监考提醒仍在显示，只读等待用户在考试页处理；不要切屏回复，不关闭监考，不自动点击确认或提交。提醒消失只恢复定位，不解除真实敏感人工等待。' });
        }
        return { ok: true };
      };
      if (verb === 'press_enter' && !(el.tagName === 'INPUT' && /^(text|search)$/i.test(el.type || 'text') || el.tagName === 'TEXTAREA')) return recovery('NOT_SEARCH_FIELD');
      if (!vis(visual) || labelChoice && !vis(label)) return recovery('TARGET_NOT_VISIBLE');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return recovery('TARGET_DISABLED');
      if (verb === 'set_value' && ((!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !el.isContentEditable) || el.readOnly
        || el.getAttribute('aria-readonly') === 'true')) return recovery('TARGET_NOT_EDITABLE');
      const permission = check(el);
      if (!permission.ok) return permission;
      if (preview) return permission;
      const r0 = visual.getBoundingClientRect();
      if (typeof visual.scrollIntoView === 'function') visual.scrollIntoView({ block: 'center', inline: 'nearest' });
      else if (r0.bottom < 0 || r0.top > innerHeight) return recovery('TARGET_NOT_VISIBLE');
      if (verb === 'upload_files') {
        const originalDocument = window.__avDocumentId, originalRevision = window.__avRevision;
        const originalName = nameOf(el), rect = visual.getBoundingClientRect();
        let point = null;
        for (const fraction of [0.5, 0.25, 0.75]) {
          const pointX = Math.round(rect.left + rect.width * fraction), pointY = Math.round(rect.top + rect.height * fraction);
          if (pointX < 0 || pointY < 0 || pointX >= innerWidth || pointY >= innerHeight) continue;
          const receiver = hitTest(pointX, pointY);
          if (receiver && (receiver === visual || visual.contains(receiver))) { point = [pointX, pointY]; break; }
        }
        if (!point) return recovery('TARGET_OBSCURED');
        window.__avUploadInput = el;
        window.__avGuardUpload = () => {
          if (!el.isConnected || !visual.isConnected || el.disabled || el.type !== 'file' || nameOf(el) !== originalName
            || map.get(id) !== (label || el) || window.__avDocumentId !== originalDocument || window.__avRevision !== originalRevision
            || !vis(visual) || el.getAttribute('aria-disabled') === 'true' || labelFile && labelControl(label) !== el) return recovery('STALE_UPLOAD_TARGET');
          const currentRect = visual.getBoundingClientRect();
          if (Math.abs(currentRect.left - rect.left) > 2 || Math.abs(currentRect.top - rect.top) > 2
            || Math.abs(currentRect.width - rect.width) > 2 || Math.abs(currentRect.height - rect.height) > 2) return recovery('TARGET_MOVED');
          const receiver = hitTest(point[0], point[1]);
          if (!receiver || receiver !== visual && !visual.contains(receiver)) return recovery('TARGET_OBSCURED');
          return check(el);
        };
        return { ok: true, file_upload: { method: upload_mode === 'drop' ? 'trusted_drag_drop' : 'native_file_input', point } };
      }
      if (verb === 'set_value' && (el.isContentEditable || codingTask && el.tagName === 'TEXTAREA')) {
        const editor = editorCapability(el);
        if (editor && !editor.supported && (codingTask || editor.reason !== 'editor_whitespace_not_preserved')) return recovery(editor.reason.toUpperCase());
        if (typeof text !== 'string' || text.length > 50000) return recovery('INVALID_TEXT_INPUT');
        const originalName = nameOf(el), originalDocument = window.__avDocumentId;
        const originalRevision = window.__avRevision;
        const rect = el.getBoundingClientRect();
        let point = null;
        for (const fraction of [0.5, 0.25, 0.75]) {
          const pointX = Math.round(rect.left + rect.width * fraction), pointY = Math.round(rect.top + rect.height * fraction);
          if (pointX < 0 || pointY < 0 || pointX >= innerWidth || pointY >= innerHeight) continue;
          const receiver = hitTest(pointX, pointY);
          if (receiver && (receiver === el || el.contains(receiver))) { point = [pointX, pointY]; break; }
        }
        if (!point) return recovery('TARGET_OBSCURED');
        el.focus({ preventScroll: true });
        window.__avGuardText = stage => {
          const root = el.getRootNode ? el.getRootNode() : document;
          if (!el.isConnected || !vis(el) || el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true'
            || el.getAttribute('aria-readonly') === 'true' || nameOf(el) !== originalName || map.get(id) !== el
            || window.__avDocumentId !== originalDocument || window.__avRevision !== originalRevision
            || (root.activeElement || document.activeElement) !== el) return recovery('STALE_TEXT_TARGET');
          const currentRect = el.getBoundingClientRect();
          if (Math.abs(currentRect.left - rect.left) > 2 || Math.abs(currentRect.top - rect.top) > 2
            || Math.abs(currentRect.width - rect.width) > 2 || Math.abs(currentRect.height - rect.height) > 2) return recovery('TARGET_MOVED');
          const receiver = hitTest(point[0], point[1]);
          if (!receiver || receiver !== el && !el.contains(receiver)) return recovery('TARGET_OBSCURED');
          if (stage === 'insert') {
            if (el.tagName === 'TEXTAREA') {
              if (el.selectionStart !== 0 || el.selectionEnd !== String(el.value || '').length) return recovery('TEXT_SELECTION_INCOMPLETE');
            } else {
              const selection = document.getSelection();
              if (!selection?.anchorNode || !selection.focusNode || !el.contains(selection.anchorNode) || !el.contains(selection.focusNode)) return recovery('TEXT_SELECTION_OUTSIDE_TARGET');
            }
          }
          return check(el);
        };
        return { ok: true, trusted_text: true, editor: el.tagName === 'TEXTAREA' ? 'native_textarea' : 'contenteditable' };
      }
      if (verb === 'press_enter') {
        el.focus();
        window.__avGuardKey = () => el.isConnected && ((el.getRootNode?.() || document).activeElement || document.activeElement) === el ? check(el) : recovery('STALE_SEARCH_TARGET');
        return { ok: true, key: 'Enter' };
      }
      if (verb === 'select') {
        if (el.tagName !== 'SELECT') return recovery('NOT_SELECT_CONTROL');
        const choices = Array.from(el.options).filter(choice => choice.value === option || choice.text === option);
        if (choices.length !== 1 || choices[0].disabled) return recovery('INVALID_OPTION');
        el.value = choices[0].value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: el.value };
      }
      if (verb === 'set_checked') {
        if (el.tagName !== 'INPUT' || !/^(checkbox|radio)$/.test(el.type) || typeof checked !== 'boolean') return recovery('NOT_CHECK_CONTROL');
        if (el.type === 'radio' && !checked) return recovery('RADIO_CANNOT_UNCHECK');
        if (el.checked === checked) return { ok: true, checked: el.checked, unchanged: true };
        if (!labelChoice) {
          el.checked = checked;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, checked: el.checked };
        }
      }
      if (verb === 'click' || labelChoice) {
        let hit = visual;
        const inner = el.querySelector('a[href],button,[role=button],[role=link]');
        if (!labelChoice && inner && nameOf(inner) === nameOf(el) && !['A', 'BUTTON', 'INPUT'].includes(el.tagName)) hit = inner;
        const hitPermission = check(labelChoice ? el : hit);
        if (!hitPermission.ok) return hitPermission;
        if (!hit.isConnected || !vis(hit) || hit.disabled || hit.getAttribute('aria-disabled') === 'true') return recovery('TARGET_NOT_ACTIONABLE');
        if (window.__avCurrentTabOnly && hit.closest('a[href]')) {
          const link = hit.closest('a[href]');
          if (link.target === '_blank') return { ok: true, same_tab_url: link.href };
        }
        const rect = hit.getBoundingClientRect();
        const fractions = [0.5, 0.25, 0.75, 0.1, 0.9];
        let point = null;
        for (const vertical of fractions) {
          for (const horizontal of fractions) {
            const pointX = Math.round(rect.left + rect.width * horizontal);
            const pointY = Math.round(rect.top + rect.height * vertical);
            if (pointX < 0 || pointY < 0 || pointX >= innerWidth || pointY >= innerHeight) continue;
            const element = hitTest(pointX, pointY);
            if (element && (element === hit || hit.contains(element))
              && (!labelChoice || !element.closest('a[href],button,select,textarea,[role=button],[role=link]'))) { point = [pointX, pointY]; break; }
          }
          if (point) break;
        }
        if (!point) return recovery('TARGET_OBSCURED');
        const originalName = nameOf(hit);
        const originalControlName = nameOf(el);
        const originalType = el.type;
        window.__avGuardHit = () => {
          if (labelChoice && (!el.isConnected || !label.isConnected || !vis(label) || labelControl(label) !== el
            || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.type !== originalType
            || el.checked === checked || nameOf(el) !== originalControlName)) return recovery('STALE_CHECK_TARGET');
          if (!hit.isConnected || !vis(hit) || hit.disabled || hit.getAttribute('aria-disabled') === 'true' || nameOf(hit) !== originalName) return recovery('STALE_CLICK_TARGET');
          const current = hit.getBoundingClientRect();
          if (Math.abs(current.left - rect.left) > 2 || Math.abs(current.top - rect.top) > 2
            || Math.abs(current.width - rect.width) > 2 || Math.abs(current.height - rect.height) > 2) return recovery('TARGET_MOVED');
          const receiver = hitTest(point[0], point[1]);
          if (!receiver || receiver !== hit && !hit.contains(receiver)) return recovery('TARGET_OBSCURED');
          if (labelChoice && receiver.closest('a[href],button,select,textarea,[role=button],[role=link]')) return recovery('TARGET_OBSCURED');
          return check(labelChoice ? el : hit);
        };
        window.__avLastHit = hit;
        return { ok: true, resolved: labelChoice ? 'native-choice-label' : hit === el ? 'self' : 'semantic-child', point };
      }
      if (verb === 'set_value') {
        const editor = editorCapability(el);
        if (editor && !editor.supported) return recovery(editor.reason.toUpperCase());
        el.focus();

        let how = 'direct';
        try {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
            : el.tagName === 'SELECT' ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) { desc.set.call(el, text); how = 'native-setter'; }
          else el.value = text;
        } catch (e) { el.value = text; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        try {
          el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
        } catch (e) {  }
        const privateValue = inspect(el, 'set_value', nameOf(el)).inputType === 'password'
          || assess(inspect(el, 'set_value', nameOf(el))).reason === 'private_input';
        return { ok: true, how, ...(privateValue ? { value_redacted: true } : { value: String(el.value).slice(0, 60) }) };
      }
      return { ok: false, err: 'UNKNOWN_VERB' };
    },

    find(substr) {
      return nodes.filter(n => n.name.includes(substr))
        .map(n => {

          const a = (n.actions && n.actions[0]) || {};
          return {
            id: n.id, name: n.name.slice(0, 40), role: n.role, sec: n.sec,
            confidence: n.confidence, effects: a.effects || [], clickable: !!a.verb
          };
        });
    },

    predict(id) {
      const n = nodes.find(x => x.id === id);
      if (!n) return { ok: false, err: 'NO_SUCH_NODE' };
      const a = (n.actions && n.actions[0]) || null;
      if (!a) {

        return { ok: false, err: 'NOT_ACTIONABLE', id, name: n.name.slice(0, 40), role: n.role, hint: '这是内容节点（role:text），只能读不能操作' };
      }
      const e = a.effects;
      const post = [];
      if (e.includes('navigate')) post.push('location.href 变化');
      if (e.includes('filter_or_view_switch') || e.includes('list_replaces')) post.push('列表内容整体替换,旧节点 id 可能失效');
      if (e.includes('items_append_or_replace')) post.push('列表长度增加');
      if (e.includes('panel_visibility')) post.push('该 panel 的 display 变化');
      if (e.includes('form_submit')) post.push('页面可能整页重载,之前所有 id 失效');
      if (e.includes('boolean_toggled')) post.push('checked 反转');
      return {
        ok: true, id, verb: a.verb, effects: e, reversible: a.reversible,
        preconditions: a.preconditions,
        postconditions: post.length ? post : ['DOM 局部变化'],
        risk: a.reversible ? 'low' : 'medium',
        verify_hint: e.includes('list_replaces') ? '比对替换前后首项文本' : '比对目标节点 states'
      };
    },

    read({ id, name, max = 12000 }) {
      if (id && /^d[^:]+:r\d+:/.test(id) && !id.startsWith('d' + window.__avDocumentId + ':')) return recovery('STALE_DOCUMENT');
      const candidates = id ? nodes.filter(node => node.id === id) : window.__av.byName(name);
      if (candidates.length !== 1) return recovery(candidates.length ? 'AMBIGUOUS_NAME' : 'NO_SUCH_NODE');
      const node = candidates[0], element = map.get(node.id);
      if (!element || !element.isConnected) return recovery('STALE_NODE');
      if (element.tagName === 'TEXTAREA' || element.isContentEditable) {
        const permission = assess(inspect(element, 'set_value', nameOf(element)));
        if (!permission.ok) return permission;
        const editor = editorCapability(element);
        if (editor && !editor.complete_value) return recovery(editor.reason.toUpperCase(), { complete_value: false });
      }
      const text = element.tagName === 'TEXTAREA' || element.isContentEditable ? editorValue(element) : safeText(element);
      const limit = Math.max(1, Math.min(50000, Number(max) || 12000));
      return { ok: true, revision: window.__avRevision, id: node.id, role: node.role, name: node.name,
        text: text.slice(0, limit), truncated: text.length > limit };
    },

    verify() {
      return {
        url: location.href,
        selected: [...document.querySelectorAll('.selected,[aria-selected="true"],[aria-checked="true"],.active')]
          .map(e => clean(e.textContent)).slice(0, 10),
        checked: [...document.querySelectorAll('input[type=checkbox]:checked')].length
      };
    }
  };
};
