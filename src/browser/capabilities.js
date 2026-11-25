(()=>{
  const N = window.__av ? window.__av.nodes : [];
  const G = { search:[], navigate:[], open_item:[], account:[], action:[], content:[] };
  const NA = /(登录|注册|sign in|log in|反馈|帮助|设置|投稿|feedback|settings|help)/i;
  const SE = /(搜索|查询|search|检索|find)/i;
  for (const n of N) {
    const name = (n.name||'').trim(), role = n.role||'';
    const a = (n.actions && n.actions[0]) || {};
    const item = { handle:n.handle, name:name.slice(0,60), role, sec:n.sec,
                   effects:a.effects||[], preconditions:a.preconditions||[], confidence:n.confidence };
    if (role === 'text') { G.content.push(item); continue; }
    if (SE.test(name) || role==='textbox' || role==='combobox' || role==='searchbox') G.search.push(item);
    else if (NA.test(name)) G.account.push(item);
    else if (role==='tab' || (role==='listitem' && name.length<=8)) G.navigate.push(item);
    else if ((role==='link'||role==='button') && name.length>=12) G.open_item.push(item);
    else if (role==='button'||role==='link'||role==='checkbox'||role==='radio'||role==='menuitem') G.action.push(item);
    else G.navigate.push(item);
  }
  const HINT = {
    search:'定位检索输入与入口，读取结果并验证',
    navigate:'切换栏目 / 分类 / 榜单，改变当前数据集合',
    open_item:'打开一条内容详情（视频 / 推文 / 文章）',
    account:'登录、反馈、设置、投稿等账户与站点功能',
    action:'页内操作（筛选、展开、播放、提交等）',
    content:'可读文本块（标题、正文、指标数字）'
  };
  const caps = Object.keys(G).filter(k=>G[k].length).map(k=>({
    use:k, hint:HINT[k], count:G[k].length, nodes:G[k]
  }));
  return { site:location.href, title:document.title,
           stats:window.__av?window.__av.stats:null,
           capabilities:caps, total_nodes:N.length };
})()
