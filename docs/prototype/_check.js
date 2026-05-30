
/* ============================ ICONS ============================ */
const ICONS={
  chat:'<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  bag:'<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  folder:'<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  puzzle:'<path d="M15.5 8.5V6a2 2 0 0 0-2-2h-2.5a1.5 1.5 0 1 0-3 0H5.5a2 2 0 0 0-2 2v2.5a1.5 1.5 0 1 1 0 3V14a2 2 0 0 0 2 2h2.5a1.5 1.5 0 1 0 3 0H15a2 2 0 0 0 2-2v-2.5a1.5 1.5 0 1 1 0-3"/>',
  message:'<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>',
  check:'<path d="M20 6 9 17l-5-5"/>', x:'<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
  plus:'<path d="M12 5v14"/><path d="M5 12h14"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings:'<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  play:'<path d="m6 3 14 9-14 9V3z"/>', power:'<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  refresh:'<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  send:'<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  chevR:'<path d="m9 18 6-6-6-6"/>', chevD:'<path d="m6 9 6 6 6-6"/>', arrowL:'<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  card:'<rect width="20" height="14" x="2" y="5" rx="2.5"/><path d="M2 10h20"/>',
  bell:'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  mail:'<rect width="20" height="16" x="2" y="4" rx="2.5"/><path d="m22 7-10 5L2 7"/>',
  database:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  code:'<path d="m16 18 6-6-6-6"/><path d="M8 6l-6 6 6 6"/>',
  calendar:'<rect width="18" height="18" x="3" y="4" rx="2.5"/><path d="M3 10h18"/><path d="M8 2v4"/><path d="M16 2v4"/>',
  chart:'<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="7" rx="1"/><rect x="12" y="7" width="3" height="11" rx="1"/><rect x="17" y="13" width="3" height="5" rx="1"/>',
  image:'<rect width="18" height="18" x="3" y="3" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  phone:'<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  headset:'<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><path d="M21 15v2a3 3 0 0 1-3 3h-1v-6h1a3 3 0 0 1 3 1z"/><path d="M3 15v2a3 3 0 0 0 3 3"/><rect x="3" y="13" width="3" height="6" rx="1.5"/>',
  edit:'<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  trend:'<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
  receipt:'<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
  wrench:'<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.8-.5-.5-2.8z"/>',
  spark:'<path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M5.6 5.6 7.7 7.7"/><path d="m16.3 16.3 2.1 2.1"/><path d="M5.6 18.4 7.7 16.3"/><path d="m16.3 7.7 2.1-2.1"/>',
  dot:'<circle cx="12" cy="12" r="9"/>',
};
function icon(n,o){ o=o||{}; const s=o.size||18,w=o.sw||1.7,c=o.cls||''; const st=o.color?`color:${o.color}`:''; return `<svg class="${c}" style="${st};display:inline-block;vertical-align:middle" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]||''}</svg>`; }
function avatar(n,color,size){ size=size||40; const r=Math.round(size*0.28),inner=Math.round(size*0.5); return `<span class="avatar" style="width:${size}px;height:${size}px;border-radius:${r}px;background:${color}1f;color:${color}">${icon(n,{size:inner,sw:1.9})}</span>`; }

/* ============================ DATA ============================ */
// 专家 Agent：可购买并装备到唯一助理身上
const EXPERTS=[
  {id:'cs',name:'客服专家',icon:'headset',tag:'热门',color:'#7c3aed',desc:'多轮对话、工单流转、知识库问答，帮助理搞定客户咨询。',skills:['多轮对话','工单流转','知识库','情绪识别'],plans:[{name:'标准版',price:299,unit:'月'},{name:'旗舰版',price:899,unit:'月'}]},
  {id:'da',name:'数据分析专家',icon:'chart',tag:'推荐',color:'#2563eb',desc:'连接数据库与表格，自动生成报表、洞察趋势、回答业务问题。',skills:['SQL查询','报表生成','趋势预测','看板'],plans:[{name:'标准版',price:499,unit:'月'},{name:'旗舰版',price:1299,unit:'月'}]},
  {id:'cw',name:'文案专家',icon:'edit',tag:'',color:'#db2777',desc:'品牌调性一致的营销文案、社媒内容、活动策划一键产出。',skills:['营销文案','社媒排期','SEO','多语言'],plans:[{name:'标准版',price:199,unit:'月'},{name:'旗舰版',price:599,unit:'月'}]},
  {id:'sa',name:'销售跟单专家',icon:'trend',tag:'',color:'#16a34a',desc:'自动跟进线索、更新 CRM、生成话术，让成单不再遗漏。',skills:['线索跟进','CRM同步','话术','日程提醒'],plans:[{name:'标准版',price:399,unit:'月'},{name:'旗舰版',price:999,unit:'月'}]},
  {id:'fi',name:'财务对账专家',icon:'receipt',tag:'',color:'#d97706',desc:'发票识别、自动对账、异常预警，月底结账省时 80%。',skills:['发票识别','自动对账','异常预警','报税'],plans:[{name:'标准版',price:599,unit:'月'},{name:'旗舰版',price:1499,unit:'月'}]},
  {id:'de',name:'研发协作专家',icon:'wrench',tag:'新',color:'#0891b2',desc:'读代码、修 Bug、写测试、提 PR，团队里的全栈搭子。',skills:['代码理解','Bug修复','单元测试','PR协作'],plans:[{name:'标准版',price:799,unit:'月'},{name:'旗舰版',price:1999,unit:'月'}]},
];
// 能力：可购买并装备到助理（部分随基础订阅免费）
const CAPS=[
  {id:'web',icon:'globe',name:'联网搜索',price:0},{id:'file',icon:'file',name:'文件读写',price:0},
  {id:'wechat',icon:'message',name:'微信收发',price:0},{id:'cal',icon:'calendar',name:'日程管理',price:39},
  {id:'mail',icon:'mail',name:'邮件收发',price:49},{id:'voice',icon:'phone',name:'语音通话',price:69},
  {id:'img',icon:'image',name:'图像生成',price:79},{id:'report',icon:'chart',name:'报表生成',price:89},
  {id:'db',icon:'database',name:'数据库查询',price:99},{id:'code',icon:'code',name:'代码执行',price:129},
];
const expertById=id=>EXPERTS.find(e=>e.id===id);
const cap=id=>CAPS.find(c=>c.id===id)||{name:id,icon:'spark',price:0};

