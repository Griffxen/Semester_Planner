/* Shared account security, audit history and management workspaces. */
(() => {
  'use strict';
  const mobile=!!window.Mobile, M=window.Mobile;
  const data=()=>mobile?M.data:state;
  const reload=()=>mobile?M.reload():refresh();
  const notify=text=>mobile?M.toast(text):toast(text);
  const transport=mobile?M.api:legacyApi;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const q=(root,selector)=>root.querySelector(selector);
  const month=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date());
  const time=value=>{if(!value)return '—';const d=new Date(typeof value==='number'?value*1000:value);return Number.isNaN(d.valueOf())?String(value):d.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});};
  const bytes=value=>{let n=Number(value)||0;for(const u of ['B','KiB','MiB','GiB','TiB']){if(n<1024||u==='TiB')return `${n.toFixed(u==='B'?0:1)} ${u}`;n/=1024;}};
  const types={task:'任务与节点',journal:'每日手记',category:'分类',settings:'学期设置',course:'个人课程',template:'课表模板',sharing:'分享',user:'账户与权限',auth:'登录认证',security:'安全设置',authentication:'登录认证'};
  const groups={account:'账户操作',task:'任务变更',course:'课程变更',settings:'手记与设置',management:'管理操作'};
  const groupLabel=event=>groups[event.group]||groups[({auth:'account',authentication:'account',user:'account',security:'account',task:'task',category:'task',course:'course',journal:'settings',settings:'settings',sharing:'settings',template:'management'})[event.type]]||types[event.type]||'操作';
  const actions={setup_login:'首次设置登录',credentials_setup_completed:'完成首次设置',create:'新增',update:'修改',delete:'删除',login:'登录',logout:'退出',login_failed:'登录失败',password_verified:'密码验证',password_verification_failed:'密码验证失败',management_locked:'锁定管理区',password_changed:'修改密码',password_reset:'重置密码',pin_changed:'设置PIN',pin_disabled:'关闭PIN',device_trusted:'信任设备',device_revoked:'撤销设备',management_permission_changed:'修改管理权限',token_rotate:'轮换凭据',token_revoke:'撤销凭据'};
  const actionLabel=event=>actions[event.action]||event.label||'操作';
  const field=(label,content,hint='')=>`<label class="pm-field"><span>${esc(label)}</span>${content}${hint?`<small>${esc(hint)}</small>`:''}</label>`;
  const input=(name,attrs='')=>`<input name="${name}" ${attrs}>`;
  const formData=form=>Object.fromEntries(new FormData(form));
  let generation=0,principal='',verifyPromise=null,manageTab='accounts',manageHost=null,designer=null,adminTimer=null,lastCSRF='',lastAuth='';
  const logs=new Set(),secretViews=new Set(),auditFilters=new Map();
  function clearSecrets(root){root.querySelectorAll('input[type=password]').forEach(el=>{el.value='';});}
  function dialog({title,body,submit,onSubmit,wide=false}) {
    let node,close,form;
    const content=`<div class="pm-body">${body}<p class="pm-error" data-pm-error role="alert"></p></div>`;
    if(mobile){node=M.openPage({title,body:submit?`<form class="pm-form">${content}<button class="primary" type="submit">${esc(submit)}</button></form>`:content});close=()=>M.back({force:true});}
    else {node=document.createElement('dialog');node.className=`pm-dialog${wide?' pm-wide':''}`;node.innerHTML=`<div class="dialog-head"><h2>${esc(title)}</h2><button type="button" data-pm-close aria-label="关闭">×</button></div>${submit?`<form class="pm-form">${content}<button class="primary" type="submit">${esc(submit)}</button></form>`:content}`;document.body.append(node);close=()=>node.close();q(node,'[data-pm-close]').onclick=close;node.showModal();}
    if(!node)return null;
    secretViews.add(node);
    const cleanup=()=>{clearSecrets(node);secretViews.delete(node);if(!mobile)node.remove();};
    node.addEventListener(mobile?'mobile:dispose':'close',cleanup,{once:true});
    const observer=new MutationObserver(()=>{if(node.hidden||!node.isConnected)clearSecrets(node);});observer.observe(node,{attributes:true,attributeFilter:['hidden']});
    node.addEventListener(mobile?'mobile:dispose':'close',()=>observer.disconnect(),{once:true});
    form=q(node,'form');
    if(form)form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button[type=submit]');if(button.disabled)return;button.disabled=true;q(node,'[data-pm-error]').textContent='';try{await onSubmit(formData(form),node,close);}catch(error){q(node,'[data-pm-error]').textContent=error.message;}finally{button.disabled=false;}};
    return {node,close};
  }
  async function request(path,method='GET',payload,retry=true) {
    const start=generation,account=data()?String(data().user.id??data().user.name):'';
    try {const result=await transport(path,method,payload);if(path!=='login'&&account&&data()&&String(data().user.id??data().user.name)!==account)throw Error('账户已切换，请重新打开。');if(start!==generation&&method==='GET')throw Error('授权状态已变化，请重新读取。');if(result.csrf&&data())data().csrf=result.csrf;if(result.auth&&data())data().auth=result.auth;return result;}
    catch(error){
      if(error.code==='auth_setup_required'){invalidate();location.replace('/setup/?return='+(mobile?'mobile':'desktop'));throw error;}
      if(error.status===401){invalidate();if(mobile){M.data=null;M.goHome();}throw error;}
      if(retry&&['password_required','management_auth_required','admin_required','admin_auth_required'].includes(error.code)){
        await ensurePassword(error.code==='password_required'?'请验证强密码后继续':'解锁管理工作区',true);
        if(start!==generation)throw Error('账户已切换，请重新打开。');
        return request(path,method,payload,false);
      }
      if(error.code==='strong_password_required')error.message='请先在“登录与安全”中将密码升级为至少12位，再启用此功能。';
      throw error;
    }
  }
  async function ensurePassword(title='验证强密码',force=false) {
    if(!data()||data().preview||data().readonly&&!data().user.viewer)throw Error('当前账户不可执行此操作。');
    if(data().auth?.password_fresh&&!force)return true;
    if(verifyPromise)return verifyPromise;
    verifyPromise=new Promise((resolve,reject)=>{
      let done=false;
      const view=dialog({title,body:field('账户密码',input('password','type="password" required autocomplete="current-password"')),submit:'验证并继续',
        async onSubmit(values,node,close){const response=await request('auth/verify','POST',{password:values.password},false);values.password='';if(response.csrf)data().csrf=response.csrf;if(response.auth)data().auth=response.auth;done=true;await close();await reload();resolve(true);}});
      if(!view){reject(Error('当前页面无法打开验证窗口'));return;}
      view.node.addEventListener(mobile?'mobile:dispose':'close',()=>{if(!done)reject(Error('已取消验证'));},{once:true});
      // Mobile keeps a closed page in its navigation records.
      if(mobile){const watcher=new MutationObserver(()=>{if(view.node.hidden&&!done){watcher.disconnect();reject(Error('已取消验证'));}});watcher.observe(view.node,{attributes:true,attributeFilter:['hidden']});}
    }).finally(()=>{verifyPromise=null;});
    return verifyPromise;
  }
  async function ensureAdmin(){if(!data()?.user.admin)throw Error('当前账户没有管理权限。');if(!data().auth?.admin_unlocked)await ensurePassword('解锁管理工作区',true);if(!data().auth?.admin_unlocked)throw Error('请使用强密码解锁管理工作区。');return true;}
  function invalidate(){generation++;for(const log of logs){log.ticket++;log.host.replaceChildren();}logs.clear();auditFilters.clear();for(const view of secretViews){clearSecrets(view);if(mobile){const body=q(view,'.m-page-body');if(body)body.replaceChildren();}else if(view.open)view.close();}designer?.destroy();designer=null;if(manageHost)manageHost.replaceChildren();principal='';}
  function observe(){
    const s=data(),id=s&&!s.preview?String(s.user.id??s.user.name):'';
    if(principal&&principal!==id)invalidate();principal=id;
    if(!s)return;
    if(lastCSRF&&lastCSRF!==s.csrf){window.PlannerWorkspace?.refreshAuth();}lastCSRF=s.csrf;
    for(const el of document.querySelectorAll('[data-pm-private-entry]'))el.hidden=!!s.readonly;
    for(const el of document.querySelectorAll('[data-pm-admin-entry]'))el.hidden=!!s.readonly||!s.user.admin;
    for(const el of document.querySelectorAll('[data-pm-security-entry]'))el.hidden=!!s.preview;
    for(const log of logs)if(!log.host.isConnected){log.ticket++;logs.delete(log);}
    const auth=s.auth,signature=`${!!s.user.admin}/${!!auth?.admin_unlocked}`;
    if(signature!==lastAuth&&(!s.user.admin||!auth?.admin_unlocked)){if(lastAuth.endsWith('/true'))generation++;designer?.destroy();designer=null;if(manageHost&&!manageHost.hidden)lockedManagement();for(const view of document.querySelectorAll('[data-pm-sensitive]')){const body=q(view,mobile?'.m-page-body':'.pm-body');if(body)body.innerHTML='<p class="pm-empty">管理授权已锁定，请重新验证密码。</p>';}for(const log of logs)if(log.scope==='all'){log.ticket++;log.host.innerHTML='<p class="pm-empty">管理授权已锁定，请重新验证密码。</p>';}}
    lastAuth=signature;
  }
  function textValue(value,field=''){if(['method','auth_method'].includes(field)&&typeof value==='string')return ({password:'密码',pin:'PIN',legacy:'旧会话'})[value]||value;if(value===null||value===undefined)return '（无）';if(typeof value==='boolean')return value?'是':'否';if(typeof value==='object')return JSON.stringify(value,null,2);return String(value);}
  function detailHTML(event){return `<div class="pm-event-meta"><span class="pm-badge">${esc(groupLabel(event))}</span><h3>${esc(event.label||event.summary||actionLabel(event))}</h3><p>${esc(time(event.created_at))} · ${esc(event.actor_name||'系统')} · ${esc(actionLabel(event))}</p>${event.owner_name?`<p>数据所属：${esc(event.owner_name)}</p>`:''}<small>请求编号 ${esc(event.request_id||'—')}</small></div><div class="pm-differences">${(event.changes||[]).map(change=>`<section class="pm-difference"><h4>${esc(change.label||change.field)}</h4><div class="pm-diff-grid"><div><span>修改前</span><pre>${esc(textValue(change.before,change.field))}</pre></div><div><span>修改后</span><pre>${esc(textValue(change.after,change.field))}</pre></div></div></section>`).join('')||'<p class="pm-muted">无字段明细。</p>'}</div>`;}
  async function openDetail(id,scope='mine'){const start=generation;try{const result=await request(`audit/events/${encodeURIComponent(id)}?scope=${encodeURIComponent(scope)}`);if(start!==generation)return;const view=dialog({title:'操作详情',body:detailHTML(result.event),wide:true});if(view&&scope==='all')view.node.dataset.pmSensitive='';}catch(error){notify(error.message);}}
  function audit(host,scope='mine') {
    const controller={host,scope,ticket:0,cursor:null,snapshot:null,rows:[],filters:{month:month(),group:'',action:'',q:'',user_id:'',...(auditFilters.get(scope)||{})}};logs.add(controller);
    const controls=()=>`<form class="pm-filters"><label>月份<input type="month" name="month" required value="${esc(controller.filters.month)}"></label><label>业务类型<select name="group"><option value="">全部类型</option>${Object.entries(groups).map(([key,label])=>`<option value="${key}" ${controller.filters.group===key?'selected':''}>${label}</option>`).join('')}</select></label><label>动作<select name="action"><option value="">全部动作</option>${Object.entries(actions).map(([key,label])=>`<option value="${key}" ${controller.filters.action===key?'selected':''}>${label}</option>`).join('')}</select></label><label class="pm-search">关键词<input name="q" type="search" maxlength="100" value="${esc(controller.filters.q)}" placeholder="搜索对象或操作"></label>${scope==='all'?'<label>账户<select name="user_id"><option value="">全部账户</option></select></label>':''}<button class="primary" type="submit">查询</button></form>`;
    host.innerHTML=`<div class="pm-audit"><div class="pm-toolbar"><div class="pm-actions"><button type="button" data-export="csv">导出 CSV</button><button type="button" data-export="json">导出 JSON</button></div></div>${controls()}<div class="pm-months" aria-label="历史月份"></div><p class="pm-meta" data-summary></p><div class="pm-events" aria-live="polite"></div><p class="pm-error" data-error role="alert"></p><button type="button" class="pm-more" data-more hidden>加载更多</button></div>`;
    const root=q(host,'.pm-audit'),form=q(root,'form'),list=q(root,'.pm-events'),more=q(root,'[data-more]'),error=q(root,'[data-error]');
    const query=()=>new URLSearchParams(Object.entries({...controller.filters,scope,limit:'50',...(controller.snapshot!==null?{snapshot_id:controller.snapshot}:{})}).filter(([,value])=>value!==''));
    const renderRows=()=>{
      let previous='';list.innerHTML=controller.rows.map(event=>{const day=time(event.created_at).split(' ')[0],heading=day!==previous?`<h3 class="pm-day">${esc(day)}</h3>`:'';previous=day;return heading+`<button type="button" class="pm-event" data-event="${event.id}"><span class="pm-event-time">${esc(time(event.created_at).split(' ').slice(1).join(' ')||time(event.created_at))}</span><span class="pm-event-copy"><strong>${esc(event.label||event.summary||actionLabel(event))}</strong><span>${esc(event.actor_name||'系统')} · ${esc(groupLabel(event))} · ${esc(event.summary||actionLabel(event))}</span></span><span class="pm-event-arrow" aria-hidden="true">›</span></button>`;}).join('')||'<p class="pm-empty">无匹配记录。</p>';
      q(root,'[data-summary]').textContent=`${controller.filters.month} · 已显示 ${controller.rows.length} 条${controller.cursor?'，还有更多记录':''}`;more.hidden=!controller.cursor;
    };
    async function load(append=false){const ticket=++controller.ticket,identity=generation;error.textContent='';more.disabled=true;if(!append){controller.rows=[];controller.cursor=null;controller.snapshot=null;list.innerHTML='<p class="pm-empty" role="status">正在读取操作记录…</p>';}
      try{const params=query();if(append&&controller.cursor)params.set('cursor',controller.cursor);const result=await request(`audit/events?${params}`);if(ticket!==controller.ticket||identity!==generation)return;controller.snapshot=result.snapshot_id;controller.cursor=result.next_cursor;controller.rows.push(...result.events);renderRows();}
      catch(err){if(ticket!==controller.ticket||identity!==generation)return;if(!append)list.replaceChildren();error.textContent=err.message;}
      finally{if(ticket===controller.ticket)more.disabled=false;}
    }
    form.onsubmit=event=>{event.preventDefault();controller.filters={...controller.filters,...formData(form)};auditFilters.set(scope,{...controller.filters});load();};more.onclick=()=>load(true);
    list.onclick=event=>{const button=event.target.closest('[data-event]');if(button)openDetail(button.dataset.event,scope);};
    root.querySelectorAll('[data-export]').forEach(button=>button.onclick=async()=>{button.disabled=true;error.textContent='';try{const params=query();params.set('format',button.dataset.export);const response=await fetch(`/api/audit/export?${params}`,{credentials:'same-origin'});if(!response.ok){let body=await response.json();throw Error(body.error||'导出失败');}if(generation!==identityAtMount)throw Error('账户已切换，请重新导出。');const blob=await response.blob();if(generation!==identityAtMount)throw Error('账户已切换，请重新导出。');const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=`planner-audit-${controller.filters.month}-${scope}.${button.dataset.export}`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(err){error.textContent=err.message;}finally{button.disabled=false;}});
    const identityAtMount=generation;
    request(`audit/months?scope=${scope}`).then(result=>{if(identityAtMount!==generation||!host.contains(root))return;q(root,'.pm-months').innerHTML=(result.months||[]).slice(0,18).map(item=>`<button type="button" data-month="${esc(item.month)}">${esc(item.month)} <small>${item.count}</small></button>`).join('');q(root,'.pm-months').onclick=event=>{const button=event.target.closest('[data-month]');if(button){form.elements.month.value=button.dataset.month;form.requestSubmit();}};}).catch(()=>{});
    if(scope==='all')request('users').then(result=>{if(identityAtMount!==generation||!host.contains(root))return;form.elements.user_id.innerHTML='<option value="">全部账户</option>'+(result.accounts||[]).map(user=>`<option value="${user.id}">${esc(user.remark||user.name)} · @${esc(user.name)}</option>`).join('');form.elements.user_id.value=controller.filters.user_id;}).catch(()=>{});
    load();return controller;
  }
  async function confirmAction(message){return mobile?M.confirm(message,'确认操作'):askConfirm(message);}
  function accountForm(action,account,after){
    const create=action==='create';
    const view=dialog({title:create?'创建普通账户':`重置 ${account.name} 的密码`,body:field('用户名',input('name',`required maxlength="64" autocomplete="off" value="${esc(account?.name||'')}"${create?'':' readonly'}`))+field('新强密码',input('password','type="password" required minlength="12" maxlength="256" autocomplete="new-password"'),'至少12位，支持密码管理器。')+field('确认新密码',input('confirm','type="password" required minlength="12" autocomplete="new-password"')),submit:create?'创建账户':'重置密码',async onSubmit(values,node,close){if(values.password!==values.confirm)throw Error('两次密码不一致');await ensurePassword(create?'验证后创建账户':'验证后重置密码');await request('users','POST',{action,name:values.name,password:values.password});clearSecrets(node);await close();notify(create?'账户已创建':'密码已重置，原会话与设备信任已撤销');after();}});if(view)view.node.dataset.pmSensitive='';
  }
  async function renderAccounts(host){
    host.innerHTML='<p class="pm-empty">正在读取账户…</p>';const token=generation;
    try{const response=await request('users');if(token!==generation)return;const rows=response.accounts||[];
      host.innerHTML=`<div class="pm-toolbar"><p class="pm-muted">共 ${rows.length} 个账户</p><button class="primary" data-create>创建普通账户</button></div><label class="pm-field">搜索账户<input type="search" data-search placeholder="用户名、备注或所有者"></label><div class="pm-accounts"></div><div class="pm-actions"><button data-viewers>展示账户创建与绑定</button></div><p class="pm-error" data-error role="alert"></p>`;
      const render=()=>{const query=q(host,'[data-search]').value.toLocaleLowerCase();q(host,'.pm-accounts').innerHTML=rows.filter(user=>[user.name,user.remark,user.owner_name].join(' ').toLocaleLowerCase().includes(query)).map(user=>`<article class="pm-account"><div><strong>${esc(user.remark||user.name)}</strong><p>@${esc(user.name)} · ${user.root_admin?'根管理员':user.role==='viewer'?'展示账户':user.admin?'拥有管理权限':'普通账户'}${user.owner_name?' · 所有者 '+esc(user.owner_name):''}</p></div><div class="pm-actions">${user.root_admin?((String(user.id)===String(data().user.id)||user.name===data().user.name)?'<button data-root-security>登录与安全</button>':''):`<button data-reset="${user.id}">重置密码</button>${user.role!=='viewer'?`<button data-permission="${user.id}" class="${user.admin?'soft-danger':''}">${user.admin?'撤销管理权限':'授予管理权限'}</button>`:''}`}</div></article>`).join('')||'<p class="pm-empty">没有匹配账户。</p>';};render();q(host,'[data-search]').oninput=render;
      q(host,'[data-create]').onclick=()=>accountForm('create',null,()=>renderAccounts(host));
      q(host,'[data-viewers]').onclick=async()=>{try{await ensureAdmin();if(mobile)M.openAccounts();else{document.querySelector('#accounts-button').dispatchEvent(new CustomEvent('pm:original-accounts'));}}catch(err){q(host,'[data-error]').textContent=err.message;}};
      q(host,'.pm-accounts').onclick=async event=>{if(event.target.closest('[data-root-security]')){openSecurity();return;}const reset=event.target.closest('[data-reset]'),permission=event.target.closest('[data-permission]'),user=rows.find(item=>String(item.id)===(reset?.dataset.reset||permission?.dataset.permission));if(!user||user.root_admin)return;if(reset){accountForm('reset',user,()=>renderAccounts(host));return;}
        if(permission){try{if(!await confirmAction(`${user.admin?'撤销':'授予'}「${user.name}」的管理权限？`))return;await ensurePassword('验证后修改管理权限');await request(`admin/users/${user.id}/permission`,'PUT',{admin:!user.admin});await reload();if(data().auth?.admin_unlocked)renderAccounts(host);else lockedManagement();}catch(err){q(host,'[data-error]').textContent=err.message;}}};
    }catch(err){if(token===generation)host.innerHTML=`<p class="pm-error">${esc(err.message)}</p><button data-retry>重新读取</button>`;q(host,'[data-retry]')?.addEventListener('click',()=>renderAccounts(host));}
  }
  function renderApiReads(host){
    const controller={host,scope:'all',ticket:0,cursor:null,snapshot:null,events:[],filters:{month:month(),endpoint:'',viewer_id:'',...(auditFilters.get('api')||{})}};logs.add(controller);
    host.innerHTML=`<section class="pm-api-reads"><div class="pm-toolbar"><div class="pm-actions"><button type="button" data-api-export="csv" disabled>导出 CSV</button><button type="button" data-api-export="json" disabled>导出 JSON</button></div></div><form class="pm-filters pm-api-filters"><label>月份<input type="month" name="month" required value="${esc(controller.filters.month)}"></label><label>接口<select name="endpoint"><option value="">全部接口</option><option value="agenda" ${controller.filters.endpoint==='agenda'?'selected':''}>日程 /agenda</option><option value="meta" ${controller.filters.endpoint==='meta'?'selected':''}>元数据 /meta</option></select></label><label>展示账户<select name="viewer_id"><option value="">全部账户</option></select></label><button class="primary" type="submit">查询</button></form><div class="pm-api-summary" data-api-summary></div><section class="pm-card pm-api-daily"><div class="pm-chart-heading"><h3>每日调用</h3><div class="pm-bar-legend"><span><i class="pm-api-success" aria-hidden="true"></i>成功</span><span><i class="pm-api-failure" aria-hidden="true"></i>失败</span></div></div><div data-api-daily></div></section><section class="pm-card pm-api-records"><div class="pm-chart-heading"><h3>最近读取</h3><span data-api-count></span></div><div class="pm-api-row pm-api-table-head" aria-hidden="true"><span>时间</span><span>接口</span><span>调用账户</span><span>状态</span><span>耗时</span><span>返回数量</span></div><div data-api-events aria-live="polite"></div><p class="pm-error" data-api-error role="alert"></p><button type="button" class="pm-more" data-api-more hidden>加载更多</button></section></section>`;
    const form=q(host,'form'),list=q(host,'[data-api-events]'),error=q(host,'[data-api-error]'),more=q(host,'[data-api-more]'),identity=generation;
    const query=()=>new URLSearchParams(Object.entries({...controller.filters,limit:'50',...(controller.snapshot!==null?{snapshot_id:controller.snapshot}:{})}).filter(([,value])=>value!==''));
    const milliseconds=value=>`${(Number(value)||0).toFixed(1)} ms`;
    function renderSummary(summary,daily){
      const total=Number(summary.total)||0,success=Number(summary.success)||0,rate=total?`${(success/total*100).toFixed(1)}%`:'—';
      q(host,'[data-api-summary]').innerHTML=[['调用次数',total],['成功率',rate],['平均耗时',milliseconds(summary.average_ms)],['失败次数',Number(summary.failed)||0]].map(([label,value])=>`<article class="pm-stat"><span>${label}</span><strong>${esc(value)}</strong></article>`).join('');
      const days=daily||[],max=Math.max(1,...days.map(day=>Number(day.total)||0));
      q(host,'[data-api-daily]').innerHTML=days.map((day,index)=>`<div class="pm-api-day"><time>${esc(day.date.slice(5))}</time><div class="pm-month-track"><div class="pm-api-day-fill" data-api-day="${index}" title="${esc(`${day.date} · 成功 ${day.success} · 失败 ${day.failed}`)}"><span class="pm-api-success" data-api-success></span><span class="pm-api-failure" data-api-failed></span></div></div><span>${day.total} 次</span></div>`).join('')||'<p class="pm-empty">暂无调用。</p>';
      host.querySelectorAll('[data-api-day]').forEach(element=>{const day=days[Number(element.dataset.apiDay)],n=Number(day.total)||0;element.style.width=`${n/max*100}%`;q(element,'[data-api-success]').style.width=`${n?(Number(day.success)||0)/n*100:0}%`;q(element,'[data-api-failed]').style.width=`${n?(Number(day.failed)||0)/n*100:0}%`;});
    }
    function renderRows(){
      list.innerHTML=controller.events.map(event=>{const success=Number(event.status)>=200&&Number(event.status)<300,endpoint=String(event.endpoint).replace('/api/v1/','').replace(/^\//,'');return `<article class="pm-api-row" title="${esc(event.request_id||'')}"><time class="pm-api-time">${esc(time(event.created_at))}</time><span class="pm-api-endpoint">${esc(event.method||'GET')} /${esc(endpoint)}</span><span class="pm-api-account">${esc(event.viewer_name||(event.viewer_id?'账户 '+event.viewer_id:'未认证'))}</span><span class="pm-api-status ${success?'is-success':'is-failure'}">${Number(event.status)||'—'}</span><span class="pm-api-timing">${milliseconds(event.duration_ms)}</span><span class="pm-api-counts">${event.task_count==null&&event.course_count==null?'—':`任务 ${event.task_count??'—'} · 课程 ${event.course_count??'—'}`}</span></article>`;}).join('')||'<p class="pm-empty">无匹配记录。</p>';
      q(host,'[data-api-count]').textContent=`已显示 ${controller.events.length} 条`;more.hidden=!controller.cursor;
    }
    async function load(append=false){
      const ticket=++controller.ticket,start=generation;error.textContent='';more.disabled=true;
      if(!append){controller.events=[];controller.cursor=null;controller.snapshot=null;list.innerHTML='<p class="pm-empty">正在读取…</p>';host.querySelectorAll('[data-api-export]').forEach(button=>{button.disabled=true;});}
      try{const params=query();if(append&&controller.cursor)params.set('cursor',controller.cursor);const result=await request(`admin/api-reads?${params}`);if(ticket!==controller.ticket||start!==generation||!host.isConnected)return;controller.snapshot=result.snapshot_id;controller.cursor=result.next_cursor;controller.events.push(...(result.events||[]));if(!append)renderSummary(result.summary||{},result.daily);renderRows();host.querySelectorAll('[data-api-export]').forEach(button=>{button.disabled=false;});}
      catch(err){if(ticket!==controller.ticket||start!==generation)return;if(!append)list.replaceChildren();error.textContent=err.message;}
      finally{if(ticket===controller.ticket)more.disabled=false;}
    }
    form.onsubmit=event=>{event.preventDefault();controller.filters={...controller.filters,...formData(form)};auditFilters.set('api',{...controller.filters});load();};more.onclick=()=>load(true);
    host.querySelectorAll('[data-api-export]').forEach(button=>{button.onclick=async()=>{button.disabled=true;error.textContent='';try{const params=query();params.set('format',button.dataset.apiExport);const response=await fetch(`/api/admin/api-reads/export?${params}`,{credentials:'same-origin'});if(!response.ok){const body=await response.json();throw Error(body.error||'导出失败');}const blob=await response.blob();if(generation!==identity)throw Error('授权状态已变化，请重新读取。');const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=`planner-api-reads-${controller.filters.month}.${button.dataset.apiExport}`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(err){error.textContent=err.message;}finally{button.disabled=false;}};});
    request('users').then(result=>{if(identity!==generation||!host.isConnected)return;form.elements.viewer_id.innerHTML='<option value="">全部账户</option>'+(result.accounts||[]).filter(user=>user.role==='viewer').map(user=>`<option value="${user.id}">${esc(user.remark||user.name)}</option>`).join('');form.elements.viewer_id.value=controller.filters.viewer_id;}).catch(()=>{});
    load();
  }
  async function renderStorage(host){
    host.innerHTML='<p class="pm-empty">正在统计存储用量…</p>';const token=generation;
    try{
      const result=await request('admin/storage');if(token!==generation)return;
      const total=Math.max(0,Number(result.filesystem?.total_bytes)||0),free=Math.max(0,Number(result.filesystem?.free_bytes)||0),available=Math.max(0,Number(result.filesystem?.available_bytes)||0);
      const disk=[{key:'used',label:'已用',value:Math.max(0,total-free)},{key:'reserved',label:'预留',value:Math.max(0,free-available)},{key:'available',label:'可用',value:available}];
      const planner=[{key:'database',label:'数据库',value:Math.max(0,Number(result.database?.bytes)||0)},{key:'backups',label:'备份',value:Math.max(0,Number(result.backups?.bytes)||0)}];
      const plannerTotal=planner.reduce((sum,item)=>sum+item.value,0),months=result.audit?.months||[];
      const stacked=(items,name)=>`<div class="pm-stacked-bar" role="img" aria-label="${esc(items.map(item=>item.label+' '+bytes(item.value)).join('，'))}">${items.map(item=>`<span class="pm-segment pm-segment-${item.key}" data-segment="${name}-${item.key}" title="${esc(item.label+' '+bytes(item.value))}"></span>`).join('')}</div><div class="pm-bar-legend">${items.map(item=>`<span><i class="pm-segment-${item.key}" aria-hidden="true"></i>${item.label}<strong>${bytes(item.value)}</strong></span>`).join('')}</div>`;
      host.innerHTML=`<div class="pm-capacity-grid"><section class="pm-card pm-chart-card"><div class="pm-chart-heading"><h3>磁盘空间</h3><span>${bytes(total)}</span></div>${stacked(disk,'disk')}</section><section class="pm-card pm-chart-card"><div class="pm-chart-heading"><h3>Planner用量</h3><span>${bytes(plannerTotal)}</span></div>${stacked(planner,'planner')}<p class="pm-chart-note">日志计入数据库</p></section></div><section class="pm-card pm-month-chart"><div class="pm-chart-heading"><div><h3>每月操作日志</h3><span>${result.audit?.count||0} 条 · ${bytes(result.audit?.payload_bytes)}</span></div><div class="pm-metric-toggle" aria-label="日志图表量纲"><button type="button" data-metric="bytes" class="active" aria-pressed="true">空间</button><button type="button" data-metric="count" aria-pressed="false">条数</button></div></div><div class="pm-month-bars">${months.map((item,index)=>`<div class="pm-month-chart-row"><strong>${esc(item.month)}</strong><div class="pm-month-track"><span data-month-index="${index}"></span></div><span class="pm-month-value">${bytes(item.payload_bytes)} · ${item.count} 条</span></div>`).join('')||'<p class="pm-empty">暂无操作记录。</p>'}</div></section><div class="pm-storage-footer"><span>${result.backups?.count||0} 份备份 · 日备30天 · 月备12个月 · API读取 ${result.api_reads?.count||0} 次</span><button data-refresh-storage>重新统计</button></div>`;
      for(const [name,items,sum] of [['disk',disk,total],['planner',planner,plannerTotal]])for(const item of items){const element=q(host,`[data-segment="${name}-${item.key}"]`);element.style.width=`${sum?Math.min(100,item.value/sum*100):0}%`;}
      const showMetric=metric=>{
        const value=item=>Number(metric==='count'?item.count:item.payload_bytes)||0,max=Math.max(1,...months.map(value));
        host.querySelectorAll('[data-month-index]').forEach(element=>{const item=months[Number(element.dataset.monthIndex)],amount=value(item);element.style.width=`${amount/max*100}%`;element.title=metric==='count'?`${amount} 条`:bytes(amount);element.parentElement.setAttribute('aria-label',`${item.month}，${element.title}`);});
        host.querySelectorAll('[data-metric]').forEach(button=>{const active=button.dataset.metric===metric;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
      };
      showMetric('bytes');q(host,'.pm-metric-toggle').onclick=event=>{const button=event.target.closest('[data-metric]');if(button)showMetric(button.dataset.metric);};q(host,'[data-refresh-storage]').onclick=()=>renderStorage(host);
    }catch(err){if(token===generation)host.innerHTML=`<p class="pm-error">${esc(err.message)}</p>`;}
  }
  function lockedManagement(){if(!manageHost)return;manageHost.innerHTML='<section class="pm-card pm-lock"><h2>管理工作区已锁定</h2><p class="pm-muted">验证强密码后继续。</p><button class="primary" data-unlock>解锁管理工作区</button></section>';q(manageHost,'[data-unlock]').onclick=async()=>{try{await ensureAdmin();renderManagement(manageHost);}catch(err){notify(err.message);}};}
  async function renderManagement(host){manageHost=host;const token=generation;
    if(!data()?.auth?.admin_unlocked){lockedManagement();return;}
    host.innerHTML=`<div class="pm-toolbar pm-management-toolbar">${mobile?'':'<div><h1 class="pm-title">管理工作区</h1></div>'}<button data-lock>锁定管理区</button></div><nav class="pm-tabs" aria-label="管理功能">${[['accounts','账户与权限'],['templates','课表模板'],['audit','全站日志'],['api','API读取'],['storage','存储用量']].map(([id,label])=>`<button type="button" data-manage-tab="${id}" aria-selected="${manageTab===id}" class="${manageTab===id?'active':''}">${label}</button>`).join('')}</nav><div class="pm-management-body"></div>`;
    const body=q(host,'.pm-management-body');q(host,'[data-lock]').onclick=async()=>{try{await request('auth/admin','DELETE',{});await reload();lockedManagement();}catch(err){notify(err.message);}};
    q(host,'.pm-tabs').onclick=async event=>{const button=event.target.closest('[data-manage-tab]');if(!button||button.dataset.manageTab===manageTab)return;if(designer?.isBusy()){notify('正在保存课表，请稍候');return;}if(designer?.isDirty()&&!await confirmAction('离开课表设计？未提交草稿会保留在此浏览器。'))return;designer?.destroy();designer=null;manageTab=button.dataset.manageTab;renderManagement(host);};
    if(manageTab==='accounts')renderAccounts(body);
    else if(manageTab==='audit')audit(body,'all');
    else if(manageTab==='api')renderApiReads(body);
    else if(manageTab==='storage')renderStorage(body);
    else {body.innerHTML='<div class="pm-template-host"></div>';
      if(window.CourseDesigner){try{const instance=await CourseDesigner.mount(q(body,'.pm-template-host'),{session:data(),onSaved:()=>reload(),onNavigate:()=>mobile?M.back():PlannerWorkspace.show('home')});if(token!==generation||manageTab!=='templates'||!body.isConnected){instance.destroy();return;}designer=instance;await instance.open({personal:false});}catch(err){body.textContent=err.message;}}
      else body.innerHTML='<a href="/timetables/">打开课表模板</a>';
    }
  }
  function openSecurity(){if(!data()||data().preview)return;const view=dialog({title:'登录与安全',body:'<div class="pm-security"></div>',wide:true});if(!view)return;renderSecurity(q(view.node,'.pm-security'));}
  async function renderSecurity(host){const s=data();if(!s||s.preview)return;const canManageOwnSecurity=!s.readonly||!!s.user.viewer;
    host.innerHTML=`<section class="pm-card"><h3>强密码与快捷 PIN</h3><p class="pm-muted">PIN 4–6位 · 设备信任30天 · 规划登录7天</p><p>当前登录：<strong>${s.auth?.method==='pin'?'PIN快捷登录':s.auth?.method==='legacy'?'旧会话':'密码登录'}</strong> · ${s.auth?.pin_enabled?'PIN已设置':'尚未设置PIN'} · ${s.auth?.trusted_device?'此设备已信任':'此设备未信任'}</p><div class="pm-actions"><button data-password>修改／升级强密码</button>${canManageOwnSecurity?`<button data-pin>${s.auth?.pin_enabled?'修改PIN':'设置PIN'}</button>${s.auth?.pin_enabled?'<button class="soft-danger" data-pin-clear>关闭PIN</button>':''}`:''}</div></section>${canManageOwnSecurity?'<section class="pm-card"><h3>已信任设备</h3><p class="pm-muted">撤销信任会退出关联会话。</p><button data-trust>信任当前设备</button><div data-devices></div></section>':''}<p class="pm-error" data-error role="alert"></p>`;
    q(host,'[data-password]').onclick=()=>dialog({title:'修改强密码',body:field('当前密码',input('current_password','type="password" required autocomplete="current-password"'))+field('新强密码',input('password','type="password" required minlength="12" maxlength="256" autocomplete="new-password"'),'至少12位，支持密码管理器。')+field('确认新密码',input('confirm','type="password" required minlength="12" autocomplete="new-password"')),submit:'修改密码并重新登录',async onSubmit(values,node,close){if(values.password!==values.confirm)throw Error('两次密码不一致');await request('auth/password','POST',{current_password:values.current_password,password:values.password},false);clearSecrets(node);await close();invalidate();if(mobile){M.data=null;M.goHome();await M.reload();}else{state=null;document.querySelector('#app').hidden=true;document.querySelector('#login').hidden=false;window.DesktopModal?.reset();}notify('密码已更新，请重新登录。');}});
    if(!canManageOwnSecurity)return;
    q(host,'[data-pin]').onclick=()=>dialog({title:s.auth?.pin_enabled?'修改快捷PIN':'设置快捷PIN',body:field('4–6位数字PIN',input('pin','type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" required autocomplete="new-password"'),'4–6位数字，保留开头的0。')+field('确认PIN',input('confirm','type="password" inputmode="numeric" pattern="[0-9]{4,6}" minlength="4" maxlength="6" required autocomplete="new-password"')),submit:'保存PIN',async onSubmit(values,node,close){if(values.pin!==values.confirm)throw Error('两次PIN不一致');await ensurePassword('验证强密码后设置PIN');await request('auth/pin','PUT',{pin:values.pin});clearSecrets(node);await close();await reload();renderSecurity(host);notify('PIN已保存，请确认当前设备已信任。');}});
    q(host,'[data-pin-clear]')?.addEventListener('click',async()=>{try{if(!await confirmAction('关闭PIN并撤销关联的设备信任和PIN会话？'))return;await ensurePassword('验证强密码后关闭PIN');await request('auth/pin','DELETE',{});await reload();renderSecurity(host);}catch(err){q(host,'[data-error]').textContent=err.message;}});
    q(host,'[data-trust]').onclick=()=>dialog({title:'信任当前设备',body:field('设备名称',input('label','required maxlength="80" placeholder="如：我的笔记本／手机"'))+'<p class="pm-muted">仅信任自己的设备，30天到期。</p>',submit:'验证并信任此设备',async onSubmit(values,node,close){await ensurePassword('验证强密码后信任设备');await request('auth/devices','POST',{label:values.label});await close();await reload();renderSecurity(host);notify('当前设备已信任。');}});
    try{const result=await request('auth/devices'),devices=result.devices||[];if(!host.isConnected)return;q(host,'[data-devices]').innerHTML=devices.map(device=>`<article class="pm-device"><div><strong>${esc(device.label||device.name||'已信任设备')}${device.current?' · 当前设备':''}</strong><p class="pm-muted">到期 ${esc(time(device.expires_at||device.expires))}</p></div><button data-revoke="${esc(device.id)}">撤销信任</button></article>`).join('')||'<p class="pm-muted">尚无已信任设备。</p>';q(host,'[data-devices]').onclick=async event=>{const button=event.target.closest('[data-revoke]');if(!button)return;try{if(!await confirmAction('撤销此设备信任？关联会话会立即失效。'))return;await ensurePassword('验证后撤销设备信任');await request(`auth/devices/${encodeURIComponent(button.dataset.revoke)}`,'DELETE',{});await reload();renderSecurity(host);}catch(err){q(host,'[data-error]').textContent=err.message;}};}catch(err){q(host,'[data-error]').textContent=err.message;}
  }
  async function showAudit(){if(mobile){const view=dialog({title:'操作日志',body:'<div class="pm-personal-audit"></div>',wide:true});if(view)audit(q(view.node,'.pm-personal-audit'));}else await PlannerWorkspace.show('audit');}
  async function showManagement(){try{await ensureAdmin();if(mobile){const view=dialog({title:'管理工作区',body:'<div class="pm-management"></div>',wide:true});if(view)renderManagement(q(view.node,'.pm-management'));}else await PlannerWorkspace.show('manage');}catch(err){notify(err.message);}}
  function setupLogin(){
    const form=document.querySelector(mobile?'#m-login-form':'#login-form');if(!form)return;
    const secret=form.elements.password,caption=secret.closest('label');secret.name='credential';secret.maxLength=256;caption.childNodes.forEach(node=>{if(node.nodeType===Node.TEXT_NODE&&node.textContent.trim())node.textContent='密码或PIN';});secret.placeholder='强密码，或已信任设备上的4–6位PIN';
    const help=document.createElement('p');help.className='pm-login-hint';help.textContent='PIN进入规划 · 密码可进入管理';form.append(help);
    form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button[type=submit],button.primary');if(button.disabled)return;button.disabled=true;const error=document.querySelector(mobile?'#m-login-error':'#login-error');error.textContent='';try{const result=await request('login','POST',formData(form),false);if(result.setup_required||result.auth?.setup_required){clearSecrets(form);invalidate();location.replace('/setup/?return='+(mobile?'mobile':'desktop'));return;}if(!mobile)previewId=null;await reload();clearSecrets(form);if(data()?.user.admin&&data().auth?.strong_password&&data().auth?.method!=='pin'){
        const view=dialog({title:'进入工作台',body:'<div class="pm-choice"><button type="button" data-plan><strong>个人规划</strong></button><button type="button" data-manage><strong>管理工作区</strong></button></div>'});q(view.node,'[data-plan]').onclick=async()=>{await view.close();if(!mobile)PlannerWorkspace.show('home');};q(view.node,'[data-manage]').onclick=async()=>{await view.close();showManagement();};
      }else if(!mobile)PlannerWorkspace.show('home');
    }catch(err){error.textContent=err.message;}finally{button.disabled=false;}};
  }
  function setupDesktop(){
    const register=(page,title,admin=false)=>{const section=document.createElement('section');section.className='pm-workspace';const button=document.createElement('button');button.type='button';button.textContent=title;button.dataset.icon=admin?'users':'book';button.setAttribute(admin?'data-pm-admin-entry':'data-pm-private-entry','');PlannerWorkspace.register(page,{section,button,admin,beforeShow:async()=>{if(!data()||data().readonly)return false;if(admin)try{return await ensureAdmin();}catch(err){notify(err.message);return false;}return true;},onShow:()=>{if(admin)return renderManagement(section);section.innerHTML='<div class="workspace-heading"><div><h1>操作日志</h1></div></div><div class="pm-log-host"></div>';audit(q(section,'.pm-log-host'));}});};
    register('audit','操作日志');register('manage','管理工作区',true);
    const account=document.querySelector('#account-button'),entry=document.createElement('button');entry.type='button';entry.textContent='登录与安全';entry.dataset.icon='lock';entry.setAttribute('data-pm-security-entry','');account.after(entry);entry.onclick=openSecurity;
    const accounts=document.querySelector('#accounts-button'),original=accounts.onclick;accounts.addEventListener('pm:original-accounts',()=>original.call(accounts));accounts.onclick=showManagement;
    const previous=render;render=function(...args){previous(...args);observe();};
    api=async(path,method='GET',payload)=>{if(path==='password'&&method!=='GET'&&!data()?.auth?.password_fresh){let password=await identityPassword('修改账户强密码，所有设备将退出登录');try{return await request(path,method,{...payload,current_password:password},false);}finally{password='';}}return request(path,method,payload);};
    const oldUpdate=updateAccountAction;updateAccountAction=function(){oldUpdate();const form=document.querySelector('#account-form');form.elements.password.minLength=12;const caption=document.querySelector('#account-password-caption');if(caption&&caption.textContent.includes('新密码'))caption.textContent='新强密码（至少12位）';};
    for(const input of document.querySelectorAll('#account-form [name=password],#share-admin-form [name=password]'))input.minLength=12;
  }
  function setupMobile(){
    const originalOpen=M.openAccount;M.openAccount=()=>{originalOpen();const page=document.querySelector('#m-pages>.m-page:not([hidden])');if(page){const button=document.createElement('button');button.className='m-button';button.textContent='登录与安全';button.onclick=openSecurity;q(page,'.m-page-body').append(button);}};
    M.openAudit=showAudit;M.openManagement=showManagement;M.openSecurity=openSecurity;
    let openManagementOnLoad=new URLSearchParams(location.search).get('workspace')==='manage';
    const originalReload=M.reload;M.reload=async()=>{await originalReload();observe();if(openManagementOnLoad&&data()?.user.admin){openManagementOnLoad=false;const url=new URL(location.href);url.searchParams.delete('workspace');history.replaceState(history.state,'',url);queueMicrotask(showManagement);}};
    const originalAccounts=M.openAccounts;M.openAccounts=async()=>{try{await ensureAdmin();return originalAccounts();}catch(err){notify(err.message);}};
    window.addEventListener('mobile:data',observe);
    document.addEventListener('DOMContentLoaded',setupLogin);
  }
  window.PlannerManagement={request,ensurePassword,ensureAdmin,showAudit,showManagement,openSecurity,invalidate};
  if(mobile)setupMobile();else{setupDesktop();setupLogin();}
  adminTimer=setInterval(async()=>{let s=data();if(!s)return;const managementVisible=manageHost?.isConnected&&!manageHost.closest('[hidden]')||[...document.querySelectorAll('[data-pm-sensitive]')].some(view=>!view.closest('[hidden]'));if(s.auth?.admin_unlocked&&managementVisible&&!document.hidden){try{const identity=generation,name=String(s.user.id??s.user.name),response=await transport('auth/context');if(identity===generation&&data()&&String(data().user.id??data().user.name)===name){if(response.auth)data().auth=response.auth;if(response.csrf)data().csrf=response.csrf;}}catch(_){}}s=data();if(!s)return;observe();const expires=s.auth?.admin_expires;if(s.auth?.admin_unlocked&&expires&&Date.now()/1000>=Number(expires)){s.auth.admin_unlocked=false;observe();}},15000);
})();
