/*!
 * AgentView extractor v4 — 给 Agent 看的第二个渲染后端（网页版）
 *
 * v4 结果：5 个异构站点（豆瓣/MDN/必应/中国政府网/B站）交互元素召回率全部 1.000，
 * 平均压缩 267×（页 HTML → 视图字符），平均视图 2,317 字符。
 *
 * v4 相比 v2 的关键升级（每一条都是被实测失败逼出来的，不是设计出来的）：
 *  1. effects 补全：按 role / href / aria-expanded / class 语义词推断「点完世界变成什么样」，
 *     带 preconditions 与 reversible。5 站平均 84.7% 的节点拿到具体效果，15.3% 只能兜底 state_change。
 *  2. hidden 与 zero-size 必须分开：<mdn-dropdown> 用 display:contents 做布局，祖先 rect 是 0×0
 *     但子节点完全可见。按 v3 的写法会把 MDN 整条侧边栏 8 个 tab 剪掉，召回率 0.47。
 *  3. 无名但可点的元素不能丢：实测 5 站累计漏检 28 个，100% 是图标按钮/图片链接。
 *     现在合成结构性名字（img alt → src 文件名 → class）并标 provenance=dom-structural、
 *     confidence=0.4，而不是假装它不存在。
 *  4. audit()：拿 a[href],button,input,select,textarea,[role=*],[onclick] 做 ground truth 算召回率。
 *     压缩比再漂亮，漏了按钮就是废的。
 *
 * 注入（HTTP 版）：await fetch('http://127.0.0.1:8899/extract.js').then(r=>r.text()).then(t=>(new Function(t))())
 * 注入（内联版）：把本文件内容 eval 一次即可。
 */