// 唯一的数字助理：你只跟它对话；能力 / 专家都装备在它身上
// 每段对话 = 一个任务线程：既能继续聊，也是工作历史里的一条记录。
// message: {who, kind:'msg'|'step'|'result', text, ok?}  who='user'|'assistant'|专家名
let ASSISTANT={
  name:'灵犀助理', icon:'spark', color:'#7c3aed', status:'online', plan:'专业版', boundIM:true, wxNick:'Qiang',
  caps:['web','file','wechat'], experts:['cs'],
  threads:[
    {id:'thr_cur', title:'随便聊聊', status:'active', startedAt:'2026-05-25 11:02', messages:[
      {who:'assistant',kind:'msg',text:'你好，我是你的数字助理「灵犀」。直接告诉我要做什么——我会用已装备的能力完成，遇到专业任务会自动交给对应的专家 Agent。'}]},
    {id:'thr_8f21', title:'客户退货咨询处理', status:'completed', startedAt:'2026-05-25 09:12', messages:[
      {who:'user',kind:'msg',text:'帮我回复客户关于退货政策的咨询'},
      {who:'assistant',kind:'step',text:'识别为「售后-退货」问题，调度「客服专家」处理。'},
      {who:'客服专家',kind:'step',text:'命中退货政策 v2.4，生成礼貌回复并附上退货流程链接。'},
      {who:'assistant',kind:'result',ok:true,text:'已通过微信回复客户，满意度 5/5。'},
      {who:'assistant',kind:'msg',text:'已经帮你回复客户了，还需要我跟进物流或安排回访吗？'}]},
    {id:'thr_a07c', title:'本周销售数据周报', status:'running', startedAt:'2026-05-25 10:41', messages:[
      {who:'user',kind:'msg',text:'生成本周销售周报并发我'},
      {who:'assistant',kind:'step',text:'调用「联网搜索」「数据库查询」收集本周数据。'},
      {who:'数据分析专家',kind:'step',text:'已汇总各渠道销量，正在生成图表与结论…'}]},
    {id:'thr_3b99', title:'上月发票批量对账', status:'failed', startedAt:'2026-05-24 18:03', messages:[
      {who:'user',kind:'msg',text:'对上个月的发票做对账'},
      {who:'assistant',kind:'step',text:'该任务需要「财务对账专家」，当前尚未装备。'},
      {who:'assistant',kind:'result',ok:false,text:'缺少财务对账专家，任务终止。建议前往市场添加后重试。'}]},
  ]
};

const NAV=[{id:'workspace',name:'工作台',icon:'chat'},{id:'assistant',name:'我的助理',icon:'user'}];
const STATE={ user:null, section:'workspace', currentThreadId:'thr_cur', asTab:'equip', marketTab:'experts' };
let imRefresh=null;

/* ============================ HELPERS ============================ */
const $=(s,r)=>(r||document).querySelector(s);
const $all=(s,r)=>Array.from((r||document).querySelectorAll(s));
const el=h=>{ const t=document.createElement('template'); t.innerHTML=h.trim(); return t.content.firstElementChild; };
const money=n=>n===0?'免费':'¥'+n;
function statusMeta(s){ return {active:{t:'对话中',c:'var(--run)',bg:'var(--run-w)'},completed:{t:'已完成',c:'var(--ok)',bg:'var(--ok-w)'},running:{t:'运行中',c:'var(--run)',bg:'var(--run-w)'},failed:{t:'失败',c:'var(--bad)',bg:'var(--bad-w)'},paused:{t:'已暂停',c:'var(--text2)',bg:'#eef0f3'}}[s]||{t:s,c:'var(--text2)',bg:'#eef0f3'}; }
function toast(msg){ const t=el(`<div class="toast fade">${icon('check',{size:15,color:'#5fe08a'})}<span>${msg}</span></div>`); document.body.appendChild(t); setTimeout(()=>{ t.style.transition='opacity .4s'; t.style.opacity='0'; setTimeout(()=>t.remove(),400); },1900); }
function qrSVG(seed){ let h=0; for(const c of String(seed)) h=(h*131+c.charCodeAt(0))>>>0; const N=23,px=168,cell=px/N; let r=''; const rnd=()=>{h=(h*1103515245+12345)&0x7fffffff;return (h>>>8)/0x7fffff;}; const finder=(x,y)=>`<rect x="${x*cell}" y="${y*cell}" width="${7*cell}" height="${7*cell}" rx="${cell}" fill="#1b1c20"/><rect x="${(x+1)*cell}" y="${(y+1)*cell}" width="${5*cell}" height="${5*cell}" rx="${cell*.8}" fill="#fff"/><rect x="${(x+2)*cell}" y="${(y+2)*cell}" width="${3*cell}" height="${3*cell}" rx="${cell*.6}" fill="#1b1c20"/>`; for(let y=0;y<N;y++)for(let x=0;x<N;x++){ if((x<8&&y<8)||(x>N-9&&y<8)||(x<8&&y>N-9))continue; if(rnd()>0.55) r+=`<rect x="${x*cell+cell*.12}" y="${y*cell+cell*.12}" width="${cell*.76}" height="${cell*.76}" rx="${cell*.2}" fill="#1b1c20"/>`; } return `<svg width="100%" height="100%" viewBox="0 0 ${px} ${px}"><rect width="${px}" height="${px}" fill="#fff"/>${r}${finder(0,0)}${finder(N-7,0)}${finder(0,N-7)}</svg>`; }

