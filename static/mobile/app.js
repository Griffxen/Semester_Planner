/* Independent touch shell. The desktop domain client is deliberately not loaded. */
(function () {
  'use strict';
  const D = MobileDomain, {esc,today,add,monday,formatDate,taskWhen} = D;
  const BUSY_START=8*60, BUSY_END=24*60, BUSY_SPAN=BUSY_END-BUSY_START;
  const M = window.Mobile = {data:null};
  const ui = {tab:'agenda',date:today(),overview:'week',filters:{category:'',query:'',hideDone:false,showCourses:true}};
  let session = Math.random().toString(36).slice(2);
  const records = [];
  let index=0, pending=false, saving=false, allowPop=false, confirmation=null, toastTimer, beforePreviewFilters=null;
  const backWaiters=[];
  const $ = selector => document.querySelector(selector);
  M.utils = {...D,allowedDate:date=>D.allowedDate(M.data,date),filteredTasks:()=>D.filteredTasks(M.data,ui.filters),categoryStyle:()=>''};
  M.filteredTasks = (data=M.data) => D.filteredTasks(data,ui.filters);
  M.filteredCourses = (data=M.data) => ui.filters.showCourses?(data.course_dates||[]).filter(c=>!c.cancelled):[];
  M.exportFilterLabel = () => [ui.filters.category||'全部分类',ui.filters.query?'搜索：'+ui.filters.query:'',ui.filters.hideDone?'隐藏已完成':'',ui.filters.showCourses?'含课程':'隐藏课程'].filter(Boolean).join(' · ');
  M.exportOptions = () => ({hideDone:ui.filters.hideDone,label:M.exportFilterLabel()});
  M.readonly = () => !!M.data?.readonly;
  M.api = async function(path,method='GET',payload) {
    const url=path.startsWith('/api/')?path:'/api/'+path.replace(/^\//,'');
    let response;
    try { response=await fetch(url,{method,credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':M.data?.csrf||''},body:payload===undefined?undefined:JSON.stringify(payload)}); }
    catch(error){throw Object.assign(new Error('连接失败，请重试。当前输入仍保留。'),{status:0});}
    const result=await response.json();
    if(!response.ok){const error=Object.assign(new Error(result.error||'读取失败，请重试'),{status:response.status});if(response.status===401&&url!=='/api/login')showLogin(error.message);throw error;}
    return result;
  };
  M.error = (page,error) => {const host=page?.querySelector('[data-error]');if(host){host.textContent=error.message||String(error);host.hidden=false;host.scrollIntoView({block:'nearest'});}else M.toast(error.message||String(error));};
  M.toast = text => {clearTimeout(toastTimer);const box=$('#m-toast');box.textContent=text;box.hidden=false;toastTimer=setTimeout(()=>{box.hidden=true;},4200);};
  M.offerUndo = (label,action) => {const box=$('#m-undo');box.hidden=false;box.innerHTML=`<span>操作已完成</span><button type="button" data-undo>${esc(label)}</button><button type="button" data-dismiss aria-label="关闭撤销提示">×</button>`;box.querySelector('[data-dismiss]').onclick=()=>{box.hidden=true;};box.querySelector('[data-undo]').onclick=async()=>{try{if(await action()!==false)box.hidden=true;}catch(error){M.toast(error.message);}};};
  function showLogin(message='') {$('#m-login').hidden=false;$('#m-app').hidden=true;document.body.classList.add('m-auth-locked');$('#m-login-error').textContent=message;}
  function showApp() {$('#m-login').hidden=true;$('#m-app').hidden=false;document.body.classList.remove('m-auth-locked');}
  M.reload = async () => {const previous=M.data,next=await M.api(M.previewId?'share-preview/'+M.previewId:'state');M.data=next;if(previous&&previous.user.name!==next.user.name)M.goHome();if(previous?.readonly&&next.readonly&&JSON.stringify(previous)!==JSON.stringify(next)&&records[index]?.type==='page'){M.goHome();M.toast('分享内容已更新，请重新查看。');}showApp();renderRoot();window.dispatchEvent(new CustomEvent('mobile:data'));};
  M.setData = data => {if(data.preview&&!M.data?.preview){beforePreviewFilters={...ui.filters};ui.filters={category:'',query:'',hideDone:false,showCourses:true};}M.data=data;syncRootFilters();window.dispatchEvent(new CustomEvent('mobile:data'));};
  M.exitPreview = async () => {try{M.previewId=null;if(beforePreviewFilters)ui.filters=beforePreviewFilters;beforePreviewFilters=null;await M.reload();M.goHome();}catch(error){M.toast(error.message);}};
  M.logout = async () => {if(!await M.confirm('退出当前账户？','退出登录'))return;try{await M.api('logout','POST',{});M.goHome();M.data=null;M.previewId=null;$('#m-app').inert=false;$('#m-undo').hidden=true;showLogin();}catch(error){M.toast(error.message);}};

  M.decorate = function(root=document) {
    decorateIcons(root);
    root.querySelectorAll('[data-category]').forEach(el=>{const category=M.data?.categories.find(c=>c.name===el.dataset.category),color=/^#[0-9a-f]{6}$/i.test(category?.color||'')?category.color:'#81918b';el.style.setProperty('--category',color);});
    root.querySelectorAll('[data-busy-start]').forEach(el=>{const start=Math.max(BUSY_START,Number(el.dataset.busyStart)),end=Math.min(BUSY_END,Number(el.dataset.busyEnd));el.hidden=end<=start;el.style.left=(start-BUSY_START)/BUSY_SPAN*100+'%';el.style.width=Math.max(0,end-start)/BUSY_SPAN*100+'%';if(el.hasAttribute('data-density-strength'))el.style.setProperty('--density-strength',el.dataset.densityStrength);});
    root.querySelectorAll('.timebar[data-density-strength]').forEach(el=>el.style.setProperty('--density-strength',el.dataset.densityStrength));
    root.querySelectorAll('[data-due]').forEach(el=>{const task=M.data?.tasks.find(t=>t.id===el.dataset.due),category=M.data?.categories.find(c=>c.name===task?.category);if(!task||task.done||!task.due)return;const days=(Date.parse(task.due+'+08:00')-Date.now())/86400000;el.classList.toggle('is-late',days<0||days<=(category?.urgent_days??2));el.classList.toggle('is-soon',days>=0&&days<=(category?.warn_days??7));});
  };

  function rememberScroll(){const record=records[index];if(!record)return;record.scroll=record.type==='page'?record.node.querySelector('.m-page-body').scrollTop:scrollY;}
  function snapshot(){return JSON.parse(JSON.stringify(ui));}
  function activate(target) {
    index=target;
    const record=records[index];if(!record)return;
    document.querySelectorAll('#m-pages>.m-page').forEach(page=>{page.hidden=true;page.inert=true;});
    const page=record.type==='page';
    document.body.classList.toggle('m-page-open',page);
    $('#m-app').inert=page;
    if(page){if(!record.node.isConnected)$('#m-pages').append(record.node);if(record.committed){record.node.querySelector('.m-page-body').innerHTML='<p class="m-empty">这次操作已经保存。返回后可重新打开最新内容。</p>';record.node.querySelector('.m-page-actions').replaceChildren();record.dirty=()=>false;}record.node.hidden=false;record.node.inert=false;if(!record.committed)record.node.dispatchEvent(new CustomEvent('mobile:resume'));requestAnimationFrame(()=>{record.node.querySelector('.m-page-body').scrollTop=record.scroll||0;record.node.querySelector('.m-page-back').focus({preventScroll:true});});}
    else {Object.assign(ui,record.ui);renderRoot();requestAnimationFrame(()=>window.scrollTo(0,record.scroll||0));}
    backWaiters.splice(0).forEach(resolve=>resolve(true));
  }
  function push(record) {
    rememberScroll();
    for(const removed of records.splice(index+1)){removed.node?.remove();removed.node?.dispatchEvent(new CustomEvent('mobile:dispose'));}
    records.push(record);index=records.length-1;
    history.pushState({mobile:session,index},'');activate(index);
  }
  function root(next={},replace=false) {
    if(pending||confirmation)return;
    rememberScroll();Object.assign(ui,next);
    const record={type:'root',ui:snapshot(),scroll:0};
    if(replace){records[index]=record;history.replaceState({mobile:session,index},'');activate(index);}else push(record);
  }
  M.showScheduled = date => {M.goHome();root({tab:'agenda',date},true);};
  M.goHome = () => {confirmation?.finish(false);document.querySelectorAll('#m-pages>.m-page').forEach(p=>{p.dispatchEvent(new CustomEvent('mobile:dispose'));p.remove();});records.splice(0);index=0;session=Math.random().toString(36).slice(2);ui.tab='agenda';records.push({type:'root',ui:snapshot(),scroll:0});history.replaceState({mobile:session,index:0},'');activate(0);};
  M.openPage = function(options) {
    if(saving)return null;
    const page=document.createElement('section');page.className='m-page';page.setAttribute('aria-label',options.title);
    page.innerHTML=`<header class="m-page-head"><button type="button" class="m-page-back" aria-label="返回">←</button><h1>${esc(options.title)}</h1></header><div class="m-page-body">${options.body||''}</div><footer class="m-page-actions">${options.actions||''}</footer>`;
    if(!page.querySelector('[data-error]'))page.querySelector('.m-page-body').insertAdjacentHTML('beforeend','<p class="m-error" data-error role="alert"></p>');
    page.querySelector('.m-page-back').onclick=()=>M.back();
    $('#m-pages').append(page);
    push({type:'page',node:page,dirty:options.dirty,scroll:0});
    options.onMount?.(page);M.decorate(page);return page;
  };
  M.back = async function(options={}) {
    if(confirmation){confirmation.finish(false);return;}
    if(saving){M.toast('正在保存，请稍候');return;}
    if(index===0)return false;
    if(!options.force&&records[index]?.dirty?.()&&!await M.confirm('放弃当前未保存的修改？','放弃修改'))return false;
    allowPop=true;
    return new Promise(resolve=>{backWaiters.push(resolve);history.back();});
  };
  window.addEventListener('popstate',event=>{
    if(event.state?.mobile!==session){history.replaceState({mobile:session,index},'');return;}
    const target=event.state?.mobile===session?event.state.index:0;
    if(target===index)return;
    if(!records[target]){history.replaceState({mobile:session,index},'');return;}
    const restore=()=>history.go(index-target);
    if(confirmation){confirmation.finish(false);restore();return;}
    if(saving){restore();return;}
    if(target<index&&!allowPop&&records[index]?.dirty?.()){
      restore();
      M.confirm('放弃当前未保存的修改？','放弃修改').then(yes=>{if(yes){allowPop=true;history.go(target-index);}});
      return;
    }
    allowPop=false;rememberScroll();activate(target);
  });
  window.addEventListener('beforeunload',event=>{if(saving||records[index]?.dirty?.()){event.preventDefault();event.returnValue='';}});

  M.confirm = function(message,label='确认操作') {
    if(confirmation)return Promise.resolve(false);
    const dialog=$('#m-confirm'),slider=$('#m-confirm-slider'),handle=slider.querySelector('.m-slider-handle'),previous=document.activeElement;
    $('#m-confirm-title').textContent=label;$('#m-confirm-message').textContent=message;
    slider.setAttribute('aria-label',message+'，向右滑动确认；键盘按右方向键后 Enter');
    let start=null,offset=0,armed=false;
    const distance=()=>slider.clientWidth-handle.offsetWidth-12;
    const reset=()=>{start=null;offset=0;armed=false;handle.style.transform='';};
    reset();dialog.showModal();slider.focus({preventScroll:true});
    return new Promise(resolve=>{
      const finish=value=>{if(!confirmation)return;confirmation=null;reset();dialog.close();slider.onpointerdown=slider.onpointermove=slider.onpointerup=slider.onpointercancel=slider.onkeydown=null;previous?.isConnected&&previous.focus({preventScroll:true});resolve(value);};
      confirmation={finish};
      slider.onpointerdown=event=>{if(event.button!==0)return;start=event.clientX;offset=0;slider.setPointerCapture(event.pointerId);};
      slider.onpointermove=event=>{if(start===null)return;offset=Math.max(0,Math.min(distance(),event.clientX-start));handle.style.transform=`translateX(${offset}px)`;};
      slider.onpointerup=event=>{if(start===null)return;event.preventDefault();if(offset>=distance()*.9)finish(true);else reset();};
      slider.onpointercancel=reset;
      slider.onkeydown=event=>{if(event.key==='ArrowRight'){event.preventDefault();armed=true;handle.style.transform=`translateX(${distance()}px)`;}else if(['Enter',' '].includes(event.key)){event.preventDefault();if(armed)finish(true);}else if(event.key==='Escape'){event.preventDefault();finish(false);}};
      $('#m-confirm-cancel').onclick=()=>finish(false);
      dialog.oncancel=event=>{event.preventDefault();finish(false);};
      dialog.onclick=event=>{if(event.target===dialog)finish(false);};
    });
  };
  M.write = async function(action,message,label='确认保存') {
    if(pending)return false;pending=true;
    const page=records[index]?.node;
    const lockRoot=page||$('#m-app');let wasInert=false;
    try{
      if(!await M.confirm(message,label))return false;
      saving=true;document.body.classList.add('m-saving');
      wasInert=lockRoot.inert;lockRoot.inert=true;
      const result=await action();
      if(records[index]?.node===page&&records[index].dirty)records[index].committed=true;
      if(result?.reauth){M.goHome();M.data=null;M.previewId=null;showLogin('密码已更新，请重新登录。');return true;}
      try{await M.reload();}catch(error){M.toast('已提交，但重新读取失败；请刷新核对后再操作。');return true;}
      M.toast('已保存');return true;
    }catch(error){M.error(page,error);return false;}
    finally{lockRoot.inert=wasInert;saving=false;pending=false;document.body.classList.remove('m-saving');}
  };

  function taskCard(task,ongoing=false) {
    const next=(task.milestones||[]).filter(n=>!n.done).sort((a,b)=>a.stop_at.localeCompare(b.stop_at))[0];
    return `<button type="button" class="m-task-card ${task.done?'is-done':''}" data-task="${esc(task.id)}" data-category="${esc(task.category)}"><span class="m-card-heading"><strong>${esc(task.title)}</strong>${task.done?'<span class="m-badge">已完成</span>':''}</span><span class="m-meta">${esc(ongoing?'计划 '+taskWhen(task):task.start_time?task.start_time+'–'+task.end_time:task.category)}</span>${task.due?`<span class="m-due" data-due="${esc(task.id)}">截止 ${esc(task.due.replace('T',' '))}</span>`:''}${ongoing&&next?`<span class="m-meta">下一节点 ${esc(next.label||'关键节点')} · ${esc(next.stop_at.slice(0,16).replace('T',' '))}</span>`:''}</button>`;
  }
  function courseCard(course) {return `<button type="button" class="m-task-card m-course-card" data-course="${esc(course.course_key||'')}" data-course-date="${esc(course.original_date||course.date)}" data-course-actual="${esc(course.date)}" data-course-time="${esc(course.time)}"><span class="m-card-heading"><strong>${esc(course.name)}</strong>${course.homework_required?`<span class="m-badge ${course.homework_done?'is-done':''}">${course.homework_done?'作业已完成':'需交作业'}</span>`:''}</span><span class="m-meta">${esc(course.time)}${course.room?' · '+esc(course.room):''}${course.adjusted?' · 已调课':''}</span></button>`;}
  function eventCard(event) {
    if(event.kind==='task')return taskCard(event.task);
    if(event.kind==='course')return courseCard(event.course);
    if(event.kind==='deadline')return `<button class="m-task-card m-deadline" data-task="${esc(event.task.id)}" data-category="${esc(event.task.category)}"><strong>${esc(event.task.short_title||event.task.title)}</strong><span class="m-due" data-due="${esc(event.task.id)}">最终截止 · ${esc(event.time)}</span></button>`;
    return `<button class="m-task-card ${event.node.done?'is-done':''}" data-task="${esc(event.task.id)}" data-node-index="${event.index}" data-category="${esc(event.task.category)}"><strong>${esc(event.node.label||'关键节点')}</strong><span class="m-meta">${esc(event.task.short_title||event.task.title)} · 节点${event.node.done?' · 已完成':''}</span></button>`;
  }
  const section=(title,body,extra='')=>`<section class="m-section"><div class="m-section-heading"><h2>${title}</h2>${extra}</div>${body}</section>`;
  function filterSummary(){const f=ui.filters,parts=[f.category,f.query?'搜索：'+f.query:'',f.hideDone?'隐藏已完成':'',!f.showCourses?'隐藏课程':''].filter(Boolean);return parts.length?`<button class="m-filter-summary" data-action="filters">${esc(parts.join(' · '))} · 修改筛选</button>`:'';}
  function dayBar(){return `<div class="m-datebar"><button data-shift="-1" aria-label="前一天">‹</button><label><span class="sr-only">选择日期</span><input id="m-date" type="date" min="0001-01-01" max="9999-12-31" value="${ui.date}"></label><button data-shift="1" aria-label="后一天">›</button><button data-action="today" ${ui.date===today()?'disabled':''}>今天</button></div>`;}
  function reminderRows(rows){return rows.map(({task,points})=>`<button class="m-reminder" data-task="${esc(task.id)}"><strong>${esc(task.short_title||task.title)}</strong><span>${esc(points.map(p=>p.label+' '+p.at.slice(5,16).replace('T',' ')).join(' · '))}</span></button>`).join('');}
  function reminders(){if(ui.date!==today()||M.data.share?.busy_only)return '';const rows=taskTimeHints(M.filteredTasks(),Date.now());return rows.length?section(`待处理 <span class="m-count">${rows.length}</span>`,reminderRows(rows.slice(0,3)),rows.length>3?'<button data-action="reminders">查看全部</button>':''):'';}
  function agenda() {
    const date=ui.date;
    if(!D.allowedDate(M.data,date))return dayBar()+'<p class="m-empty">'+(M.data.share?.enabled?'这一天不在分享授权范围内。':'分享尚未开启，当前没有获准展示的日程。')+'</p>';
    const entries=D.dayEntries(M.data,date,ui.filters),empty=!entries.timed.length&&!entries.dated.length&&!entries.ongoing.length;
    const count=(M.data.date_counts||[]).find(x=>x.date===date)?.count||0;
    const timed=entries.timed.map(event=>`<div class="m-agenda-row"><time>${esc(event.time)}</time>${eventCard(event)}</div>`).join('');
    return dayBar()+filterSummary()+reminders()+section('当天日程',timed+(empty&&!count?`<p class="m-empty">${ui.filters.query||ui.filters.category||ui.filters.hideDone?'当前筛选下没有安排。可调整筛选查看其他内容。':'当天暂无安排。'}</p>`:!timed?'<p class="m-muted">暂无定时安排</p>':''),M.data.share?.busy_only?'':`<button data-journal="${date}" data-icon="book">手记</button>`)+(entries.dated.length||count?section('日期安排',entries.dated.map(t=>taskCard(t)).join('')+(count?`<p class="m-muted">另有 ${count} 项日期安排（不代表全天忙碌）</p>`:'')):'')+(entries.ongoing.length?section('持续任务',entries.ongoing.map(t=>taskCard(t,true)).join('')):'');
  }
  function busyMarkup(date,untimedCount=0){
    const intervals=D.busyIntervals(M.data,date,ui.filters),minutes=intervals.reduce((sum,[a,b])=>sum+b-a,0),early=intervals.some(([a])=>a<BUSY_START);
    const load=D.scheduleDensity(intervals,untimedCount,BUSY_START,BUSY_END);
    const workload=untimedCount?`；${untimedCount} 项未定时安排，${load.freeMinutes?`空闲 ${Math.round(load.freeMinutes/6)/10} 小时，密度 ${load.density.toFixed(2)} 项/小时`:'没有空闲时段'}`:'';

    return `<div class="m-busy timebar ${untimedCount?'has-untimed':''}" data-density-strength="${load.strength}" role="img" aria-label="08:00 至 24:00 的安排；绿色为定时时段，暖棕色为未定时工作量提示，非实际占用；全天定时安排共 ${Math.round(minutes/6)/10} 小时${workload}">${load.busy.map(([a,b])=>`<i data-busy-start="${a}" data-busy-end="${b}"></i>`).join('')}<span class="m-busy-dots timebar-dots" aria-hidden="true"><b class="at-8"></b><b class="at-12"></b><b class="at-18"></b><b class="at-24"></b></span></div>${early?'<span class="m-meta">08:00 前另有定时安排</span>':''}`;
  }
  function week() {
    const lo=monday(ui.date),hi=add(lo,6),tasks=M.filteredTasks(),ongoing=tasks.filter(t=>t.date!==t.end_date&&t.date<=hi&&t.end_date>=lo);
    const rows=Array.from({length:7},(_,i)=>{const date=add(lo,i);if(!D.allowedDate(M.data,date))return `<div class="m-week-day m-muted"><span>${formatDate(date)}</span><span>授权范围外</span></div>`;const e=D.dayEntries(M.data,date,ui.filters),counts=D.workloadCounts(M.data,date,ui.filters);const key=e.timed.find(x=>x.kind==='deadline'||x.kind==='node')||e.timed[0],label=key?key.time+' '+(key.kind==='deadline'?'截止 · ':key.kind==='node'?'节点 · ':'')+(key.node?.label||key.course?.name||key.task?.short_title||key.task?.title):'暂无定时安排';return `<button type="button" class="m-week-day ${date===today()?'is-today':''}" data-show-date="${date}"><span class="m-week-date">${['一','二','三','四','五','六','日'][i]}<strong>${Number(date.slice(8))}</strong></span><span class="m-week-summary"><strong>${counts.slots} 个定时时段 · ${counts.dated} 项未定时 · ${counts.points} 个时间点</strong><span class="m-meta">${esc(label)}</span>${busyMarkup(date,counts.untimed)}</span><span aria-hidden="true">›</span></button>`;}).join('');
    return `<div class="m-period"><button data-week-shift="-7" aria-label="上一周">‹</button><strong>${formatDate(lo)} — ${formatDate(hi)}</strong><button data-week-shift="7" aria-label="下一周">›</button><button data-action="today">本周</button><button data-action="density" data-icon="settings" aria-label="密度设置"></button></div>`+filterSummary()+`<div class="m-week-list">${rows}</div>`+(ongoing.length?section(`本周持续任务 · ${ongoing.length}`,ongoing.map(t=>taskCard(t,true)).join('')):'');
  }
  function semester() {
    const start=M.data.settings.start,tasks=M.filteredTasks(),pendingTasks=M.data.tasks.filter(t=>!t.done),now=Date.now();
    const stats=`<div class="m-stats"><div><span>学期进度</span><strong>${Math.max(0,Math.min(18,Math.floor((Date.parse(today())-Date.parse(start))/604800000)+1))} / 18 周</strong></div><div><span>待完成</span><strong>${pendingTasks.length}</strong></div><div><span>未来 7 天截止</span><strong>${pendingTasks.filter(t=>t.due&&Date.parse(t.due+'+08:00')>=now&&Date.parse(t.due+'+08:00')<=now+7*86400000).length}</strong></div><div><span>已逾期</span><strong>${pendingTasks.filter(t=>t.due&&Date.parse(t.due+'+08:00')<now).length}</strong></div></div>`;
    const rows=Array.from({length:18},(_,w)=>{const lo=add(start,w*7),hi=add(lo,6);if(M.readonly()&&(lo>M.data.share.end||hi<M.data.share.start))return '';const ts=tasks.filter(t=>t.date<=hi&&t.end_date>=lo),nodes=tasks.flatMap(t=>t.milestones||[]).filter(n=>n.stop_at.slice(0,10)>=lo&&n.stop_at.slice(0,10)<=hi),dues=tasks.filter(t=>t.due&&t.due.slice(0,10)>=lo&&t.due.slice(0,10)<=hi&&!t.done).sort((a,b)=>a.due.localeCompare(b.due));return `<button class="m-semester-week ${lo<=today()&&today()<=hi?'is-today':''}" data-show-week="${lo}"><span class="m-week-index">W${String(w+1).padStart(2,'0')}</span><span><strong>${formatDate(lo)} — ${formatDate(hi)}${w>=16?' · 考试周':''}</strong><span class="m-meta">${ts.length} 项任务 · ${nodes.length} 个节点${dues.length?' · '+dues.length+' 项截止':''}</span>${dues[0]?`<span class="m-meta">${esc(dues[0].short_title||dues[0].title)} · ${esc(dues[0].due.slice(5).replace('T',' '))}</span>`:''}</span><span>›</span></button>`;}).join('');
    const outside=tasks.filter(t=>t.end_date<start||t.date>add(start,125));
    return `<p class="m-meta">${esc(M.data.settings.name)} · ${start} — ${add(start,125)}</p><p class="m-meta">${M.readonly()?'以下统计仅含授权范围':'以下统计为全学期'}</p>${stats}`+filterSummary()+`<div class="m-semester-list">${rows||'<p class="m-empty">没有获准展示的周次。</p>'}</div>`+(outside.length?section('学期范围外',outside.map(t=>taskCard(t,true)).join('')):'');
  }
  function more() {
    const user=M.data.user,items=[...(!M.readonly()?[['courses','calendar','我的课程'],['categories','tag','任务分类'],['sharing','share','分享管理'],['settings','settings','学期设置']]:[]),['account','user','账户设置'],...(user.admin&&!M.readonly()?[['accounts','users','账户管理']]:[]),['theme','sun','切换为'+(document.documentElement.dataset.theme==='dark'?'浅色':'深色')],...(!M.readonly()||M.data.share?.export?[['image','image','导出学期图片']]:[]),...(!M.readonly()?[['export','download','导出数据备份']]:[]),['refresh','locate','重新读取日程'],['logout','logout','退出登录']];
    return `<div class="m-profile"><img src="/icon.svg?v=2" alt=""><div><strong>${esc(user.remark||user.name)}</strong><p class="m-meta">@${esc(user.name)}${M.readonly()?' · 只读展示':user.admin?' · 管理员':''}</p></div></div><div class="m-menu">${items.map(([id,icon,label])=>`<button data-menu="${id}"><span data-icon="${icon}">${label}</span><span>›</span></button>`).join('')}</div><div class="m-more-links"><a href="/?desktop=1">使用电脑版</a><a href="/legacy/">旧版入口</a><span>北京时间 · 学期手记</span></div>`;
  }
  function renderRoot() {
    if(!M.data)return;
    const date=ui.date,day=new Date(date+'T12:00:00Z').getUTCDay();
    $('#m-title').textContent=ui.tab==='agenda'?`${Number(date.slice(5,7))}月${Number(date.slice(8))}日 · 周${'日一二三四五六'[day]}`:ui.tab==='overview'?'安排总览':'我的空间';
    $('#m-subtitle').textContent=ui.tab==='agenda'?(date===today()?'今天 · ':'')+M.data.settings.name:ui.tab==='overview'?'从一周到整个学期':'学期手记';
    $('#m-header-actions').innerHTML=ui.tab==='more'?'':`<button data-action="filters" aria-label="筛选" data-icon="filter"></button>${!M.readonly()?'<button data-action="add" class="primary" aria-label="新建任务" data-icon="plus"></button>':''}`;
    $('#m-share-banner').hidden=!M.readonly();$('#m-share-banner').innerHTML=M.readonly()?`${esc(M.data.preview?'分享预览':M.data.share?.busy_only?'仅占用展示':'只读日程')}${M.data.preview?'<button data-action="exit-preview">退出预览</button>':''}`:'';
    if(M.readonly()&&ui.overview==='deferred')ui.overview='week';
    let body=ui.tab==='agenda'?agenda():ui.tab==='more'?more():`<div class="m-segment" role="tablist" aria-label="总览范围"><button role="tab" data-overview="week" aria-selected="${ui.overview==='week'}">本周</button><button role="tab" data-overview="semester" aria-selected="${ui.overview==='semester'}">学期</button>${!M.readonly()?`<button role="tab" data-overview="deferred" aria-selected="${ui.overview==='deferred'}">暂缓 · ${(M.data.deferred_tasks||[]).length}</button>`:''}</div>`+(M.readonly()&&!M.data.share?.enabled?'<p class="m-empty">分享尚未开启，当前没有获准展示的日程。</p>':ui.overview==='deferred'?`<p class="m-meta">${esc(ui.filters.category||'全部分类')} · ${DeferredTasks.filtered(M.data,ui.filters).length} 项暂缓任务</p>`+DeferredTasks.list(DeferredTasks.filtered(M.data,ui.filters)):ui.overview==='week'?week():semester());
    $('#m-content').innerHTML=body;
    $('#m-nav').querySelectorAll('button').forEach(b=>{b.setAttribute('aria-current',b.dataset.tab===ui.tab?'page':'false');});
    if(records[index]?.type==='root')records[index].ui=snapshot();M.decorate();
  }
  function openFilters() {
    const filters={...ui.filters},busy=!!M.data.share?.busy_only,deferredView=ui.tab==='overview'&&ui.overview==='deferred';
    M.openPage({title:deferredView?'筛选暂缓任务':'筛选日程',body:`<form id="m-filter-form">${busy?'':`<label class="m-field">搜索任务<input name="query" type="search" value="${esc(filters.query)}" placeholder="标题、简称、备注或节点"></label>`}<label class="m-field">任务分类<select name="category"><option value="">全部分类</option>${M.data.categories.map(c=>`<option value="${esc(c.name)}" ${filters.category===c.name?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>${busy||deferredView?'':`<label class="m-check"><input name="hideDone" type="checkbox" ${filters.hideDone?'checked':''}>隐藏已完成任务和节点</label>`}${deferredView?'':`<label class="m-check"><input name="showCourses" type="checkbox" ${filters.showCourses?'checked':''}>显示课程</label><p class="m-muted">搜索和分类只筛选任务，课程按“显示课程”控制。</p>`}</form>`,actions:'<button data-clear>清除筛选</button><button class="primary" data-apply>应用筛选</button>',onMount(page){const form=page.querySelector('form');page.querySelector('[data-clear]').onclick=()=>{ui.filters={category:'',query:'',hideDone:false,showCourses:true};syncRootFilters();M.back({force:true});};page.querySelector('[data-apply]').onclick=()=>{ui.filters={category:form.elements.category.value,query:form.elements.query?.value||'',hideDone:form.elements.hideDone?.checked??filters.hideDone,showCourses:form.elements.showCourses?.checked??filters.showCourses};syncRootFilters();M.back({force:true});};}});
  }
  function syncRootFilters(){for(const record of records)if(record.type==='root')record.ui.filters={...ui.filters};renderRoot();}
  function openReminders(){M.openPage({title:'待处理时间点',body:`<p class="m-meta">过去未完成的结束、截止和节点，以及未来 12 小时内的时间点。</p>${reminderRows(taskTimeHints(M.filteredTasks(),Date.now()))}`,onMount(page){page.querySelectorAll('[data-task]').forEach(b=>b.onclick=()=>M.openTask(b.dataset.task));}});}
  function onAction(event) {
    if(pending||saving)return;
    const target=event.target.closest('button,a');if(!target)return;
    if(target.dataset.tab){if(target.dataset.tab!==ui.tab)root({tab:target.dataset.tab});return;}
    if(target.dataset.action){const action=target.dataset.action;if(action==='filters')openFilters();else if(action==='density')WorkloadSettings.openMobile();else if(action==='add')M.editTask(ui.date,null,false,{deferred:ui.tab==='overview'&&ui.overview==='deferred'});else if(action==='today')root({date:today()});else if(action==='reminders')openReminders();else if(action==='exit-preview')M.exitPreview();return;}
    if(target.dataset.shift){root({date:add(ui.date,Number(target.dataset.shift))});return;}
    if(target.dataset.weekShift){root({date:add(ui.date,Number(target.dataset.weekShift))});return;}
    if(target.dataset.showDate){root({tab:'agenda',date:target.dataset.showDate});return;}
    if(target.dataset.showWeek){root({tab:'overview',overview:'week',date:target.dataset.showWeek});return;}
    if(target.dataset.overview){root({overview:target.dataset.overview});return;}
    if(target.dataset.deferredTask){M.openTask(target.dataset.deferredTask);return;}
    if(target.dataset.resumeDeferred){M.resumeDeferred(target.dataset.resumeDeferred);return;}
    if(target.dataset.task){M.openTask(target.dataset.task,{nodeIndex:target.hasAttribute('data-node-index')?Number(target.dataset.nodeIndex):undefined});return;}
    if(target.hasAttribute('data-course')){if(target.dataset.course)M.openCourse(target.dataset.course,target.dataset.courseDate);else{const course=M.data.course_dates.find(c=>c.date===target.dataset.courseActual&&c.time===target.dataset.courseTime);if(course)M.openPage({title:course.name,body:`<div class="m-card"><p>${esc(course.date+' '+course.time)}</p><p>${esc(course.room||'')}</p><p class="m-meta">只读课程</p></div>`});}return;}
    if(target.dataset.journal){M.openJournal(target.dataset.journal);return;}
    if(target.dataset.menu){const actions={courses:'openCourses',categories:'openCategories',sharing:'openSharing',settings:'openSettings',account:'openAccount',accounts:'openAccounts',image:'exportImage',export:'exportData',logout:'logout'};if(target.dataset.menu==='theme'){const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;try{localStorage.setItem('semester-theme',theme);}catch(error){}renderRoot();}else if(target.dataset.menu==='refresh')M.reload().then(()=>M.toast('已重新读取日程')).catch(error=>M.toast(error.message));else M[actions[target.dataset.menu]]?.();}
  }
  window.addEventListener('storage',event=>{if(event.key==='semester-density-threshold'&&M.data)renderRoot();});
  document.addEventListener('DOMContentLoaded',async()=>{
    try{sessionStorage.removeItem('semester-desktop');}catch(error){}
    records.push({type:'root',ui:snapshot(),scroll:0});history.replaceState({mobile:session,index:0},'');
    $('#m-nav').onclick=onAction;$('#m-content').onclick=onAction;$('#m-header-actions').onclick=onAction;$('#m-share-banner').onclick=onAction;
    $('#m-content').onchange=event=>{if(event.target.id==='m-date'&&event.target.value){if(event.target.validity.valid)root({date:event.target.value});else{event.target.reportValidity();event.target.value=ui.date;}}};
    $('#m-login-form').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('button');if(button.disabled)return;button.disabled=true;try{await M.api('login','POST',Object.fromEntries(new FormData(event.target)));await M.reload();event.target.reset();if(records[index]?.type==='page')activate(index);}catch(error){$('#m-login-error').textContent=error.message;}finally{button.disabled=false;}};
    const keyboard=()=>{const viewport=window.visualViewport,height=viewport?.height||innerHeight;document.documentElement.style.setProperty('--visible-height',height+'px');document.body.classList.toggle('m-keyboard',!!viewport&&innerHeight-height>140);};
    window.visualViewport?.addEventListener('resize',keyboard);window.addEventListener('resize',keyboard);keyboard();
    try{await M.reload();}catch(error){if(error.status!==401){showLogin('');$('#m-login-error').textContent=error.message;}}
    // Viewer permissions are periodically rechecked without rebuilding open drafts.
    setInterval(()=>{if(M.data?.readonly&&!M.data.preview&&!pending&&!saving)M.reload().catch(error=>M.toast(error.message));},60000);
  });
})();
