(async()=>{
  const MAX = Math.max(1, Math.min(2000, Number(window.__avCollectMax) || 200));
  const ROUNDS = Math.max(1, Math.min(100, Number(window.__avCollectRounds) || 12));
  const out=[], seen=new Set(), byHref=new Map();
  const vis=e=>{const r=e.getBoundingClientRect();if(r.width<2||r.height<2)return false;
    const s=getComputedStyle(e);return s.visibility!=='hidden'&&s.display!=='none'&&+s.opacity>0.05;};
  const txt=e=>(e.innerText||e.textContent||'').trim().replace(/\s+/g,' ');
  const DATES=/(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?|\d{1,2}月\d{1,2}日|\d+\s*(?:秒|分钟|小时|天|周|个月|年)前|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2})/gi;
  const DUR=/\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

  const LABELS=[
    [/(播放|观看|views?|watched)/i,'播放'],
    [/(点赞|赞同|likes?|(?<![a-z])like(?![a-z]))/i,'点赞'],
    [/(评论|回复|留言|comments?|repl(?:y|ies))/i,'评论'],
    [/(转发|分享|reposts?|retweets?|shares?)/i,'转发'],
    [/(收藏|favorite|bookmark|saves?)/i,'收藏'],
    [/(弹幕|danmaku|danmu)/i,'弹幕'],
    [/(粉丝|关注者|followers?|fans)/i,'粉丝'],
    [/(stars?|星标)/i,'Star'],
    [/(播放量|观看量)/i,'播放']
  ];
  const typeMetrics=(raw)=>{
    if(!raw) return [];
    const res=[];

    const durs=[...raw.matchAll(DUR)].map(m=>m[0]);
    const dates=[...raw.matchAll(DATES)].map(m=>m[0]);
    let rest=raw.replace(DUR,' ').replace(DATES,' ');
    const NUM=/\d+(?:[.,]\d+)?\s*(?:万|亿|w|W|k|K|M|B|千)?/g;
    for(const m of rest.matchAll(NUM)){
      const v=(m[0]||'').trim(); if(!/\d/.test(v)) continue;
      const at=m.index||0;
      const before=rest.slice(Math.max(0,at-8), at);
      const after=rest.slice(at+v.length, at+v.length+8);
      let label='unnamed', best=99;
      for(const pair of LABELS){
        const bm=before.match(pair[0]); if(bm){ const d=8-bm.index; if(d<best){best=d;label=pair[1];} }
        const am=after.match(pair[0]);  if(am){ const d=am.index; if(d<best){best=d;label=pair[1];} }
      }
      res.push({value:v, label, slot:res.length+1});
      if(res.length>=8) break;
    }
    for(const d of durs.slice(0,2)) if(!res.some(x=>x.value===d)) res.push({value:d,label:'时长'});
    for(const d of dates.slice(0,1)) if(!res.some(x=>x.value===d)) res.push({value:d,label:'日期'});
    return res;
  };
  const grabLinks=()=>{
    for(const a of document.querySelectorAll('a[href]')){
      if(out.length>=MAX) return;
      if(!vis(a))continue;
      const t=txt(a); if(t.length<8||t.length>400)continue;
      const href=a.href;

      const prev=byHref.get(href);

      const box=a.closest('article,li,section,[role=article],[role=listitem],div');

      const titleish=/[A-Za-z\u4e00-\u9fa5]{4,}/.test(t);
      const full=box?(titleish?txt(box).split(t).join(' '):txt(box)):t;
      const mt=typeMetrics(full);
      if(prev){

        if(t.length>prev.title.length) prev.title=t.slice(0,300);
        prev.text_len=Math.max(prev.text_len,t.length);
        const have=new Set(prev.metrics_typed.map(x=>x.value+'|'+x.label));
        for(const x of mt) if(!have.has(x.value+'|'+x.label)){ prev.metrics_typed.push(x); prev.metrics.push(x.value); }
        continue;
      }
      const item={title:t.slice(0,300), href, metrics:mt.map(x=>x.value),
                  metrics_typed:mt, text_len:t.length, kind:'link'};
      byHref.set(href,item); out.push(item);
    }
  };
  const grabBlocks=()=>{
    for(const c of document.querySelectorAll('article,[role=article],[role=listitem]')){
      if(out.length>=MAX) return;
      if(!vis(c))continue;
      const t=txt(c); if(t.length<30||t.length>1200)continue;
      const key='blk|'+t.slice(0,40); if(seen.has(key))continue; seen.add(key);

      const inner=c.querySelector('a[href]');
      const mt=typeMetrics(t);
      out.push({title:t.slice(0,400), href:inner?inner.href:null,
                metrics:mt.map(x=>x.value), metrics_typed:mt,
                text_len:t.length, kind:'content_block'});
    }
  };
  const round=()=>{ const n=out.length; grabLinks(); grabBlocks(); return out.length-n; };
  try{ await new Promise(r=>setTimeout(r,1200)); }catch(e){}
  round();
  let rounds=0, dry=0;
  for(let i=0;i<ROUNDS;i++){
    if(out.length>=MAX) break;
    rounds=i+1;
    window.scrollBy(0, Math.max(300, Math.round(window.innerHeight*0.9)));
    await new Promise(r=>setTimeout(r,900));
    const got=round();
    const atBottom=(window.innerHeight+window.scrollY)>=document.body.scrollHeight-4;

    if(got===0){ dry++; if(dry>=3) break; } else dry=0;
    if(atBottom && got>0){ try{ await new Promise(r=>setTimeout(r,500)); }catch(e){} }
  }
  return { site:location.href, title:document.title, items:out, count:out.length,
           rounds, scroll_y:Math.round(window.scrollY),
           metric_note:'label 来自数字紧邻的标签词；label=unnamed 表示页面上只有图标没有文字，slot 是它在同类指标里的序号',
           innertext_len:(document.body?txt(document.body):'').length };
})()