/* ============================ ROOT ============================ */
function render(){ const app=$('#app'); app.innerHTML=''; app.appendChild(STATE.user?renderShell():renderAuth()); }

/* ============================ AUTH ============================ */
let authMode='login';
function renderAuth(){
  const w=el(`<div class="auth"><div class="auth-card fade">
    <div style="display:flex;align-items:center;gap:11px;margin-bottom:22px">${avatar('spark','#7c3aed',42)}<div><div style="font-size:17px;font-weight:650">灵犀</div><div class="dim" style="font-size:12px">数字员工平台</div></div></div>
    <div class="seg"><button id="t-l">登录</button><button id="t-r">注册</button></div>
    <div id="af" style="display:flex;flex-direction:column;gap:10px"></div>
    <button id="sb" class="btn btn-primary" style="width:100%;margin-top:18px;padding:11px"></button>
    <div style="display:flex;align-items:center;gap:12px;margin:16px 0;color:var(--text3);font-size:12px"><div style="flex:1;height:1px;background:var(--border)"></div>或<div style="flex:1;height:1px;background:var(--border)"></div></div>
    <button id="wx" class="btn btn-ghost" style="width:100%;padding:11px">${icon('message',{size:16,color:'#16a34a'})}微信一键登录</button>
    <p class="dim" style="font-size:11.5px;text-align:center;margin:16px 0 0">登录即代表同意《服务协议》与《隐私政策》</p>
  </div></div>`);
  const af=$('#af',w),tl=$('#t-l',w),tr=$('#t-r',w),sb=$('#sb',w);
  const paint=()=>{ tl.className=authMode==='login'?'active':''; tr.className=authMode==='reg'?'active':'';
    af.innerHTML=`${authMode==='reg'?'<input class="input" placeholder="你的称呼" value="Qiang">':''}<input class="input" placeholder="邮箱" value="nowall57@gmail.com"><input class="input" type="password" placeholder="密码" value="••••••••">${authMode==='reg'?'<input class="input" type="password" placeholder="确认密码" value="••••••••">':''}`;
    sb.textContent=authMode==='login'?'登录':'注册并进入'; };
  tl.onclick=()=>{authMode='login';paint();}; tr.onclick=()=>{authMode='reg';paint();};
  const go=()=>{ STATE.user={name:'Qiang',email:'nowall57@gmail.com'}; render(); setTimeout(()=>toast('欢迎回来，Qiang'),200); };
  sb.onclick=go; $('#wx',w).onclick=go; paint(); return w;
}

/* ============================ SHELL ============================ */
function renderShell(){
  const shell=el(`<div class="shell">
    <aside class="rail">
      <div class="rail-brand">${avatar('spark','#7c3aed',34)}<div><div class="name">灵犀</div><div class="sub">数字员工平台</div></div></div>
      <div style="padding:10px 12px 4px"><button class="btn btn-primary" id="new-conv" style="width:100%">${icon('plus',{size:15})}新对话</button></div>
      <div class="chat-list-h" style="padding:10px 14px 6px">对话 / 任务历史</div>
      <div id="convs" class="rail-convs"></div>
      <div class="rail-user" id="acct">${avatar('user','#7c3aed',34)}<div style="flex:1;min-width:0"><div class="nm">${STATE.user.name}</div><div class="em">${STATE.user.email}</div></div>${icon('chevD',{size:15,cls:'dim'})}</div>
    </aside>
    <div class="main"><div id="view" style="flex:1;display:flex;flex-direction:column;min-height:0"></div></div>
    <nav class="tabbar" id="tabbar"></nav>
  </div>`);
  refreshConvList(shell);
  $('#new-conv',shell).onclick=()=>newConversation();
  const acct=$('#acct',shell); acct.onclick=(e)=>{ e.stopPropagation(); toggleAcctMenu(shell,acct); };
  // mobile tabbar
  const tabbar=$('#tabbar',shell);
  const mtabs=[{id:'conv',n:'对话',ic:'chat'},{id:'assistant',n:'我的助理',ic:'user'},{id:'me',n:'账号',ic:'settings'}];
  const cur=STATE.section==='assistant'?'assistant':STATE.section==='me'?'me':'conv';
  mtabs.forEach(t=>{ const b=el(`<button class="${t.id===cur?'active':''}">${icon(t.ic,{size:20})}<span>${t.n}</span></button>`); b.onclick=()=>{ if(t.id==='conv'){ STATE.section='workspace'; STATE.mobileConvOpen=false; } else STATE.section=t.id; render(); }; tabbar.appendChild(b); });
  $('#view',shell).appendChild(renderSection());
  return shell;
}
function toggleAcctMenu(shell,acct){
  const ex=$('.acct-pop',shell); if(ex){ ex.remove(); return; }
  const pop=el(`<div class="acct-pop">
    <div class="ap-head">${avatar('user','#7c3aed',36)}<div style="flex:1;min-width:0"><div class="nm">${STATE.user.name}</div><div class="em">${STATE.user.email}</div></div></div>
    <div class="ap-sep"></div>
    <button id="m-as"><span class="ai">${icon('user',{size:16})}</span>我的助理</button>
    <button id="m-bill"><span class="ai">${icon('card',{size:16})}</span>账单与订阅</button>
    <button id="m-help"><span class="ai">${icon('help',{size:16})}</span>帮助与反馈</button>
    <div class="ap-sep"></div>
    <button id="m-out" class="danger"><span class="ai">${icon('logout',{size:16})}</span>退出登录</button></div>`);
  $('#m-as',pop).onclick=()=>{ pop.remove(); STATE.section='assistant'; render(); };
  $('#m-bill',pop).onclick=()=>{ pop.remove(); toast('账单与订阅 · 原型演示'); };
  $('#m-help',pop).onclick=()=>{ pop.remove(); toast('帮助与反馈 · 原型演示'); };
  $('#m-out',pop).onclick=()=>{ STATE.user=null; render(); };
  acct.parentNode.appendChild(pop);
  setTimeout(()=>{ const close=(e)=>{ if(!pop.contains(e.target)){ pop.remove(); document.removeEventListener('click',close); } }; document.addEventListener('click',close); },0);
}
function selectThread(id){ STATE.currentThreadId=id; STATE.section='workspace'; STATE.mobileConvOpen=true; render(); }
function go(sec){ STATE.section=sec; render(); }
function rerenderView(){ const v=$('#view'); if(!v)return; v.innerHTML=''; v.appendChild(renderSection()); refreshConvList(); }
function renderSection(){
  switch(STATE.section){
    case 'workspace': return viewWorkspace();
    case 'assistant': return viewAssistant();
    case 'me': return viewMe();
  }
  return viewWorkspace();
}
function viewMe(){
  const wrap=el(`<div style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`);
  wrap.appendChild(topbar('账号'));
  const c=el(`<div class="content"><div class="pad maxw">
    <div class="card" style="padding:18px;display:flex;align-items:center;gap:14px;margin-bottom:14px">${avatar('user','#7c3aed',48)}<div><div style="font-weight:650;font-size:16px">${STATE.user.name}</div><div class="dim" style="font-size:12.5px">${STATE.user.email}</div></div></div>
    <button class="card" id="go-as" style="width:100%;text-align:left;padding:15px;display:flex;align-items:center;gap:11px;margin-bottom:10px">${icon('user',{size:18})}<span style="flex:1">我的助理 · 装备 / 市场 / 微信绑定</span>${icon('chevR',{size:15,cls:'dim'})}</button>
    <button class="btn btn-ghost" id="logout2" style="width:100%;color:var(--bad);padding:12px">${icon('logout',{size:16})}退出登录</button>
  </div></div>`);
  $('#go-as',c).onclick=()=>{ STATE.section='assistant'; render(); };
  $('#logout2',c).onclick=()=>{ STATE.user=null; render(); };
  wrap.appendChild(c); return wrap;
}
function topbar(title, right){ const t=el(`<div class="topbar"><div class="t">${title}</div><div style="flex:1"></div></div>`); if(right) t.appendChild(right); return t; }