(function () {
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  const ROLES = {
    A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox',
    H1: 'heading', H2: 'heading', H3: 'heading', IMG: 'image',
    LI: 'listitem', UL: 'list', TR: 'row', TD: 'cell', TH: 'columnheader',
    NAV: 'navigation', FORM: 'form', LABEL: 'label', TABLE: 'table'
  };

  // v3.1 关键修正：必须区分 hidden（真隐藏，整棵可剪）和 zero-size（可能只是包装层）。
  // 实测 MDN 用 <mdn-dropdown> + display:contents 做布局，祖先 rect 是 0×0 但子节点完全可见；
  // 按 v3 的写法会把整条侧边栏 8 个 tab 按钮全部误剪（召回率 0.47）。
  const hidden = el => {
    const st = getComputedStyle(el);
    return st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0;
  };
  const sized = el => {
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  };
  const vis = el => !hidden(el) && sized(el);

  const roleOf = el => {
    const a = el.getAttribute('role');
    if (a) return a;
    const t = el.tagName;
    if (t === 'INPUT') {
      const ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return 'checkbox';
      if (ty === 'submit' || ty === 'button') return 'button';
      return 'textbox';
    }
    return ROLES[t] || null;
  };

  /* 表单控件的名字在 <label> 上，不在控件自己身上。
     实测：GitHub /new 的 <label for="repository-name-input">Repository name*</label>
     会作为独立节点拿到名字 "Repository name*"，而 <input> 名字为空，
     于是 act --name "Repository name*" 点到了 label —— 返回 ok:true，一个字都没写进去。
     这里按 a11y 名字计算的标准顺序补上：label[for] → 包裹 label → aria-labelledby。 */
  const labelNameOf = el => {
    const id = el.getAttribute('id');
    if (id) {
      try {
        const l = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (l) { const t = clean(l.textContent); if (t) return t; }
      } catch (e) { /* CSS.escape 不可用时忽略 */ }
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
      || ['textbox', 'combobox', 'checkbox', 'radio'].includes(roleOf(el));
    if (isControl) {
      const ln = labelNameOf(el);
      if (ln) return ln.slice(0, 120);
    }
    for (const c of [
      el.getAttribute('aria-label'), el.getAttribute('alt'), el.getAttribute('title'),
      el.getAttribute('placeholder'), el.getAttribute('name'),
      el.tagName === 'INPUT' ? el.value : '', el.textContent
    ]) {
      const v = clean(c);
      if (v) return v.slice(0, 120);
    }
    return '';
  };

  /* ---------- effects：Agent 规划的唯一依据 ---------- */
  const cls = el => (typeof el.className === 'string' ? el.className : '') + ' '
    + (el.getAttribute('data-testid') || '') + ' ' + (el.getAttribute('name') || '') + ' '
    + (el.getAttribute('id') || '');

  const effectsOf = el => {
    const tag = el.tagName, role = roleOf(el), href = el.closest('a[href]') ? el.closest('a[href]').getAttribute('href') : '';
    const c = cls(el).toLowerCase();
    const ariaExpanded = el.getAttribute('aria-expanded');
    const inForm = !!el.closest('form');

    if (role === 'textbox' || tag === 'TEXTAREA') return { effects: ['field.value'], reversible: true };
    if (role === 'checkbox') return { effects: ['boolean_toggled'], reversible: true };
    if (role === 'combobox') return { effects: ['selection', 'list_may_replace'], reversible: false };
    if (ariaExpanded !== null) return { effects: ['panel_visibility', 'aria_expanded'], reversible: true };
    if (tag === 'BUTTON' && (el.type === 'submit' || c.includes('submit'))) return { effects: ['form_submit', 'network_request', 'page_state_may_reset'], reversible: false };
    // v4.2：表单里的图标/标签点下去就是提交表单（必应 sb_icon 在 #sb_form 里），不是"某处变一下"。
    if (inForm && (tag === 'LABEL' || /icon/i.test(c))) return { effects: ['form_submit', 'network_request', 'page_state_may_reset'], reversible: false };
    // v4.1：target=_blank 的点击在**当前页观测不到**，这是最早的两个 miss 之一。
    // 它既不能算 hit（自欺）也不能算 miss（冤枉），必须显式标成 open_new_tab → unverifiable。
    // v4.2：可点单位往往是包装 div，真正的跳转目标在它里面的 <a>——往下找一层再判。
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
    // 无 href 的可点元素：按 class 语义词判断它改变了什么
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
    // v4.1：搜索/提交按钮在输入框为空时点了毫无反应——这是另一个 miss 的成因。
    // 把它写成显式前置条件，Agent 就不会浪费一次动作去试。
    const tag = el.tagName, c = cls(el).toLowerCase();
    // v4.3：只给"真的会提交表单"的元素挂这条前置条件，并且只在**它自己的表单内**找输入框。
    // 两条收紧都是被实测逼出来的：整页大表单会误伤 19 个新闻链接；document 兜底会把"反馈"按钮也挂上。
    const eff = effectsOf(el).effects;
    if (eff.includes('form_submit')) {
      const form = el.closest('form');
      const box = form && form.querySelector('input[type=search],input[type=text],input[name=q],input[name=wd],input[name=keyword],textarea');
      if (box && !String(box.value || '').trim()) p.push('requires_nonempty_input');
    }
    return p;
  };

  /* v4：无名但可点的元素不能丢——它往往就是"图标按钮"或"图片链接"。
     给它一个结构性名字 + 低置信度，而不是假装它不存在。
     实测：5 个异构站累计漏检 28 个，100% 都是这一类。 */
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

  const nodes = [], map = new Map();
  let seq = 0;
  const drop = { r1_nested_clickable: 0, r2_empty_name: 0, r3_hidden: 0, r4_text_not_actionable: 0, r5_zero_size_wrapper: 0, r6_label_name_carrier: 0 };

  // v6：内容通道。之前的 IR 只发射"可操作"元素——拿去刷视频、读 README、看周热门项目时，
  // 页面在眼前却什么都读不到（GitHub 仓库页 body 22,203 字符，视图里 0 个文字块）。
  // 所以补一条只读通道：可见、无子元素的文本叶子，长于 TEXT_MIN，总量受 TEXT_BUDGET 约束。
  const TEXT_MIN = 24, TEXT_MAX = 140, TEXT_BUDGET = 2600;
  const TEXT_TAGS = ["P", "LI", "BLOCKQUOTE", "PRE", "TD", "DD", "DT", "FIGCAPTION", "SUMMARY", "H1", "H2", "H3", "H4"];
  let textChars = 0, textBlocks = 0;
  // GitHub 项目页的提交列表有几十行同样的结构，会把预算吃光，README 一个字都读不到。
  // 每个 sec 最多给几块文本，剩下的让位给真正的内容区。
  const TEXT_PER_SEC = 3;
  const tsecCount = {};

  // v5：Shadow DOM 是真实站点的常态（Web Components 遍地），只爬 el.children 会整块漏掉。
  // 这里把 shadowRoot 的子节点并进同一条遍历，深度限制仍然生效。
  const kids = el => {
    const out = [...el.children];
    if (el.shadowRoot) out.push(...el.shadowRoot.children);
    return out;
  };

  let maxDepth = 0;
  const walk = (el, depth, sec, insideClickable) => {
    if (depth > maxDepth) maxDepth = depth;
    if (depth > 48) return; // GitHub/React 深嵌套：README 段落实测在 depth 27，24 会整段丢掉
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'IFRAME'].includes(el.tagName)) return;
    if (hidden(el)) { drop.r3_hidden++; return; }
    const sizedEl = sized(el);

    const role = roleOf(el), st = getComputedStyle(el);
    const isForm = ['textbox', 'combobox', 'checkbox'].includes(role);
    const clickable = role === 'button' || role === 'link' || role === 'tab'
      || st.cursor === 'pointer' || !!el.closest('a[href]');

    if (insideClickable && !isForm) { drop.r1_nested_clickable++; return; }

    /* <label for=…> / 包裹控件的 <label> 是「控件的名字」，不是动作目标。
       它单独发射会抢占控件的名字（byName 精确命中 label，点下去什么也不会发生）。 */
    if (el.tagName === 'LABEL') {
      const forId = el.getAttribute('for');
      const hasCtl = (forId && document.getElementById(forId))
        || el.querySelector('input,select,textarea');
      if (hasCtl) { drop.r6_label_name_carrier++; for (const c of kids(el)) walk(c, depth + 1, sec, insideClickable); return; }
    }

    let name = nameOf(el), synth = false;
    if (!name && clickable) {
      name = fallbackName(el) || ('⟨' + (role || 'clickable') + '⟩');
      synth = true;
    }

    if (!name && !isForm) { drop.r2_empty_name++; }
    else if ((clickable || role === 'heading' || isForm) && !sizedEl) {
      // 零尺寸但不是 hidden：多半是 display:contents 包装层，继续往下找真正可见的子节点，不发射也不剪枝
      drop.r5_zero_size_wrapper++;
    }
    else if (clickable || role === 'heading' || isForm) {
      const id = 'n' + (++seq);
      const r = el.getBoundingClientRect();
      const inferred = clickable && !['button', 'link', 'tab', 'textbox', 'combobox', 'checkbox'].includes(role);
      const ef = effectsOf(el);

      nodes.push({
        id, role: role || (inferred ? 'clickable' : 'text'), name,
        // v5：handle 是**跨重建稳定**的定位符。页面重载 id 全变，但「role + 名字」通常还在。
        handle: (role || (inferred ? 'clickable' : 'text')) + ':' + name.slice(0, 40),
        states: [
          /(^|\s)(selected|active|checked|current)(\s|$)/.test(el.className || '') && 'selected',
          el.disabled && 'disabled',
          (r.top < innerHeight && r.bottom > 0) ? 'onscreen' : 'offscreen'
        ].filter(Boolean),
        actions: [{
          verb: isForm ? (role === 'textbox' ? 'set_value' : role === 'combobox' ? 'select' : 'set_checked') : 'click',
          params: isForm ? { [role === 'textbox' ? 'text' : role === 'combobox' ? 'option' : 'on']: 'value' } : {},
          effects: ef.effects,
          reversible: ef.reversible,
          preconditions: preconditionsOf(el)
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
      // 只认块级文本容器，且不再往下切（含标题/段落子节点就交给子节点）——
      // 否则每一层 <div> 都会命中，同一段话被发射 6 次。
      (TEXT_TAGS.includes(el.tagName) && !el.querySelector(TEXT_TAGS.join(",") + ",button,[role=button]"))
      || (el.children.length === 0 && (el.textContent || "").trim().length >= TEXT_MIN)
    )) {
      const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (raw.length < TEXT_MIN) { drop.r4_text_not_actionable++; }
      else {
        const id = 'n' + (++seq);
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
        return;
      }
    } else { drop.r4_text_not_actionable++; }

    const childSec = (el.className && typeof el.className === 'string' && el.className.trim())
      ? el.className.trim().split(/\s+/)[0].slice(0, 20) : sec;
    for (const c of kids(el)) walk(c, depth + 1, childSec, insideClickable);
  };
  walk(document.body, 0, 'body', false);

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
  
  // 内容通道单独成段：n50=\"…\" 的 = 表示“这句是读的，不是点的”。
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

  /* ---------- audit：拿真实交互元素做 ground truth ---------- */
  const SEL = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[onclick]';
  const audit = () => {
    const truth = [...document.querySelectorAll(SEL)].filter(vis);
    const emitted = [...map.values()];
    const covered = truth.filter(el => emitted.some(n => n === el || n.contains(el)));
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

  /* ---------- effects 覆盖度 ---------- */
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

  // v7：媒体静音双保险。--mute-audio 是进程级，但有些场景（复用用户已有 Chrome、
  // 或 Chrome 版本忽略该 flag）拿不到，所以注入时再压一遍：
  //  1) 已经存在的 <video>/<audio> 立刻 muted；
  //  2) 之后动态创建的媒体，用 MutationObserver 补上；
  //  3) 拦 HTMLMediaElement.prototype.play，播放前强制静音。
  // 只静音，不 pause：currentTime 仍要能涨，那是"刷视频闭环"的结构化验收标准。
  (function muteMedia() {
    const kill = m => { try { m.muted = true; m.volume = 0; } catch { /* 某些媒体不可写 */ } };
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
    } catch { /* 严格 CSP 下改不了原型，靠下面两条兜 */ }
    scan(document);
    try {
      const obs = new MutationObserver(muts => {
        for (const m of muts) for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (/^(VIDEO|AUDIO)$/.test(n.tagName)) kill(n);
          else scan(n);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch { /* 忽略 */ }
  })();

  window.__av = {
    nodes, map, view, VERSION: '8.0',
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

    // v5：按名字定位，不依赖 id。页面重建后 id 全变，名字还在——这是"能用"和"脆"的分界线。
    // v5.1：按名字定位要排序，不能只做 includes。
    // "韩国" 既是筛选 chip 又是卡片国家字段，朴素 includes 会报 AMBIGUOUS_NAME，
    // 而人一眼就知道要点那个 chip。排序规则：完全相等 > 前缀 > 包含；同档里控件优先于链接，名字短的优先。
    byName(substr) {
      const q = String(substr || '').trim().toLowerCase();
      const CONTROLS = ['listitem', 'button', 'tab', 'checkbox', 'radio', 'option', 'menuitem', 'combobox', 'link'];
      // B站首页同一个视频会给出 heading 和 link 两枚同名节点：heading 只是标题，link 才是能点的那个。
      // 同名不该报歧义，要按 role 是否本来就用来点击来排序。
      const ACTIONABLE = ['link', 'button', 'tab', 'listitem', 'checkbox', 'radio', 'option', 'menuitem', 'combobox', 'textbox'];
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

    // v5：动作后不要靠 sleep，靠"DOM 安静了"。
    settle(maxMs) {
      maxMs = maxMs || 4000;
      return new Promise(res => {
        const t0 = performance.now();
        let quiet = null, hard = null, done = false;
        const finish = reason => {
          if (done) return; done = true;
          obs.disconnect(); clearTimeout(quiet); clearTimeout(hard);
          res({ settled_ms: Math.round(performance.now() - t0), reason });
        };
        const obs = new MutationObserver(() => {
          clearTimeout(quiet);
          quiet = setTimeout(() => finish('quiet'), 250);
        });
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        hard = setTimeout(() => finish('max'), maxMs);
      });
    },

    act({ id, verb, text, name }) {
      if (!id && name) {
        const cand = window.__av.byName(name);
        if (!cand.length) return { ok: false, err: 'NO_SUCH_NAME' };
        // 名字完全相等时可以唯一确定，即使还有别的节点包含这个词；
        // 否则多候选就明确报歧义，把候选交回去让人（或模型）自己选。
        const q = String(name).trim().toLowerCase();
        const exact = (cand[0].name || '').toLowerCase() === q;
        // 名字一模一样、只是 role 不同的两枚节点（B站每个视频都是 heading+link 同名），
        // 名字本身没有歧义，排序已经把能点的那个排到前面了，直接用。
        const sameNamePair = cand[1] && (cand[1].name || '') === (cand[0].name || '');
        if (cand.length > 1 && !exact && !sameNamePair) {
          return { ok: false, err: 'AMBIGUOUS_NAME', candidates: cand.slice(0, 6).map(c => c.handle) };
        }
        id = cand[0].id;
      }
      let el = map.get(id);
      if (!el) return { ok: false, err: 'NO_SUCH_NODE' };
      if (!el.isConnected) return { ok: false, err: 'STALE_NODE' };
      /* 兜底：即便拿到了 label（历史视图、或页面动态生成），也重定向到它关联的控件。
         否则点 label 只会让浏览器"聚焦"控件，verb=click 的语义没兑现却返回 ok:true。 */
      if (el.tagName === 'LABEL') {
        const forId = el.getAttribute('for');
        const ctl = (forId && document.getElementById(forId)) || el.querySelector('input,select,textarea');
        if (ctl) el = ctl;
      }
      const r0 = el.getBoundingClientRect();
      if (r0.bottom < 0 || r0.top > innerHeight) el.scrollIntoView({ block: 'center' });
      if (verb === 'click') {
        // v4.2：`el.click()` 打在包装 div 上不会触发里面的 <a> 默认跳转——真人点的是那个 <a>。
        // 所以按坐标做命中测试，点"那个点上真正被点到的元素"，与视觉通道的语义完全一致。
        const r = el.getBoundingClientRect();
        const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
        const cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
        let hit = document.elementFromPoint(cx, cy) || el;
        // 先向上找：包装 div 里套着 <a>，真被点的是内层元素。
        const up = hit.closest && hit.closest('a,button,input,label,[role=button],[role=link]');
        if (up) hit = up;
        else {
          // v5.2：再向下找。GitHub trending 的 h3 是标题，链接在它**里面**（<h3><a href=...>…</a></h3>），
          // closest() 只向上，所以点 h3 什么都没发生——动作返回 ok:true，页面纹丝不动。
          const inner = el.querySelector && el.querySelector('a[href],button,[role=button],[role=link]');
          if (inner) hit = inner;
          else {
            // v6.2：B站首页的卡片根本不是 <a>，标题 H3 里也没有链接——真正的 <a> 在隔壁封面区，
            // 整张卡靠 Vue router 的 JS 处理器跳转。所以还要往上爬几层，找那个「手上真有链接」的祖先，
            // 或者 cursor:pointer 的祖先。点 H3 本身什么都不会发生，但会返回 ok:true（静默失败）。
            let anc = el.parentElement, guard = 0;
            // v6.7：往上爬只接受「和自己在几何上重叠」的链接。
            // 豆瓣筛选 chip 是 <li>，往上爬到 4 层就会撞见筛选容器里第一枚 <a>（某张电影卡），
            // 于是点「豆瓣高分」把整页导航到了电影详情页——返回 ok:true，但世界去了别处。
            const own = el.getBoundingClientRect();
            const overlap = (a, b) => a && b && a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
            while (anc && guard++ < 5) {
              const link = anc.querySelector && anc.querySelector('a[href]');
              if (link && overlap(link.getBoundingClientRect(), own)) { hit = link; break; }
              if (getComputedStyle(anc).cursor === 'pointer') { hit = anc; break; }
              anc = anc.parentElement;
            }
          }
        }
        // v6.3：不再直接 hit.click()。untrusted 事件会被 window.open 的弹窗拦截静默丢弃
        // （B站卡片就是这样：返回 ok:true，页面纹丝不动）。这里只算坐标，由 CDP 派发真实鼠标事件。
        // v6.4：还要挑一个"确实点到它"的点。B站的 <a> 覆盖整张卡，但标题 H3 压在它上面，
        // 点标题中心命中的是 H3（没有跳转处理器），点封面区才是那个 <a>。
        const hr = hit.getBoundingClientRect();
        const at = (x, y) => {
          const t = document.elementFromPoint(x, y);
          return t && (t === hit || hit.contains(t));
        };
        let px = null, py = null;
        const xs = [0.5, 0.25, 0.75, 0.1, 0.9], ys = [0.5, 0.25, 0.75, 0.1, 0.9];
        for (const fy of ys) {
          for (const fx of xs) {
            const x = Math.round(hr.left + hr.width * fx), y = Math.round(hr.top + hr.height * fy);
            if (x < 0 || y < 0 || x > innerWidth - 1 || y > innerHeight - 1) continue;
            if (at(x, y)) { px = x; py = y; break; }
          }
          if (px !== null) break;
        }
        if (px === null) {
          // 全被盖住：退回到左上角内侧 6px，那是最常见的"图标/文字起点"
          px = Math.round(Math.min(innerWidth - 1, Math.max(0, hr.left + 6)));
          py = Math.round(Math.min(innerHeight - 1, Math.max(0, hr.top + Math.min(hr.height / 2, 10))));
        }
        // v7.1：把命中的元素留给 CLI 做兜底（CDP 可信事件没落地时改走合成 click）。
        window.__avLastHit = hit;
        return { ok: true, resolved: hit === el ? 'self' : (hit.contains(el) ? 'ancestor:' + hit.tagName : 'other:' + hit.tagName), point: [px, py] };
      }
      if (verb === 'set_value') {
        el.focus();
        /* React / Vue 的受控组件在 input 上挂了 value tracker：直接 el.value = x
           会被判成「值没变」，onChange 不触发，下一次 re-render 就把值清回去。
           必须走原型链上的原生 setter，让 tracker 认为发生了真实变更。 */
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
        // 有些框架只在 keydown/keyup 里同步 state，补一对键盘事件更稳。
        try {
          el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
        } catch (e) { /* 老环境不支持 KeyboardEvent 构造器 */ }
        return { ok: true, how, value: String(el.value).slice(0, 60) };
      }
      return { ok: false, err: 'UNKNOWN_VERB' };
    },

    find(substr) {
      return nodes.filter(n => n.name.includes(substr))
        .map(n => {
          // 纯文本节点（role:'text'）没有 actions，直接取 actions[0] 会抛
          // TypeError: Cannot read properties of undefined。统一按「无动作」处理。
          const a = (n.actions && n.actions[0]) || {};
          return {
            id: n.id, name: n.name.slice(0, 40), role: n.role, sec: n.sec,
            confidence: n.confidence, effects: a.effects || [], clickable: !!a.verb
          };
        });
    },

    /** 预测：调用前就能知道世界会变成什么样，以及怎么验证 */
    predict(id) {
      const n = nodes.find(x => x.id === id);
      if (!n) return { ok: false, err: 'NO_SUCH_NODE' };
      const a = (n.actions && n.actions[0]) || null;
      if (!a) {
        // 纯文本节点只能读，不能点：给出明确的错误而不是崩溃。
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

    /** 写侧验证：先看 predict 说了什么，执行后用 5 个观测维度核对，返回 hit / partial / miss */
    probe(id, waitMs) {
      waitMs = waitMs || 1200;
      const n = nodes.find(x => x.id === id);
      if (!n) return Promise.resolve({ ok: false, err: 'NO_SUCH_NODE' });
      const snap = () => ({
        url: location.href,
        text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
        links: document.querySelectorAll('a[href]').length,
        checked: [...document.querySelectorAll('input[type=checkbox]')].map(e => e.checked).join(','),
        vis: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().height > 0).length
      });
      const before = snap();
      const pred = window.__av.predict(id);
      if (!pred.ok) return Promise.resolve(pred);
      // v4.2：会离开当前页的 effect 不能在页内验证——点了页面就没了，promise 永远不 resolve。
      // 这类动作的正确验证方式是"事后比对 URL / 新标签页"，不是页内 delta。
      const LEAVES = ['navigate', 'open_new_tab', 'download', 'destructive', 'inline_script', 'form_submit'];
      if (pred.effects.some(k => LEAVES.includes(k))) {
        return Promise.resolve({
          ok: true, id, name: n.name.slice(0, 28), verb: n.actions[0].verb, effects: pred.effects,
          verdict: 'skipped', reason: 'would_leave_page', verify_by: 'url_or_new_tab', delta: null, ms: 0
        });
      }
      const t0 = performance.now();
      const r = window.__av.act({ id, verb: n.actions[0].verb });
      if (!r.ok) return Promise.resolve({ ok: false, err: r.err });
      return new Promise(res => setTimeout(() => {
        const after = snap();
        const d = {
          url: before.url !== after.url,
          text: before.text !== after.text,
          links: after.links - before.links,
          checked: before.checked !== after.checked,
          vis: after.vis - before.vis
        };
        const expect = {
          navigate: d.url,
          filter_or_view_switch: d.text,
          list_replaces: d.text,
          items_append_or_replace: d.links > 0 || d.text,
          panel_visibility: d.vis !== 0 || d.text,
          boolean_toggled: d.checked,
          form_submit: d.url || d.text,
          state_change: d.text || d.vis !== 0
        };
        const keys = pred.effects.filter(k => k in expect);
        const hits = keys.filter(k => expect[k]);
        // v4.1：当前页观测不到的 effect 不进 hit/miss 计分——算 hit 是自欺，算 miss 是冤枉。
        const UNOBSERVABLE = ['open_new_tab', 'download'];
        const unobs = pred.effects.filter(k => UNOBSERVABLE.includes(k));
        res({
          ok: true, id, name: n.name.slice(0, 28), verb: n.actions[0].verb, effects: pred.effects,
          checked_effects: keys, hits,
          unobservable: unobs,
          // 只有 state_change 一条兜底 effect 的预测，命中是同义反复，单独标出来不计入准确率
          weak: keys.length === 1 && keys[0] === 'state_change',
          verdict: keys.length === 0
            ? 'unverifiable'
            : (hits.length === keys.length ? 'hit' : (hits.length ? 'partial' : 'miss')),
          delta: d, ms: Math.round(performance.now() - t0)
        });
      }, waitMs));
    },

    verify() {
      return {
        url: location.href,
        selected: [...document.querySelectorAll('.selected,[aria-selected="true"],[aria-checked="true"],.active')]
          .map(e => clean(e.textContent)).slice(0, 10),
        cards: [...document.querySelectorAll('.drc-subject-info-title')].slice(0, 6)
          .map(e => clean(e.textContent).replace(/\s+/g, ' '))
      };
    }
  };

  return window.__av.stats;
})();