/* ============================ CHAT ============================ */
function viewWorkspace(){
  const a=ASSISTANT;
  if(!a.threads.length || !a.threads.some(t=>t.id===STATE.currentThreadId)) STATE.currentThreadId=a.threads[0]?a.threads[0].id:null;
  if(isMobile() && !STATE.mobileConvOpen) return mobileConvListView();
  const wrap=el(`<div class="chat-main" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`);
  const t=a.threads.find(x=>x.id===STATE.currentThreadId);
  if(!t){ wrap.appendChild(el(`<div class="content pad dim" style="font-size:13px">还没有对话，点左上角「新对话」开始。</div>`)); return wrap; }
  wrap.appendChild(buildConversation(t)); return wrap;
}
function mobileConvListView(){
  const wrap=el(`<div style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`);
  wrap.appendChild(topbar('对话 / 任务'));
  const c=el(`<div class="content"><div style="padding:12px"><button class="btn btn-primary" id="nc" style="width:100%">${icon('plus',{size:15})}新对话</button></div><div id="convs"></div></div>`);
  $('#nc',c).onclick=()=>newConversation();
  ASSISTANT.threads.forEach(t=>$('#convs',c).appendChild(convItem(t)));
  wrap.appendChild(c); return wrap;
}
function refreshConvList(root){ const c=$('#convs',root); if(!c)return; c.innerHTML=''; ASSISTANT.threads.forEach(t=>c.appendChild(convItem(t))); }
function convItem(t){
  const sm=statusMeta(t.status); const on=t.id===STATE.currentThreadId;
  const last=[...t.messages].reverse().find(m=>m.kind==='msg'); const preview=last?last.text:(t.messages.slice(-1)[0]?t.messages.slice(-1)[0].text:'…');
  const it=el(`<div class="conv ${on?'active':''}" style="align-items:flex-start">
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:6px"><span style="font-weight:600;font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.title}</span><span class="badge" style="background:${sm.bg};color:${sm.c};font-size:10px;padding:1px 7px">${t.status==='running'?'<span class="dot pulse" style="background:currentColor;width:5px;height:5px"></span>':''}${sm.t}</span></div>
      <div class="dim" style="font-size:11.5px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${preview}</div>
      <div class="dim" style="font-size:11px;margin-top:2px">${t.startedAt}</div></div></div>`);
  it.onclick=()=>selectThread(t.id);
  return it;
}
function buildConversation(t){
  const a=ASSISTANT; const sm=statusMeta(t.status);
  const back=isMobile()?`<button class="btn btn-ghost" id="cv-back" style="padding:7px 9px;margin-right:2px">${icon('arrowL',{size:16})}</button>`:'';
  const box=el(`<div style="flex:1;display:flex;flex-direction:column;min-height:0">
    <div class="chat-head">${back}${avatar(a.icon,a.color,34)}<div style="flex:1;min-width:0"><div style="font-weight:600;display:flex;align-items:center;gap:8px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.title}</span><span class="badge" style="background:${sm.bg};color:${sm.c}">${sm.t}</span></div><div class="dim" style="font-size:12px;margin-top:1px">${a.name} · 开始于 ${t.startedAt}</div></div></div>
    <div class="msgs" id="msgs"></div>
    <div class="composer"><textarea id="ta" rows="1" placeholder="继续和 ${a.name} 对话…"></textarea><button class="btn btn-primary" id="send" style="padding:10px 14px">${icon('send',{size:16})}</button></div></div>`);
  const bk=$('#cv-back',box); if(bk) bk.onclick=()=>{ STATE.mobileConvOpen=false; render(); };
  const msgs=$('#msgs',box);
  const paint=()=>{ msgs.innerHTML=''; t.messages.forEach(m=>msgs.appendChild(renderMsg(a,m))); msgs.scrollTop=msgs.scrollHeight; };
  paint();
  const ta=$('#ta',box);
  ta.addEventListener('input',()=>{ ta.style.height='auto'; ta.style.height=Math.min(120,ta.scrollHeight)+'px'; });
  const head=$('.chat-head .badge',box);
  const send=()=>{ const txt=ta.value.trim(); if(!txt)return;
    if(t.title==='新对话') t.title=txt.length>18?txt.slice(0,18)+'…':txt;
    t.status='active'; t.messages.push({who:'user',kind:'msg',text:txt}); ta.value=''; ta.style.height='auto'; paint();
    if(head){ head.textContent='对话中'; head.style.background='var(--run-w)'; head.style.color='var(--run)'; }
    refreshConvList();
    const typing=el(`<div class="msg them"><span style="margin-top:6px">${avatar(a.icon,a.color,30)}</span><div class="bubble typing"><span></span><span></span><span></span></div></div>`); msgs.appendChild(typing); msgs.scrollTop=msgs.scrollHeight;
    setTimeout(()=>{ typing.remove(); t.messages.push({who:'assistant',kind:'msg',text:agentReply(a,txt)}); paint(); refreshConvList(); },1100);
  };
  $('#send',box).onclick=send;
  ta.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } });
  return box;
}
function renderMsg(a,m){
  if(m.kind==='msg'){
    if(m.who==='user') return el(`<div class="msg me"><div class="bubble">${escapeHtml(m.text)}</div></div>`);
    return el(`<div class="msg them"><span style="margin-top:6px">${avatar(a.icon,a.color,30)}</span><div class="bubble">${escapeHtml(m.text)}</div></div>`);
  }
  if(m.kind==='step') return el(`<div style="align-self:stretch;display:flex;gap:8px;align-items:flex-start;padding:8px 12px;background:var(--panel);border:1px solid var(--border2);border-left:2px solid var(--accent);border-radius:8px;font-size:12.5px"><span style="color:var(--accent-d);line-height:1.4">${icon('settings',{size:13})}</span><div><span style="font-weight:600;color:var(--accent-d)">${escapeHtml(m.who==='assistant'?a.name:m.who)}</span><span class="muted"> · ${escapeHtml(m.text)}</span></div></div>`);
  const ok=m.ok; const col=ok?'var(--ok)':'var(--bad)'; const bg=ok?'var(--ok-w)':'var(--bad-w)';
  return el(`<div style="align-self:stretch;display:flex;gap:8px;align-items:flex-start;padding:8px 12px;background:${bg};border-radius:8px;font-size:12.5px;color:${col}"><span style="line-height:1.4">${ok?icon('check',{size:14}):icon('x',{size:14})}</span><div><b>${ok?'任务完成':'任务失败'}</b><span style="color:var(--text2)"> · ${escapeHtml(m.text)}</span></div></div>`);
}
function newConversation(){
  const id='thr_'+Math.random().toString(16).slice(2,6);
  ASSISTANT.threads.unshift({id, title:'新对话', status:'active', startedAt:new Date().toLocaleString('zh-CN',{hour12:false}).slice(0,16).replace(/\//g,'-'), messages:[{who:'assistant',kind:'msg',text:'你好，需要我做什么？直接说需求即可。'}]});
  selectThread(id);
}
function escapeHtml(s){ return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function agentReply(a,txt){
  const caps=a.caps.map(c=>cap(c).name).join('、');
  const experts=a.experts.length?a.experts.map(e=>expertById(e).name).join('、'):'（暂未装备专家）';
  if(/工单|待处理|客户|售后|退货|ticket/i.test(txt)) return '已调度「客服专家」处理：当前有 3 个待处理工单，其中 #TK-20583 为 P1。需要我升级或催办吗？';
  if(/报表|数据|分析|周报|销售/.test(txt)) return '好的，我会用「数据库查询」能力取数，并交给「数据分析专家」生成图表。请告诉我时间范围和关注指标。';
  if(/发票|对账|财务/.test(txt)) return '这项任务需要「财务对账专家」，你当前还没有装备。要我带你去市场添加吗？';
  if(/你好|hi|hello|在吗/i.test(txt)) return `你好！我是你的助理灵犀。已装备能力：${caps}；专家团队：${experts}。直接说需求即可，我会自己拆解、调用能力或委派专家。`;
  return `收到～我会用已装备的能力（${caps}）处理「${txt}」，必要时委派给专家（${experts}）。这是原型演示，正式版会真正调用工具并把过程记录到工作历史。`;
}

/* ============================ MY ASSISTANT (装备 + 市场) ============================ */
function viewAssistant(){
  const wrap=el(`<div style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`);
  wrap.appendChild(topbar('我的助理'));
  const tabs=el(`<div class="tabs"><button class="tab" data-t="equip">装备</button><button class="tab" data-t="market">市场</button></div>`);
  wrap.appendChild(tabs);
  const content=el(`<div class="content"></div>`); wrap.appendChild(content);
  const paint=()=>{ $all('.tab',tabs).forEach(t=>t.classList.toggle('active',t.dataset.t===STATE.asTab)); content.innerHTML=''; const pad=el(`<div class="pad maxw"></div>`); pad.appendChild(STATE.asTab==='equip'?buildEquip():buildMarket()); content.appendChild(pad); };
  $all('.tab',tabs).forEach(t=>t.onclick=()=>{ STATE.asTab=t.dataset.t; paint(); });
  paint(); return wrap;
}
function buildEquip(){
  const a=ASSISTANT;
  const box=el(`<div></div>`);
  const header=el(`<div class="card" style="padding:18px;display:flex;align-items:center;gap:14px;margin-bottom:20px">${avatar(a.icon,a.color,52)}
    <div style="flex:1;min-width:0"><div style="font-weight:650;font-size:16px">${a.name}</div>
      <div class="muted" style="font-size:12.5px;display:flex;align-items:center;gap:8px;margin-top:3px"><span style="display:inline-flex;align-items:center;gap:5px"><span class="dot pulse" style="background:var(--ok)"></span>在线</span><span class="dim">·</span>${a.plan}<span class="dim">·</span>微信${a.boundIM?'已绑定':'未绑定'}</div></div>
    <button class="btn ${a.boundIM?'btn-ghost':'btn-primary'}" id="im-btn">${icon('message',{size:15})}${a.boundIM?'微信已绑定':'绑定微信'}</button></div>`);
  $('#im-btn',header).onclick=()=>openIMModal();
  box.appendChild(header);
  // 能力
  const capSec=el(`<div style="margin-bottom:24px"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><div class="h2">已装备能力 · ${a.caps.length}</div><button class="btn btn-soft" id="add-cap" style="padding:6px 12px;font-size:13px">${icon('plus',{size:14})}添加能力</button></div><div class="grid cap-grid" id="cg"></div></div>`);
  const cg=$('#cg',capSec);
  if(!a.caps.length) cg.appendChild(el(`<div class="dim" style="font-size:13px">尚未装备能力，去市场添加。</div>`));
  a.caps.forEach(id=>{ const x=cap(id); const card=el(`<div class="cap on"><div style="display:flex;align-items:center;justify-content:space-between">${icon(x.icon,{size:22,color:'var(--accent)'})}<button class="dim" data-rm title="移除" style="padding:2px;line-height:0">${icon('x',{size:16})}</button></div><div style="font-weight:600;margin-top:10px">${x.name}</div><div style="font-size:12px;margin-top:2px;color:var(--accent-d)">已装备</div></div>`); card.querySelector('[data-rm]').onclick=()=>{ a.caps=a.caps.filter(i=>i!==id); toast(`已移除能力「${x.name}」`); box.replaceWith(buildEquip()); }; cg.appendChild(card); });
  box.appendChild(capSec);
  // 专家
  const expSec=el(`<div><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><div class="h2">专家团队 · ${a.experts.length}</div><button class="btn btn-soft" id="add-exp" style="padding:6px 12px;font-size:13px">${icon('plus',{size:14})}添加专家</button></div><div class="grid" id="eg" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))"></div></div>`);
  const eg=$('#eg',expSec);
  if(!a.experts.length) eg.appendChild(el(`<div class="dim" style="font-size:13px">尚未装备专家，去市场添加。</div>`));
  a.experts.forEach(id=>{ const e=expertById(id); const card=el(`<div class="card" style="padding:14px;display:flex;align-items:center;gap:12px;box-shadow:none">${avatar(e.icon,e.color,40)}<div style="flex:1;min-width:0"><div style="font-weight:600">${e.name}</div><div class="dim" style="font-size:12px">已装备 · 可被助理调用</div></div><button class="dim" data-rm title="移除" style="padding:4px;line-height:0">${icon('x',{size:16})}</button></div>`); card.querySelector('[data-rm]').onclick=()=>{ a.experts=a.experts.filter(i=>i!==id); toast(`已移除专家「${e.name}」`); box.replaceWith(buildEquip()); }; eg.appendChild(card); });
  box.appendChild(expSec);
  $('#add-cap',capSec).onclick=()=>{ STATE.asTab='market'; STATE.marketTab='caps'; go('assistant'); };
  $('#add-exp',expSec).onclick=()=>{ STATE.asTab='market'; STATE.marketTab='experts'; go('assistant'); };
  return box;
}
function buildMarket(){
  const box=el(`<div></div>`);
  const seg=el(`<div class="seg" style="width:auto;display:inline-flex;margin-bottom:18px"><button data-m="experts" style="padding:7px 18px">专家 Agent</button><button data-m="caps" style="padding:7px 18px">能力</button></div>`);
  box.appendChild(seg);
  const grid=el(`<div></div>`); box.appendChild(grid);
  const paint=()=>{ $all('button',seg).forEach(b=>b.className=b.dataset.m===STATE.marketTab?'active':''); grid.innerHTML=''; grid.appendChild(STATE.marketTab==='experts'?marketExperts():marketCaps()); };
  $all('button',seg).forEach(b=>b.onclick=()=>{ STATE.marketTab=b.dataset.m; paint(); });
  paint(); return box;
}
function marketExperts(){
  const g=el(`<div class="grid store-grid"></div>`);
  EXPERTS.forEach(p=>{ const owned=ASSISTANT.experts.includes(p.id);
    const card=el(`<div class="card prod">
      <div style="display:flex;align-items:center;gap:12px">${avatar(p.icon,p.color,44)}<div style="flex:1;min-width:0"><div style="font-weight:600;display:flex;align-items:center;gap:8px">${p.name}${p.tag?`<span class="badge" style="background:${p.color}1a;color:${p.color}">${p.tag}</span>`:''}</div><div class="dim" style="font-size:12.5px;margin-top:2px">起 ${money(p.plans[0].price)} / ${p.plans[0].unit}</div></div></div>
      <p class="muted" style="font-size:13px;margin:12px 0 0;flex:1">${p.desc}</p>
      <div class="skills">${p.skills.map(s=>`<span class="chip">${s}</span>`).join('')}</div>
      <button class="btn ${owned?'btn-ghost':'btn-primary'}" ${owned?'disabled':''} style="width:100%">${owned?'已装备':'购买并装备'}</button></div>`);
    if(!owned) card.querySelector('button').onclick=()=>openPurchaseExpert(p.id);
    g.appendChild(card);
  });
  return g;
}
function marketCaps(){
  const g=el(`<div class="grid cap-grid"></div>`);
  CAPS.forEach(x=>{ const owned=ASSISTANT.caps.includes(x.id);
    const card=el(`<div class="cap ${owned?'on':''}"><div style="display:flex;align-items:center;justify-content:space-between">${icon(x.icon,{size:22,color:owned?'var(--accent)':'var(--text2)'})}<span style="font-size:12px;font-weight:600;color:${owned?'var(--accent-d)':(x.price?'var(--text)':'var(--ok)')}">${owned?'已装备':money(x.price)}</span></div>
      <div style="font-weight:600;margin-top:10px">${x.name}</div>
      <button class="btn ${owned?'btn-ghost':'btn-soft'}" ${owned?'disabled':''} style="width:100%;margin-top:10px;padding:6px;font-size:13px">${owned?'已装备':(x.price?'购买':'免费添加')}</button></div>`);
    if(!owned) card.querySelector('button').onclick=()=>buyCap(x.id);
    g.appendChild(card);
  });
  return g;
}
function buyCap(id){
  const x=cap(id);
  if(!x.price){ ASSISTANT.caps.push(id); toast(`已添加能力「${x.name}」`); rerenderView(); return; }
  const ov=el(`<div class="overlay"></div>`);
  const m=el(`<div class="modal fade" style="width:360px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">${avatar(x.icon,ASSISTANT.color,44)}<div style="flex:1"><div style="font-weight:650;font-size:15px">${x.name}</div><div class="dim" style="font-size:12.5px">为助理添加此能力</div></div><button id="x" class="dim" style="padding:4px;line-height:0">${icon('x',{size:20})}</button></div>
    <div style="display:flex;align-items:center;justify-content:space-between;background:var(--panel2);border:1px solid var(--border);border-radius:11px;padding:12px 14px;margin-bottom:16px"><span class="muted">应付</span><span style="font-size:18px;font-weight:650">${money(x.price)}</span></div>
    <button id="pay" class="btn btn-primary" style="width:100%;padding:11px">确认购买并装备</button></div>`);
  $('#x',m).onclick=()=>ov.remove(); ov.onclick=e=>{ if(e.target===ov) ov.remove(); };
  $('#pay',m).onclick=()=>{ ov.remove(); ASSISTANT.caps.push(id); toast(`已购买并装备「${x.name}」`); rerenderView(); };
  ov.appendChild(m); document.body.appendChild(ov);
}

/* ============================ EXPERT PURCHASE ============================ */
function openPurchaseExpert(id){
  const c=expertById(id); let plan=c.plans[0];
  const ov=el(`<div class="overlay"></div>`);
  const m=el(`<div class="modal fade">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">${avatar(c.icon,c.color,46)}<div style="flex:1"><div style="font-weight:650;font-size:16px">${c.name}</div><div class="dim" style="font-size:12.5px">选择套餐，装备到你的助理</div></div><button id="x" class="dim" style="padding:4px;line-height:0">${icon('x',{size:20})}</button></div>
    <div id="plans" style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px"></div>
    <div style="display:flex;align-items:center;justify-content:space-between;background:var(--panel2);border:1px solid var(--border);border-radius:11px;padding:12px 14px;margin-bottom:16px"><span class="muted">应付</span><span id="tot" style="font-size:18px;font-weight:650"></span></div>
    <button id="pay" class="btn btn-primary" style="width:100%;padding:12px">确认购买并装备</button>
    <p class="dim" style="font-size:11.5px;text-align:center;margin:12px 0 0">购买后该专家将加入助理的专家团队，可被自动调用</p></div>`);
  const pb=$('#plans',m),tot=$('#tot',m);
  const paint=()=>{ pb.innerHTML=''; c.plans.forEach(p=>{ const sel=p===plan; const r=el(`<button class="plan-row ${sel?'sel':''}"><span style="display:flex;align-items:center;gap:9px">${sel?icon('check',{size:16,color:'var(--accent)'}):'<span style="width:16px;height:16px;border:2px solid var(--border);border-radius:50%;display:inline-block"></span>'}${p.name}</span><span style="font-weight:600">${money(p.price)}<span class="dim" style="font-weight:400;font-size:12px"> / ${p.unit}</span></span></button>`); r.onclick=()=>{plan=p;paint();}; pb.appendChild(r); }); tot.textContent=money(plan.price)+' / '+plan.unit; };
  paint();
  $('#x',m).onclick=()=>ov.remove(); ov.onclick=e=>{ if(e.target===ov) ov.remove(); };
  $('#pay',m).onclick=()=>{ ov.remove(); provisionExpert(c,plan); };
  ov.appendChild(m); document.body.appendChild(ov);
}
function provisionExpert(c,plan){
  const ov=el(`<div class="overlay"></div>`);
  const steps=['正在创建账单订单','正在初始化专家实例','正在接入助理运行时','正在装备到「灵犀助理」','装备完成'];
  const m=el(`<div class="modal fade" style="text-align:center;width:380px"><div style="display:flex;justify-content:center;margin-bottom:14px">${avatar(c.icon,c.color,56)}</div><div style="font-weight:650;font-size:15px">${c.name} · ${plan.name}</div><div id="st" class="muted" style="height:20px;margin:12px 0;display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px"></div><div class="progress"><div id="bar" style="width:0%"></div></div></div>`);
  ov.appendChild(m); document.body.appendChild(ov);
  const st=$('#st',m),bar=$('#bar',m); let i=0;
  const adv=()=>{ const last=i===steps.length-1; st.innerHTML=`${last?icon('check',{size:14,color:'var(--ok)'}):'<span class="spin">'+icon('refresh',{size:13})+'</span>'}${steps[i]}`; bar.style.width=((i+1)/steps.length*100)+'%'; i++; if(i<steps.length) setTimeout(adv,last?700:600); else setTimeout(()=>{ ov.remove(); if(!ASSISTANT.experts.includes(c.id)) ASSISTANT.experts.push(c.id); STATE.asTab='equip'; rerenderView(); toast(`已购买「${c.name}」并装备到灵犀助理`); },700); };
  adv();
}

/* ============================ WECHAT BINDING (assistant) ============================ */
function openIMModal(){
  const ov=el(`<div class="overlay"></div>`);
  const m=el(`<div class="modal fade" style="width:auto;max-width:560px;padding:0;overflow:hidden">
    <div style="display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid var(--border)"><div class="h2">微信绑定</div><div style="flex:1"></div><button id="x" class="dim" style="padding:4px;line-height:0">${icon('x',{size:20})}</button></div>
    <div id="imbody" style="padding:18px"></div></div>`);
  imRefresh=()=>{ const b=$('#imbody',m); b.innerHTML=''; b.appendChild(ASSISTANT.boundIM?imBound():imQR()); };
  $('#x',m).onclick=()=>{ ov.remove(); imRefresh=null; }; ov.onclick=e=>{ if(e.target===ov){ ov.remove(); imRefresh=null; } };
  imRefresh();
  ov.appendChild(m); document.body.appendChild(ov);
}
function imQR(){
  const a=ASSISTANT;
  const p=el(`<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">
    <div style="width:168px;height:168px;background:#fff;border:1px solid var(--border);border-radius:14px;padding:4px;position:relative;flex-shrink:0"><div id="qr">${qrSVG(a.name)}</div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"><div style="width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:${a.color}">${icon(a.icon,{size:18,color:'#fff'})}</div></div></div>
    <div style="flex:1;min-width:220px"><div style="font-weight:600;font-size:15px;margin-bottom:10px">微信扫码后，直接在微信里指挥灵犀助理</div>
      <div class="muted" style="font-size:13px;line-height:1.9"><div>1 · 打开微信 →「+」→ 扫一扫</div><div>2 · 扫描左侧二维码并确认</div><div>3 · 之后在微信对话框即可直接给助理派活</div></div>
      <div style="display:flex;gap:10px;margin-top:16px"><button class="btn btn-ghost" id="rf">${icon('refresh',{size:15})}刷新</button><button class="btn btn-primary" id="sim" style="background:#16a34a">${icon('phone',{size:15})}模拟扫码绑定</button></div></div></div>`);
  $('#rf',p).onclick=()=>{ $('#qr',p).innerHTML=qrSVG(a.name+Date.now()); toast('二维码已刷新'); };
  $('#sim',p).onclick=()=>{ const s=el(`<div class="muted" style="margin-top:14px;font-size:13px;display:flex;align-items:center;gap:8px"><span class="spin">${icon('refresh',{size:14})}</span>检测到微信扫码，正在确认绑定…</div>`); p.appendChild(s); setTimeout(()=>{ a.boundIM=true; if(imRefresh)imRefresh(); rerenderView(); toast('灵犀助理已成功绑定微信'); },1300); };
  return p;
}
function imBound(){
  const a=ASSISTANT;
  const p=el(`<div>
    <div class="card" style="padding:16px;display:flex;align-items:center;gap:14px;margin-bottom:14px;box-shadow:none"><div style="width:42px;height:42px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:var(--ok-w);color:var(--ok)">${icon('message',{size:20})}</div>
      <div style="flex:1"><div style="font-weight:600;display:flex;align-items:center;gap:8px">已绑定微信 <span class="badge" style="background:var(--ok-w);color:var(--ok)">已生效</span></div><div class="dim" style="font-size:12.5px;margin-top:2px">微信昵称：${a.wxNick} · 绑定于 2026-05-25</div></div>
      <button class="btn btn-ghost" id="unbind" style="color:var(--bad)">解绑</button></div>
    <div class="dim" style="font-size:12px;margin-bottom:8px">在微信里的对话预览</div>
    <div style="background:#ededf0;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px;width:360px;max-width:100%">
      <div style="display:flex;gap:8px"><div style="width:30px;height:30px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:${a.color}">${icon(a.icon,{size:15,color:'#fff'})}</div><div style="background:#fff;color:#1f2937;border-radius:12px;border-top-left-radius:4px;padding:8px 11px;max-width:78%">在的，有什么可以帮你？</div></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><div style="background:#95ec69;color:#1f2937;border-radius:12px;border-top-right-radius:4px;padding:8px 11px;max-width:78%">查下今天的待处理工单</div></div>
      <div style="display:flex;gap:8px"><div style="width:30px;height:30px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:${a.color}">${icon(a.icon,{size:15,color:'#fff'})}</div><div style="background:#fff;color:#1f2937;border-radius:12px;border-top-left-radius:4px;padding:8px 11px;max-width:78%">已让客服专家处理，共 3 个待处理，其中 1 个 P1。要升级吗？</div></div></div></div>`);
  $('#unbind',p).onclick=()=>{ a.boundIM=false; if(imRefresh)imRefresh(); rerenderView(); toast('已解绑微信'); };
  return p;
}

/* ============================ BOOT ============================ */
const isMobile=()=>window.innerWidth<=760;
let _rt; window.addEventListener('resize',()=>{ clearTimeout(_rt); _rt=setTimeout(()=>{ if(STATE.user) render(); },200); });
render();
