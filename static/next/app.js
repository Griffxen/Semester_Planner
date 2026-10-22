/* Presentation layer over the frozen, compatible domain client. */
const legacyApi=api,legacyConfirm=askConfirm;
let workspacePage='home';
let nextView=matchMedia('(max-width:700px)').matches?'today':'week',nextWeek=today(),followSevenDays=true,dayTab='agenda',categoryBaseline='',authPending=false;
function monday(date){return add(date,-((new Date(date+'T12:00:00Z').getUTCDay()+6)%7))}
function matchesTask(t){const q=$('#search').value.trim().toLocaleLowerCase();return (!filter||t.category===filter)&&(!$('#hide-done').checked||!t.done)&&(!q||[t.title,t.short_title,t.notes,...(t.milestones||[]).map(m=>m.label)].join(' ').toLocaleLowerCase().includes(q))}
visible=matchesTask;
function compactCard(t){const node=(t.milestones||[]).find(m=>!m.done),when=t.start_time?taskWhen(t):t.date===t.end_date?'按日期':taskWhen(t);return `<button class="task cat-${cats.indexOf(t.category)} ${t.done?'done':''}" data-task="${esc(t.id)}" ${state.readonly?'':'draggable="true"'} title="${esc(t.title+' · '+taskWhen(t,true))}"><span aria-hidden="true">${t.done?'✓':'○'}</span><div><strong>${esc(t.title)}</strong><small class="task-meta">${esc(when)}${t.due?`<em>${deadlineMarkup(t)}</em>`:node?`<em>节点 ${esc(node.stop_at.slice(5,16).replace('T',' '))}</em>`:''}</small></div></button>`}
card=compactCard;
function nodesRail(t,lo,hi){const nodes=positionedMilestones(t,lo,hi);return `<div class="node-rail">${nodes.length?nodes.map(m=>`<span class="node-pin ${m.done?'completed':''}" data-node-position="${m.position}" title="${esc((m.label||'关键节点')+' · '+milestoneTime(m)+' · '+(m.done?'已完成':'未完成'))}"><i>${m.done?'✓':'◆'}</i><span>${esc(m.label||'关键节点')} · ${esc(m.stop_at.slice(5,16).replace('T',' '))}</span></span>`).join(''):'<span class="no-nodes">'+((t.milestones||[]).length?'本周无节点 · 点击查看详情':'点击查看详情')+'</span>'}</div>`}
function longTracks(tasks,lo,hi){const items=tasks.filter(t=>t.end_date>t.date&&t.date<=hi&&t.end_date>=lo).map(t=>({t,start:Math.max(0,Math.round((Date.parse(t.date)-Date.parse(lo))/86400000)),end:Math.min(7,Math.round((Date.parse(t.end_date)-Date.parse(lo))/86400000)+1)}));if(!items.length)return '';return `<section class="long-section"><h3>持续任务 · ${items.length} 项 </h3><div class="range-tracks"><div class="range-lanes">${packRangeItems(items).map(lane=>`<div class="range-lane">${lane.map(({t,start,end})=>`<button class="range-bar cat-${cats.indexOf(t.category)} ${t.done?'done':''}" data-task="${esc(t.id)}" data-range-start="${start+1}" data-range-end="${end+1}" data-anchor="${t.date<lo?lo:t.date}" ${state.readonly?'':'draggable="true"'} title="${esc(t.title+' · '+taskWhen(t,true))}"><div class="range-top"><strong>${t.date<lo?'← ':''}${esc(t.title)}${t.end_date>hi?' →':''}${t.done?' · 已完成':''}</strong><small>计划 ${esc(taskWhen(t))}${t.due?' · 截止 '+esc(t.due.slice(5).replace('T',' ')):''}</small></div>${nodesRail(t,add(lo,start),add(lo,end-1))}</button>`).join('')}</div>`).join('')}</div></div></section>`}
function dayCourses(date){return $('#show-courses').checked?(state.course_dates||[]).filter(c=>c.date===date&&!c.cancelled):[]}
function milestoneCard({task,node}){const done=!!node.done;return `<button type="button" class="task milestone-day-card cat-${cats.indexOf(task.category)} ${done?'done':''}" data-task="${esc(task.id)}" data-open-node title="${esc(task.title+' · '+(node.label||'关键节点')+' · '+milestoneTime(node))}"><span aria-hidden="true">${done?'✓':'○'}</span><div><strong>${esc(task.short_title||task.title)} · ${esc(node.label||'关键节点')}</strong><small class="task-meta">节点 ${esc(node.stop_at.slice(11,16))}${done?' · 已完成':''}</small></div></button>`}
function dayMilestoneCards(date,tasks){return calendarMilestones(tasks,date,$('#hide-done').checked).map(milestoneCard).join('')}
function taskEndCard(task){return `<button type="button" class="task task-end-day-card cat-${cats.indexOf(task.category)} ${task.done?'done':''}" data-task="${esc(task.id)}" title="${esc(task.title+' · 结束 '+task.end_date+(task.end_time?' '+task.end_time:'（按日期）'))}"><span aria-hidden="true">${task.done?'✓':'○'}</span><div><strong>${esc(task.short_title||task.title)} · 结束</strong><small class="task-meta">结束 ${esc(task.end_time||'按日期')}${task.done?' · 已完成':''}</small></div></button>`}
function dayTaskEnds(date,tasks){return state.share?.busy_only?[]:calendarTaskEnds(tasks,date,$('#hide-done').checked)}
function singleDay(date,tasks){if(!allowedDate(date))return `<div class="day-muted">授权范围外</div>`;const ts=tasks.filter(t=>t.date===date&&t.end_date===date),cs=dayCourses(date);return ts.map(compactCard).join('')+dayMilestoneCards(date,tasks)+dayTaskEnds(date,tasks).map(taskEndCard).join('')+courseBlocks(cs)+dateCountMarkup(date)+journalMarkup(date)}
function dayAddButton(date){return state.readonly||!allowedDate(date)?'':`<button class="day-add" data-date="${date}" aria-label="${date} 添加任务" title="添加任务">+</button>`}
function weekDayLabel(date){return '周'+'日一二三四五六'[new Date(date+'T12:00:00Z').getUTCDay()]}
function overdueMarkup(tasks,now=Date.now()){
  const busyOnly=!!state.share?.busy_only,groups=busyOnly?[]:overdueTaskGroups(tasks,now);
  return `<div class="day-heading"><strong>逾期</strong>${busyOnly?'':`<span>${groups.length} 项</span>`}</div>`+groups.map(({task,points})=>{
    const first=points[0],when=first.dateOnly?first.at.slice(5,10)+'（按日期）':first.at.slice(5,16).replace('T',' ');
    return `<button type="button" class="task overdue-card cat-${cats.indexOf(task.category)}" data-task="${esc(task.id)}" title="${esc(task.title+' · '+points.map(p=>p.label+' '+p.at.slice(0,16).replace('T',' ')).join('；'))}"><span aria-hidden="true">!</span><div><strong>${esc(task.short_title||task.title)}</strong><small class="task-meta">${esc(first.label+' '+when)}${points.length>1?' · +'+(points.length-1):''}</small></div></button>`;
  }).join('')+(groups.length?'':`<p class="hint-empty">${busyOnly?'仅展示占用时间':'暂无逾期'}</p>`);
}
let overdueClockMarkup='';
function overdueColumn(tasks){overdueClockMarkup=overdueMarkup(tasks);return `<section class="overdue-column" data-overdue-column aria-label="逾期项目">${overdueClockMarkup}</section>`}
function refreshSevenDayClock(){
  if(!state||nextView!=='week'||workspacePage!=='home')return;
  if(followSevenDays&&nextWeek!==today()){
    if(mobileDate!=='overdue')mobileDate=today();
    render();return;
  }
  const column=$('#calendar [data-overdue-column]');
  if(!column)return;
  const markup=overdueMarkup(state.tasks.filter(matchesTask));
  if(overdueClockMarkup!==markup){
    const focused=document.activeElement?.closest('[data-task]');
    const activeTask=focused&&column.contains(focused)?focused.dataset.task:null;
    overdueClockMarkup=markup;column.innerHTML=markup;applyCategoryColors();
    if(activeTask)[...column.querySelectorAll('[data-task]')].find(el=>el.dataset.task===activeTask)?.focus({preventScroll:true});
  }
}
// Only the rolling seven-day board adds an overdue column; semester weeks reuse seven dates.
function weekBoard(lo,tasks,withOverdue=false){
  const hi=add(lo,6);
  if(matchMedia('(max-width:700px)').matches){
    const selected=withOverdue&&mobileDate==='overdue'?'overdue':mobileDate>=lo&&mobileDate<=hi?mobileDate:today()>=lo&&today()<=hi?today():lo;
    const tabs=`<div class="mobile-week-days" role="tablist" aria-label="${withOverdue?'七日日期与逾期':'本周日期'}">${withOverdue?`<button role="tab" aria-selected="${selected==='overdue'}" class="${selected==='overdue'?'active':''}" data-mobile-date="overdue">逾期</button>`:''}${Array.from({length:7},(_,i)=>{const d=add(lo,i);return `<button role="tab" aria-selected="${d===selected}" class="${d===selected?'active':''}" data-mobile-date="${d}">${weekDayLabel(d).slice(1)}<strong>${d.slice(8)}</strong></button>`}).join('')}</div>`;
    if(selected==='overdue')return tabs+overdueColumn(tasks);
    return tabs+`<section class="next-day ${selected===today()?'is-today':''}" data-drop="${selected}"><div class="day-heading"><strong>${selected}</strong><div class="day-heading-actions"><button data-show-day="${selected}">查看当天</button>${dayAddButton(selected)}</div></div>${singleDay(selected,tasks)}</section>${longTracks(tasks,lo,hi)}`;
  }
  const dates=`<div class="week-grid">${Array.from({length:7},(_,i)=>{const d=add(lo,i);return `<section class="next-day ${d===today()?'is-today':''}" data-drop="${d}" id="day-${d}"><div class="day-heading"><button class="day-number" data-show-day="${d}">${weekDayLabel(d)} ${d.slice(5).replace('-','/')}</button><div class="day-heading-actions">${d===today()?'<span>今天</span>':''}${dayAddButton(d)}</div></div>${singleDay(d,tasks)}</section>`}).join('')}</div>${longTracks(tasks,lo,hi)}`;
  return withOverdue?`<div class="seven-day-scroll"><div class="seven-day-board">${overdueColumn(tasks)}<div class="seven-day-schedule">${dates}</div></div></div>`:dates;
}
function upcoming(tasks){const now=Date.now(),end=now+7*86400000,result=[];for(const t of tasks){if(!t.done&&t.due){const at=t.due+'+08:00',ms=Date.parse(at);if(ms<=end)result.push({t,label:'最终截止',at,late:ms<now})}for(const m of t.milestones||[]){if(!m.done&&Date.parse(m.stop_at)<=end)result.push({t,label:m.label||'关键节点',at:m.stop_at,late:Date.parse(m.stop_at)<now})}}return result.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))}
function todayBoard(date,tasks){if(!allowedDate(date))return '<div class="empty-state">这一天不在分享授权范围内。</div>';const actual=tasks.filter(t=>t.date<=date&&t.end_date>=date),long=actual.filter(t=>t.end_date>t.date),agenda=actual.filter(t=>t.end_date===t.date),events=[...dayTaskEnds(date,tasks).map(task=>({time:task.end_time||'99:99',ending:task})),...calendarMilestones(tasks,date,$('#hide-done').checked).map(item=>({time:item.node.stop_at.slice(11,16),milestone:item})),...agenda.map(t=>({time:t.start_time||'99:99',task:t})),...dayCourses(date).map(c=>({time:c.time.slice(0,5),course:c}))].sort((a,b)=>a.time.localeCompare(b.time));let body='';if(dayTab==='agenda')body=events.map(e=>`<div class="agenda-item"><span class="agenda-time">${e.time==='99:99'?'日期安排':esc(e.time)}</span>${e.ending?taskEndCard(e.ending):e.milestone?milestoneCard(e.milestone):e.task?compactCard(e.task):courseBlocks([e.course])}</div>`).join('')+dateCountMarkup(date);if(dayTab==='agenda')body=`<div class="day-overview"><section><h3>当天日程 · ${events.length}</h3>${body||'<p class="hint-empty">当天暂无日程</p>'}</section><section><h3>持续任务 · ${long.length}</h3>${long.map(compactCard).join('')||'<p class="hint-empty">暂无持续任务</p>'}</section></div>`;if(dayTab==='upcoming')body=upcoming(tasks).map(e=>`<div class="node-event"><span>${e.late?'!':'◆'}</span><button data-task="${esc(e.t.id)}"><strong>${esc(e.t.short_title||e.t.title)} · ${esc(e.label)}</strong><small>${esc(e.at.slice(0,16).replace('T',' '))}${e.late?' · 已逾期':''}</small></button></div>`).join('');if(dayTab==='journal')body=journalMarkup(date);const ro=!!state.share?.busy_only;if(ro&&['upcoming','journal'].includes(dayTab)){dayTab='agenda';return todayBoard(date,tasks)}return `${ro?'':dailyReminders(date,tasks)}<div class="day-tabs" role="tablist" aria-label="今日内容">${[['agenda','日程',events.length+long.length],['journal','手记',null]].filter(([id])=>!ro||!['upcoming','journal'].includes(id)).map(([id,label,n])=>`<button role="tab" aria-selected="${dayTab===id}" class="${dayTab===id?'active':''}" data-day-tab="${id}">${label}${n===null?'':' · '+n}</button>`).join('')}</div><div class="${dayTab==='upcoming'?'node-list':'agenda-list'}">${body||`<div class="empty-state">${$('#search').value||filter?'当前筛选下没有结果。可清除筛选查看全部安排。':'这里暂时没有安排。'}</div>`}</div>`}
// Update shared data without building the retired 18-week DOM first.
function renderSummary() {
  syncReadonly();
  cats = state.categories.map(c => c.name);
  if (filter && !cats.includes(filter)) filter = '';
  const category = $('#task-form').elements.category;
  const options = cats.map(c => `<option>${esc(c)}</option>`).join('');
  if (category.innerHTML !== options) {
    const selected = category.value;
    category.innerHTML = options;
    if (cats.includes(selected)) category.value = selected;
  }
  $('#profile-button').textContent = (state.user.remark ? state.user.remark + ' · ' : '') + '@' + state.user.name;
  const start = state.settings.start, week = Math.floor((Date.parse(today()) - Date.parse(start)) / 604800000) + 1;
  const pending = state.tasks.filter(t => !t.done), now = Date.now();
  $('#semester-name').textContent = state.settings.name;
  $('#range').textContent = state.readonly ? (state.share.enabled ? `${state.share.start} — ${state.share.end}` : '分享尚未开启') : `${start.replaceAll('-', '.')} — ${add(start, 125).replaceAll('-', '.')} · 18 周`;
  $('#week-stat').textContent = week < 1 ? '尚未开始' : week > 18 ? '学期已结束' : `第 ${week} / 18 周`;
  $('#progress-bar').style.width = Math.max(0, Math.min(100, (week - 1) / 18 * 100)) + '%';
  $('#pending-stat').textContent = pending.length;
  $('#soon-stat').textContent = pending.filter(t => t.due && Date.parse(t.due + '+08:00') >= now && Date.parse(t.due + '+08:00') <= now + 7 * 86400000).length;
  $('#late-stat').textContent = pending.filter(t => t.due && Date.parse(t.due + '+08:00') < now).length;
  $('#categories').innerHTML = `<button data-filter="" class="${!filter ? 'selected' : ''}">全部任务 <span>${state.tasks.length}</span></button>` + cats.map((c, i) => `<button data-filter="${esc(c)}" class="${filter === c ? 'selected' : ''}"><i class="dot cat-${i}"></i>${esc(c)}<span>${state.tasks.filter(t => t.category === c).length}</span></button>`).join('');
}
render=function(){if(!state)return;if(nextView==='week'&&followSevenDays)nextWeek=today();mode=nextView==='today'?'today':'all';renderSummary();const tasks=state.tasks.filter(matchesTask).sort(taskOrder),start=state.settings.start;let html='';$('#nav-week').classList.toggle('active',nextView==='week');$('#nav-all').classList.toggle('active',nextView==='all');$('#nav-today').classList.toggle('active',nextView==='today');for(const [id,v] of [['nav-week','week'],['nav-all','all'],['nav-today','today']])$('#'+id).setAttribute('aria-pressed',String(nextView===v));$('#week-navigation').hidden=nextView==='all';$('#course-scope').hidden=true;$('#current-period').textContent=nextView==='today'?nextWeek:nextWeek.slice(5)+' — '+add(nextWeek,6).slice(5);$('#previous-week').setAttribute('aria-label',nextView==='today'?'前一天':'前七天');$('#next-week').setAttribute('aria-label',nextView==='today'?'后一天':'后七天');$('#filter-summary').textContent=`${filter||'全部分类'} · ${tasks.length} 项任务${$('#search').value?' · 搜索：'+$('#search').value:''}${$('#hide-done').checked?' · 隐藏已完成':''} · 统计为全学期`;
if(state.readonly&&!state.share.enabled)html='<div class="empty-state">分享尚未开启，当前没有获准展示的日程。</div>';else if(nextView==='week')html=`<div class="board-heading"><h2>${nextWeek} — ${add(nextWeek,6)}</h2></div>${weekBoard(nextWeek,tasks,true)}`;else if(nextView==='today')html=`<div class="board-heading"><h2>${nextWeek} ${nextWeek===today()?'· 今天':''}</h2><div class="day-heading-actions">${dayAddButton(nextWeek)}</div></div>${todayBoard(nextWeek,tasks)}`;else{for(let w=0;w<18;w++){const lo=add(start,w*7),hi=add(lo,6);if(state.readonly&&(lo>state.share.end||hi<state.share.start))continue;const ts=tasks.filter(t=>t.date<=hi&&t.end_date>=lo),nodes=tasks.flatMap(t=>t.milestones||[]).filter(m=>m.stop_at.slice(0,10)>=lo&&m.stop_at.slice(0,10)<=hi);html+=`<details class="semester-week" id="semester-week-${w}" ${!matchMedia('(max-width:700px)').matches||lo<=today()&&today()<=hi?'open':''}><summary><strong>W${String(w+1).padStart(2,'0')}</strong><span>${lo.slice(5)} — ${hi.slice(5)}</span><small>${ts.length} 项任务${nodes.length?' · '+nodes.length+' 个节点':''} ${w>=16?'· 考试周':''}</small></summary><div>${weekBoard(lo,tasks)}</div></details>`}const outside=tasks.filter(t=>t.end_date<start||t.date>add(start,125));if(outside.length)html+=`<details class="semester-week" open><summary><strong>学期外</strong><small>${outside.length} 项任务</small></summary><div>${outside.map(compactCard).join('')}</div></details>`}
$('#calendar').innerHTML=html;$('#empty').hidden=true;$('#search').hidden=!!state.share?.busy_only;$('#hide-done').closest('label').hidden=!!state.share?.busy_only;$('#filter-summary').hidden=!!state.share?.busy_only;applyCategoryColors();applyDeadlineColors();layoutRanges();decorateIcons();};
function layoutRanges(){document.querySelectorAll('[data-range-start]').forEach(el=>{el.style.gridColumn=`${el.dataset.rangeStart} / ${el.dataset.rangeEnd}`});document.querySelectorAll('.node-rail').forEach(rail=>{const width=rail.clientWidth;if(!width)return;const pins=[...rail.querySelectorAll('.node-pin')];let placed=[];for(const pin of pins){if(!pin.dataset.originalLabel){pin.dataset.originalLabel=pin.querySelector('span').textContent;pin.dataset.originalTitle=pin.title;pin.dataset.originalDone=String(pin.classList.contains('completed'))}pin.hidden=false;pin.classList.remove('collision');pin.classList.toggle('completed',pin.dataset.originalDone==='true');pin.querySelector('span').textContent=pin.dataset.originalLabel;pin.querySelector('i').textContent=pin.dataset.originalDone==='true'?'✓':'◆';pin.title=pin.dataset.originalTitle}let groups=[];for(const pin of pins){const x=width*Number(pin.dataset.nodePosition)/100,last=groups.at(-1);if(last&&x-last.x<12){last.pins.push(pin);pin.hidden=true}else groups.push({x,pins:[pin]})}for(const group of groups){const pin=group.pins[0],pending=group.pins.find(p=>p.dataset.originalDone!=='true')||pin,x=group.x;pin.querySelector('span').textContent=pending.dataset.originalLabel+(group.pins.length>1?' +'+(group.pins.length-1):'');pin.title=group.pins.map(p=>p.dataset.originalTitle).join('\n');pin.classList.toggle('completed',group.pins.every(p=>p.dataset.originalDone==='true'));pin.querySelector('i').textContent=pin.classList.contains('completed')?'✓':'◆';pin.style.left=x+'px';pin.classList.toggle('to-left',x>width*.6);const labelWidth=Math.min(pin.scrollWidth,190),left=x>width*.6?x-labelWidth:x,right=left+labelWidth;if(left<0||right>width||placed.some(p=>left<p.right+5&&right>p.left-5))pin.classList.add('collision');else placed.push({left,right})}})}
window.addEventListener('resize',()=>{layoutRanges();setToolbarHeight()});
matchMedia('(max-width:700px)').addEventListener('change',()=>{if(state&&workspacePage==='home'&&nextView!=='today')render()});
function setToolbarHeight(){const height=$('.toolbar')?.offsetHeight;if(height)document.documentElement.style.setProperty('--toolbar-height',height+'px')}
function switchView(view){nextView=view;nextWeek=today();followSevenDays=true;mobileDate=today();render();$('.toolbar').scrollIntoView({block:'nearest'})}
$('#nav-week').onclick=()=>switchView('week');$('#nav-today').onclick=()=>switchView('today');$('#nav-all').onclick=()=>switchView('all');$('#previous-week').onclick=()=>{nextWeek=add(nextWeek,nextView==='today'?-1:-7);if(nextView==='week')followSevenDays=nextWeek===today();render()};$('#next-week').onclick=()=>{nextWeek=add(nextWeek,nextView==='today'?1:7);if(nextView==='week')followSevenDays=nextWeek===today();render()};$('#today-button').onclick=()=>{nextWeek=today();followSevenDays=true;mobileDate=today();render();if(nextView==='all'){const w=Math.floor((Date.parse(today())-Date.parse(state.settings.start))/604800000),el=$('#semester-week-'+w);if(el){el.open=true;el.scrollIntoView({block:'start'})}else toast('今天不在当前学期内')}else $('.toolbar').scrollIntoView({block:'nearest'})};
$('#filter-toggle').onclick=()=>{const open=$('#filter-panel').hidden;$('#filter-panel').hidden=!open;$('#filter-toggle').setAttribute('aria-expanded',String(open));if(open)$('#search').focus()};$('#clear-filter').onclick=()=>{filter='';$('#search').value='';$('#hide-done').checked=false;render()};
// Resolve the presentation renderer at event time, including later workspace wrappers.
$('#search').oninput=()=>render();$('#hide-done').onchange=()=>render();$('#show-courses').onchange=()=>render();
let mobileDate=today();const oldCalendarClick=$('#calendar').onclick;$('#calendar').onclick=e=>{const mobile=e.target.closest('[data-mobile-date]');if(mobile){mobileDate=mobile.dataset.mobileDate;render();return}const tab=e.target.closest('[data-day-tab]');if(tab){dayTab=tab.dataset.dayTab;render();return}const day=e.target.closest('[data-show-day]');if(day){nextView='today';nextWeek=day.dataset.showDay;dayTab='agenda';render();$('.toolbar').scrollIntoView({block:'nearest'});return}oldCalendarClick(e)};
$('#mobile-more').onclick=()=>{const aside=document.querySelector('aside'),open=aside.classList.toggle('more-open');$('#mobile-more').setAttribute('aria-expanded',String(open))};
// Detail tabs expose full information without making cards taller.
const oldTaskDetails=showTaskDetails;showTaskDetails=function(id){oldTaskDetails(id);const dialog=$('#task-details'),t=state.tasks.find(x=>x.id===id);if(!dialog||!t)return;const dl=dialog.querySelector('dl');const summary=document.createElement('p');summary.className='task-scope-note';summary.textContent=t.category+' · '+(t.done?'已完成':'待完成')+' · '+taskWhen(t,true);dl.before(summary);const tabs=document.createElement('div');tabs.className='detail-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','任务详情');tabs.innerHTML=[['overview','概览'],['nodes','节点 · '+(t.milestones||[]).length],['notes','备注']].map(([id,label])=>`<button role="tab" data-detail-tab="${id}">${label}</button>`).join('');dl.before(tabs);const pairs=[...dl.querySelectorAll('dt')].map(dt=>({dt,dd:dt.nextElementSibling,label:dt.textContent}));function select(tab){pairs.forEach(({dt,dd,label})=>{const shown=tab==='nodes'?label==='关键节点':tab==='notes'?label==='备注':!['关键节点','备注'].includes(label);dt.hidden=dd.hidden=!shown});tabs.querySelectorAll('button').forEach(b=>{const active=b.dataset.detailTab===tab;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active))})}tabs.onclick=e=>{const b=e.target.closest('button');if(b)select(b.dataset.detailTab)};select('overview');};
// Keep confirmation context outside the layout while retaining the original slider.
askConfirm=async function(message,label='确认操作'){
  if(confirmationPending)return false;
  const modal=window.DesktopModal?.currentView()||null,host=modal||document.body;
  if(!lastActionButton?.getClientRects().length||(modal&&!modal.contains(lastActionButton)))lastActionButton=[...(modal||document).querySelectorAll('button')].find(b=>b.matches('.primary')&&b.getClientRects().length)||[...(modal||document).querySelectorAll('button')].find(b=>b.getClientRects().length);
  const bar=document.createElement('div');bar.className='confirm-context-bar';bar.setAttribute('role','status');
  const text=document.createElement('span');text.className='confirm-context-text';text.textContent=message;text.title=message+' · 向右滑动确认，Esc 取消';bar.append(text);host.append(bar);
  try{
    const result=legacyConfirm(message,label),direct=host.querySelector(':scope > .direct-confirm-corner');
    if(direct)bar.append(direct);
    document.querySelectorAll('.confirm-in-place-label').forEach(el=>el.textContent='滑动确认');
    return await result;
  }finally{bar.remove()}
};
// Track actual edits rather than asking for confirmation after a read-only visit.
const oldCategoryOpen=$('#manage-categories').onclick;function categorySnapshot(){return JSON.stringify([...$('#category-dialog').querySelectorAll('input,select')].map(el=>[el.name,el.type==='checkbox'?el.checked:el.value]))}
$('#manage-categories').onclick=()=>{oldCategoryOpen();categoryBaseline=categorySnapshot()};const oldCategoryRows=categoryRows;categoryRows=function(){oldCategoryRows();prepareCategoryActions();const form=$('#category-form'),draft=Object.fromEntries([...form.elements].filter(el=>el.name).map(el=>[el.name,el.value]));form.reset();categoryBaseline=categorySnapshot();for(const [key,value] of Object.entries(draft))form.elements[key].value=value};$('#category-close').onclick=async()=>{if(categoryBusy)return;if(categorySnapshot()!==categoryBaseline){lastActionButton=$('#category-close');if(!await askConfirm('放弃未保存的分类修改？'))return}$('#category-form').reset();$('#category-dialog').close()};
// Optional fields remain one level away; invalid optional inputs are exposed.
const taskContent=$('#task-content-step'),optional=document.createElement('details');optional.className='task-optional';optional.innerHTML='<summary>截止、节点与备注（选填）</summary>';for(const name of ['short_title','due'])optional.append($('#task-form').elements[name].closest('label'));optional.append(taskContent.querySelector('.milestone-editor'));optional.append($('#task-form').elements.notes.closest('label'));optional.append($('#task-form').elements.done.closest('label'));taskContent.append(optional);$('#task-form').addEventListener('invalid',e=>{const d=e.target.closest('details');if(d)d.open=true},true);
// Account operations use peer tabs; the legacy select is only an internal field.
const accountForm=$('#account-form'),actionLabel=accountForm.elements.action.closest('label');actionLabel.hidden=true;const accountTabs=document.createElement('div');accountTabs.className='account-tabs';accountTabs.setAttribute('role','tablist');accountTabs.setAttribute('aria-label','账户设置');actionLabel.before(accountTabs);accountForm.elements.current_password.required=false;accountForm.elements.current_password.closest('label').hidden=true;
function updateAccountTabs(){accountTabs.hidden=['create','reset'].includes(accountForm.elements.action.value);profileTab.hidden=accountTabs.hidden;accountTabs.innerHTML=[['rename','修改用户名'],['self','修改密码'],...[]].map(([id,label])=>`<button type="button" role="tab" aria-selected="${accountForm.elements.action.value===id}" class="${accountForm.elements.action.value===id?'active':''}" data-account-tab="${id}">${label}</button>`).join('')}
const oldAccountAction=updateAccountAction;updateAccountAction=function(){oldAccountAction();accountForm.elements.current_password.required=false;accountForm.elements.current_password.closest('label').hidden=true;updateAccountTabs();const action=accountForm.elements.action.value;$('#account-dialog h2').textContent=['create','reset'].includes(action)?'账户管理':'账户设置';};
accountTabs.onclick=async e=>{const b=e.target.closest('[data-account-tab]');if(!b||accountBusy)return;if([...accountForm.querySelectorAll('input')].some(x=>x.value)){lastActionButton=b;if(!await askConfirm('切换操作并放弃当前输入？'))return}accountForm.reset();accountForm.elements.action.value=b.dataset.accountTab;updateAccountAction();$('#account-error').textContent=''};
// Personal profile remains an immediate peer entry, rather than an action dropdown.
const profileTab=document.createElement('button');profileTab.type='button';profileTab.textContent='个人资料';profileTab.className='profile-tab';accountTabs.before(profileTab);profileTab.onclick=async()=>{if(accountBusy)return;if([...accountForm.querySelectorAll('input')].some(input=>input.value)&&!await askConfirm('放弃当前输入？'))return;accountForm.reset();desktopModal.replace(()=>$('#profile-button').click())};
// Authentication has its own window; server-side verification remains unchanged.
const authDialog=document.createElement('dialog');authDialog.id='identity-dialog';authDialog.innerHTML=`<form id="identity-form"><div class="dialog-head"><h2>验证身份</h2><button type="button" data-auth-cancel aria-label="取消验证">×</button></div><div class="auth-brand">${uiIcon('lock')}<span>确认由你本人执行此操作</span></div><p class="auth-context" id="identity-context"></p><label>当前账户密码<input name="password" type="password" autocomplete="current-password" required></label><div class="dialog-actions"><button type="button" data-auth-cancel>返回编辑</button><button class="primary">验证并提交</button></div></form>`;document.body.append(authDialog);
async function identityPassword(context){if(authPending)throw Error('已有身份验证正在进行');authPending=true;$('#identity-context').textContent=context;const form=$('#identity-form');form.reset();return new Promise((resolve,reject)=>{let ended=false;function finish(password){if(ended)return;ended=true;form.reset();authDialog.close();authPending=false;if(password)resolve(password);else reject(Error('已取消身份验证，修改尚未提交'))}form.onsubmit=e=>{e.preventDefault();if(form.reportValidity())finish(form.elements.password.value)};authDialog.querySelectorAll('[data-auth-cancel]').forEach(b=>b.onclick=()=>finish(null));authDialog.oncancel=e=>{e.preventDefault();finish(null)};authDialog.showModal();form.elements.password.focus()})}
api=async function(path,method='GET',data){const gated=method!=='GET'&&['username','password','users','shares','dashboard-token'].includes(path)&&!(path==='shares'&&method==='PUT');if(!gated)return legacyApi(path,method,data);const context=path==='username'?'修改用户名为「'+data.name+'」':path==='password'?'修改当前账户密码，所有设备将退出登录':path==='dashboard-token'?(data.action==='rotate'?'生成新凭据并撤销旧凭据':'撤销 Dashboard 凭据'):path==='users'?(data.action==='create'?'创建账户「'+data.name+'」':'重置「'+data.name+'」的密码'):'执行展示账户管理操作';let password=await identityPassword(context);try{return await legacyApi(path,method,{...data,current_password:password})}finally{password='';if(data&&'current_password' in data)data.current_password=''}};
for(const input of document.querySelectorAll('#share-admin-form [name=current_password],#dashboard-token-secret')){input.required=false;input.closest('label').hidden=true}
changeDashboardToken=async function(action){if(!selectedShare||shareBusy)return;if(policyDirty()){$('#sharing-error').textContent='请先保存分享设置，再管理接入凭据';return}lastActionButton=$('#dashboard-token-'+action);if(!await askConfirm(action==='rotate'?'生成新凭据并立即撤销旧凭据？':'撤销此展示账户的接入凭据？'))return;shareBusy=true;try{const result=await api('dashboard-token','POST',{id:selectedShare.id,action});$('#dashboard-token-value').value=result.token||'';selectedShare.dashboard_token_enabled=!!result.token;$('#dashboard-token-status').textContent=result.token?'新凭据只显示一次，请立即保存。':'接入凭据已撤销。'}catch(e){$('#sharing-error').textContent=e.message}finally{shareBusy=false}};
$('#dashboard-token-rotate').onclick=()=>changeDashboardToken('rotate');$('#dashboard-token-revoke').onclick=()=>changeDashboardToken('revoke');
const tokenDetails=document.createElement('details');tokenDetails.className='task-optional';tokenDetails.innerHTML='<summary>高级 · Dashboard 接入</summary>';dashboardTokenBox.before(tokenDetails);tokenDetails.append(dashboardTokenBox);
// Critical task saves use the same confirmation language as delete and reschedule.
const oldTaskSubmit=$('#task-form').onsubmit;$('#task-form').onsubmit=async e=>{if(editing||taskStep===2){e.preventDefault();lastActionButton=$('#task-form .primary');if(!await askConfirm(editing?'保存任务修改？':'创建这项任务？'))return}return oldTaskSubmit(e)};
// Freshly opening the create form must not inherit the prior optional expansion.
const oldOpenTask=openTask;openTask=function(date,id,edit=false){optional.open=!!edit;oldOpenTask(date,id,edit)};
const oldSetTheme=setTheme;setTheme=function(theme,persist=true){oldSetTheme(theme,persist);if($('#theme-toggle'))$('#theme-toggle').innerHTML=uiIcon('sun')+(theme==='dark'?'浅色外观':'深色外观')};setTheme(storedTheme()||systemTheme(),false);
decorateIcons();setToolbarHeight();if(state)render();

const createAccountButton=document.createElement('button');createAccountButton.type='button';createAccountButton.textContent='创建普通账户';createAccountButton.className='primary';$('#accounts-search').closest('label').after(createAccountButton);createAccountButton.onclick=()=>{$('#account-button').click();accountForm.elements.action.value='create';updateAccountAction()};

const oldAccountSubmit=accountForm.onsubmit;accountForm.onsubmit=async e=>{e.preventDefault();if(accountBusy)return;if(!accountForm.reportValidity())return;lastActionButton=accountForm.querySelector('.primary');if(accountForm.elements.action.value!=='reset'&&!await askConfirm('确认提交此账户修改？接下来需验证身份。'))return;return oldAccountSubmit(e)};
// Courses: inspect your timetable, the public template, or adjustments at one depth.
const courseLists=window.CourseLists;
personalCoursesMarkup=function(){return courseLists.courses(personalCourseGroups(),(state.timetable||[]).length)};
courseOccurrenceList=function(rows){return courseLists.occurrences(rows,{today:today(),showName:true})};
bindCourseRows=function(container){container.querySelectorAll('[data-course-key]').forEach(button=>button.onclick=()=>{button.focus({preventScroll:true});showCourseDetails(button.dataset.courseKey,button.dataset.courseDate)})};
showCourseSeries=function(id){
 const group=personalCourseGroups().find(c=>c.course_id===id);if(!group||state.readonly)return;
 let dialog=$('#course-series-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='course-series-dialog';document.body.append(dialog)}
 const saved=dialog.dataset.courseId===id?courseLists.remember(dialog,dialog.querySelector('.course-series-scroll')||dialog):null;
 dialog.dataset.courseId=id;const slotIds=new Set((group.slots||[]).map(slot=>slot.slot_id));
 const rows=(state.course_dates||[]).filter(row=>row.course_id===id||slotIds.has(row.slot_id||row.course_key));
 dialog.innerHTML=`<div class="dialog-head"><h2>${esc(group.name)}</h2><button type="button" data-close aria-label="关闭">×</button></div><div class="course-series-overview">${courseLists.rules(group.slots||[])}</div><div class="course-series-actions"><button class="primary" type="button" data-extra>添加额外课程</button><a href="/timetables/?personal=1">编辑课程与时段 ↗</a></div><div class="course-series-scroll">${courseLists.grouped(rows,{today:today()})}</div>`;
 dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.querySelector('[data-extra]').onclick=()=>openCourseMakeup(id);bindCourseRows(dialog);courseLists.restore(dialog,saved,dialog.querySelector('.course-series-scroll'));dialog.showModal();
};
renderCourseChanges=function(){
 const host=$('#personal-course-changes'),scroll=$('#course-body')||host,saved=courseLists.remember(host,scroll);
 const rows=(state.course_dates||[]).filter(row=>row.cancelled||row.adjusted||row.archived||['extra','makeup'].includes(row.kind));
 host.innerHTML=courseLists.grouped(rows,{today:today(),changes:true});bindCourseRows(host);courseLists.restore(host,saved,scroll);
};
const courseTabs=document.createElement('div');courseTabs.className='detail-tabs';courseTabs.setAttribute('role','tablist');courseTabs.setAttribute('aria-label','课表内容');$('#course-preview').before(courseTabs);let courseTab='personal';
function nextCoursePreview(){
 courseTabs.innerHTML=[['personal','我的课程'],['template','可用模板'],['changes','临时调整']].map(([id,label])=>`<button role="tab" aria-selected="${id===courseTab}" class="${id===courseTab?'active':''}" data-course-tab="${id}">${label}</button>`).join('');
 $('#course-preview').hidden=courseTab==='changes';$('#personal-course-changes').hidden=courseTab!=='changes';$('#course-admin').hidden=true;$('#import-courses').hidden=true;
 if(courseTab==='personal'){$('#course-preview').innerHTML=personalCoursesMarkup();$('#course-preview').querySelectorAll('[data-course-series]').forEach(button=>button.onclick=()=>showCourseSeries(button.dataset.courseSeries))}
 if(courseTab==='template')$('#course-preview').innerHTML='<p>可用模板可分别预览、合并导入或更新，已有个人修改会在差异预览中保留。</p><p><a href="/timetables/">打开课表模板设计器</a></p>';
 renderCourseChanges();if(courseTab==='changes'&&!$('#personal-course-changes').textContent)$('#personal-course-changes').innerHTML='<div class="empty-state">暂时没有临时调整与停课记录。</div>';
}
const oldTimetableOpen=$('#timetable-button').onclick;$('#timetable-button').onclick=async()=>{await oldTimetableOpen();if($('#timetable-dialog').open){$('#timetable-dialog h2').textContent='课程安排';courseTab='personal';nextCoursePreview()}};courseTabs.onclick=e=>{const b=e.target.closest('[data-course-tab]');if(b){courseTab=b.dataset.courseTab;nextCoursePreview()}};
$('#import-courses').onclick=()=>{location.href='/timetables/'};
const shareAction=$('#share-admin-form').elements.action,shareActionLabel=shareAction.closest('label');shareActionLabel.hidden=true;const shareAdminTabs=document.createElement('div');shareAdminTabs.className='detail-tabs';shareActionLabel.before(shareAdminTabs);const oldAdminVisibility=adminVisibility;adminVisibility=function(){oldAdminVisibility();shareAdminTabs.innerHTML=[['create','创建'],['rebind','绑定'],['active','登录状态']].map(([id,label])=>`<button type="button" aria-pressed="${shareAction.value===id}" class="${shareAction.value===id?'active':''}" data-share-action="${id}">${label}</button>`).join('')};shareAdminTabs.onclick=e=>{const b=e.target.closest('[data-share-action]');if(b&&!shareBusy){shareAction.value=b.dataset.shareAction;adminVisibility()}};
window.addEventListener('beforeunload',e=>{if(authPending){e.preventDefault();e.returnValue=''}});
$('#save-courses').onclick=()=>{location.href='/timetables/'};
// Course cards use the same two-line rhythm as tasks, retaining detail actions.
courseBlocks=function(rows){return rows.filter(c=>!c.cancelled).map(c=>{const title=[c.name,c.date,c.time,c.room,c.adjusted?'原安排：'+c.original_date+' '+c.original_time:''].filter(Boolean).join(' · ');const body=`<strong><span class="course-name">${esc(c.name)}${c.kind==='makeup'?' · 补课':c.kind==='extra'?' · 加课':c.adjusted?' · 已调课':''}</span>${c.homework_required?`<span class="course-homework-badge ${c.homework_done?'homework-done':''}" title="作业${c.homework_done?'已完成':'未完成'}" aria-label="作业${c.homework_done?'已完成':'未完成'}">HW</span>`:''}</strong><small>${esc(c.time)}${c.room?' · '+esc(c.room):''}</small>`;return `<div class="course-note compact-course ${c.cancelled?'course-cancelled':''}" title="${esc(title)}">${state.readonly?body:`<button class="course-open" data-course-key="${esc(c.course_key)}" data-course-date="${esc(c.original_date)}">${body}</button>`}</div>`}).join('')};
if(state)render();
// Low-frequency utilities have one entry and a stable peer-tab window.
const utilityDialog=document.createElement('dialog');utilityDialog.id='utility-dialog';utilityDialog.innerHTML='<div class="dialog-head"><h2>设置与导出</h2><button type="button" id="utility-close" aria-label="关闭设置">×</button></div><div class="detail-tabs" role="tablist" aria-label="设置与导出"><button role="tab" data-utility-tab="settings">设置</button><button role="tab" data-utility-tab="export">导出</button></div>';document.body.append(utilityDialog);const utilities=document.querySelector('.side-bottom');utilityDialog.append(utilities);const utilityGroups=[...utilities.querySelectorAll(':scope > details')];let utilityTab='settings';
function selectUtility(tab){utilityTab=tab;utilityGroups.forEach((group,i)=>{group.open=true;group.hidden=i!==(tab==='settings'?0:1);group.querySelector('summary').hidden=true});utilityDialog.querySelectorAll('[data-utility-tab]').forEach(b=>{const active=b.dataset.utilityTab===tab;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active))})}
$('#mobile-more').innerHTML=uiIcon('settings')+'设置与导出';$('#mobile-more').setAttribute('data-icon','settings');$('#mobile-more').onclick=()=>{selectUtility('settings');$('#mobile-more').setAttribute('aria-expanded','true');utilityDialog.showModal()};$('#utility-close').onclick=()=>utilityDialog.close();utilityDialog.addEventListener('close',()=>$('#mobile-more').setAttribute('aria-expanded','false'));utilityDialog.querySelector('.detail-tabs').onclick=e=>{const b=e.target.closest('[data-utility-tab]');if(b)selectUtility(b.dataset.utilityTab)};
// Settings stay mounted behind their child pages.
// Categories tint a neutral surface; the calendar itself does not carry category color.
function blendSurface(color,base,amount){const parse=hex=>hex.replace('#','').match(/../g).map(x=>parseInt(x,16)),a=parse(color),b=parse(base);return '#'+a.map((v,i)=>Math.round(v*amount+b[i]*(1-amount)).toString(16).padStart(2,'0')).join('')}
applyCategoryColors=function(){if(!state)return;const dark=document.documentElement.dataset.theme==='dark',base=dark?'#23342b':'#ffffff',ink=dark?'#e1ebe3':'#293e35';state.categories.forEach((c,i)=>document.querySelectorAll('.cat-'+i).forEach(el=>{const dot=el.classList.contains('dot');el.style.backgroundColor=dot?c.color:blendSurface(c.color,base,dark?.13:.065);el.style.color=ink;el.style.borderColor=dark?tint(c.color,.18):c.color}))};
if(state)applyCategoryColors();
const initialDeadlineColor=deadlineColor;deadlineColor=function(t){if(document.documentElement.dataset.theme!=='dark')return initialDeadlineColor(t);if(t.done)return '#a5b6aa';const category=state.categories.find(c=>c.name===t.category)||{},days=(Date.parse(t.due+'+08:00')-Date.now())/86400000;return days<=(category.urgent_days??2)?'#f2a398':days<=(category.warn_days??7)?'#dfc87d':category.color?tint(category.color,.65):'#c7d5cb'};if(state)applyDeadlineColors();
// Sharing: account overview -> one editor, with peer tabs and a fixed action bar.
const sharingDialog=$('#sharing-dialog'),shareForm=$('#share-policy'),shareOverview=document.createElement('div');shareOverview.id='share-overview';const shareListHeading=sharingDialog.querySelector(':scope > h3');shareListHeading.textContent='展示账户';for(const el of [shareListHeading,$('#my-shares'),$('#share-admin')])shareOverview.append(el);sharingDialog.querySelector('.dialog-head').after(shareOverview);
const shareEditor=document.createElement('div');shareEditor.id='share-editor';shareEditor.hidden=true;shareEditor.innerHTML='<div class="share-editor-heading"><button type="button" id="share-back">← 账户列表</button><button type="button" id="share-preview-current">预览已保存设置</button></div><div class="detail-tabs" role="tablist" aria-label="分享设置"><button type="button" role="tab" data-policy-tab="range">分享范围</button><button type="button" role="tab" data-policy-tab="content">展示内容</button><button type="button" role="tab" data-policy-tab="integration">Dashboard 接入</button></div>';shareOverview.after(shareEditor);shareEditor.querySelector('.share-editor-heading').after($('#share-policy-title'));shareEditor.append(shareForm);
const policyPanels={};for(const name of ['range','content','integration']){const panel=document.createElement('div');panel.className='share-panel';panel.dataset.policyPanel=name;policyPanels[name]=panel;shareForm.append(panel)}
const takeLabel=(name,panel)=>panel.append(shareForm.elements[name].closest('label'));
for(const name of ['enabled','busy_only','range'])takeLabel(name,policyPanels.range);policyPanels.range.append($('#share-custom'));
policyPanels.content.append($('#share-categories').closest('fieldset'));for(const name of ['done','notes','journal'])takeLabel(name,policyPanels.content);policyPanels.content.append($('#share-journal-dates'));for(const name of ['timetable','export'])takeLabel(name,policyPanels.content);
policyPanels.integration.append(dashboardTokenBox);tokenDetails.remove();shareForm.querySelectorAll(':scope > p').forEach(p=>p.remove());const policyFooter=document.createElement('div');policyFooter.className='share-editor-footer';policyFooter.append(shareForm.querySelector('.primary'));policyFooter.querySelector('button').setAttribute('form','share-policy');shareEditor.append(policyFooter);
let policyTab='range';function selectPolicyTab(tab){policyTab=tab;for(const [name,panel] of Object.entries(policyPanels))panel.hidden=name!==tab;shareEditor.querySelectorAll('[data-policy-tab]').forEach(b=>{const active=b.dataset.policyTab===tab;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active))});shareForm.scrollTop=0;policyFooter.hidden=tab==='integration'}
function shareOverviewMode(){shareOverview.hidden=false;shareEditor.hidden=true;sharingDialog.scrollTop=0}
const originalLoadShares=loadShares;loadShares=async function(){await originalLoadShares();shareOverviewMode()};const originalSelectShare=selectShare;selectShare=async function(id){if(shareBusy)return;await originalSelectShare(id);if(selectedShare?.id!==id)return;shareOverview.hidden=true;shareEditor.hidden=false;shareForm.hidden=false;selectPolicyTab('range');sharingDialog.scrollTop=0};shareEditor.querySelector('.detail-tabs').onclick=e=>{const b=e.target.closest('[data-policy-tab]');if(b&&!shareBusy)selectPolicyTab(b.dataset.policyTab)};
$('#share-back').onclick=async()=>{if(shareBusy)return;lastActionButton=$('#share-back');if(policyDirty()&&!await askConfirm('返回账户列表并放弃未保存的分享修改？'))return;selectedShare=null;shareForm.hidden=true;shareOverviewMode()};$('#share-preview-current').onclick=()=>{if(selectedShare&&!shareBusy)$('#my-shares').querySelector(`[data-share-preview="${selectedShare.id}"]`)?.click()};shareForm.addEventListener('invalid',e=>{const panel=e.target.closest('[data-policy-panel]');if(panel)selectPolicyTab(panel.dataset.policyPanel)},true);
// Reserve one scrollable course body; the tabs and footer stay outside it.
const courseDialog=$('#timetable-dialog'),courseBody=document.createElement('div');courseBody.id='course-body';$('#course-preview').before(courseBody);for(const element of [$('#course-preview'),$('#personal-course-changes'),$('#course-admin')])courseBody.append(element);const courseFooter=document.createElement('div');courseFooter.className='course-footer';courseBody.after(courseFooter);courseFooter.append($('#import-courses'));courseFooter.append($('#course-error'));

const confirmedLogout=$('#logout-button').onclick;$('#logout-button').onclick=async()=>{lastActionButton=$('#logout-button');await confirmedLogout();if(!state)utilityDialog.close()};
// Two quiet, bounded prompt panels after the summary statistics.
const contextPanels=document.createElement('section');contextPanels.className='context-panels';contextPanels.setAttribute('aria-label','近期提示');document.querySelector('.stats').after(contextPanels);
let contextMarkup='';
function renderContextHints(){if(!state)return;const now=Date.now(),courses=courseTimeHints(state.course_dates||[],now),busyOnly=!!state.share?.busy_only;const courseHint=(row,label)=>row?`<div class="course-hint"><span>${label}</span><div><strong>${esc(row.course.name)}</strong><small>${esc(row.course.date.slice(5))} ${esc(row.course.time)}${row.course.room?' · '+esc(row.course.room):''}</small></div></div>`:'';const courseHtml=courseHint(courses.current[0],busyOnly?'正在占用':'正在上课')+courseHint(courses.next,busyOnly?'下次占用':'下一节课');const groups=busyOnly?[]:taskTimeHints(state.tasks,now);const html=`<section class="context-panel"><h2>${busyOnly?'占用提示':'课程提示'}</h2><div class="context-body">${courseHtml||'<p class="hint-empty">暂无可展示的课程安排</p>'}</div></section>${busyOnly?'':`<section class="context-panel"><h2>待处理时间点 </h2><div class="context-body">${groups.map(({task,points})=>`<button class="task-hint" data-hint-task="${esc(task.id)}"><strong title="${esc(task.title)}">${esc(task.short_title||task.title)}</strong><span>${points.map(p=>`<span class="hint-point ${p.ms<now?'past':''}">${p.done?'✓ ':''}${esc(p.label)} ${esc(p.dateOnly?p.at.slice(5,10)+'（按日期）':p.at.slice(5,16).replace('T',' '))}</span>`).join('')}</span></button>`).join('')||'<p class="hint-empty">暂无过去未完成或未来 12 小时内的时间点</p>'}</div></section>`}`;if(contextMarkup!==html){contextMarkup=html;const scrolls=[...contextPanels.querySelectorAll('.context-body')].map(el=>el.scrollTop),active=document.activeElement?.closest('[data-hint-task]')?.dataset.hintTask;contextPanels.innerHTML=html;contextPanels.querySelectorAll('.context-body').forEach((el,i)=>el.scrollTop=scrolls[i]||0);if(active)[...contextPanels.querySelectorAll('[data-hint-task]')].find(el=>el.dataset.hintTask===active)?.focus({preventScroll:true})}}
contextPanels.onclick=e=>{const button=e.target.closest('[data-hint-task]');if(button)openTask(null,button.dataset.hintTask)};const renderBeforeHints=render;render=function(){renderBeforeHints();renderContextHints()};setInterval(()=>{if(state){renderContextHints();refreshSevenDayClock()}},60000);document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state){renderContextHints();refreshSevenDayClock()}});if(state)renderContextHints();
// Peer task tabs keep a single draft; only the final review can submit it.
const taskForm=$('#task-form'),taskTabs=document.createElement('nav'),taskBody=document.createElement('div');
taskTabs.className='detail-tabs';taskTabs.setAttribute('role','tablist');taskTabs.setAttribute('aria-label','任务编辑');taskTabs.innerHTML=[['content','内容'],['time','时间'],['nodes','节点'],['review','确认提交']].map(([id,label])=>`<button type="button" role="tab" data-task-tab="${id}">${label}</button>`).join('');taskBody.className='task-editor-body';taskForm.querySelector('.dialog-head').after(taskTabs);taskTabs.after(taskBody);
const taskPanels={content:taskContent,time:$('#task-time-step'),nodes:document.createElement('div'),review:document.createElement('div')};for(const panel of Object.values(taskPanels))taskBody.append(panel);
for(const name of ['short_title','notes','done'])taskContent.append(taskForm.elements[name].closest('label'));taskPanels.time.append(taskForm.elements.due.closest('label'));taskPanels.nodes.append(optional.querySelector('.milestone-editor'));optional.remove();
taskForm.noValidate=true;let taskTab='content';
function taskDraft(){const data=Object.fromEntries(new FormData(taskForm));data.done=taskForm.elements.done.checked;data.milestones=JSON.parse(data.milestones);if(data.schedule_mode==='date')data.start_time=data.end_time='';if(editing)data.version=editing.version;return data}
function taskReview(){const d=taskDraft(),conflicts=conflictNames(d,editing?.id);taskPanels.review.innerHTML=`<h3>${esc(d.title||'未填写任务名称')}</h3><dl class="task-parameters"><dt>分类</dt><dd>${esc(d.category)}</dd><dt>简称</dt><dd>${esc(d.short_title||'无')}</dd><dt>计划</dt><dd>${esc(taskWhen(d,true))}</dd><dt>截止</dt><dd>${esc(d.due?.replace('T',' ')||'未设置')}</dd><dt>节点</dt><dd>${d.milestones.map(m=>esc((m.done?'✓ ':'')+(m.label||'关键节点')+' · '+milestoneTime(m))).join('<br>')||'无'}</dd><dt>备注</dt><dd>${esc(d.notes||'无')}</dd><dt>状态</dt><dd>${d.done?'已完成':'待完成'}</dd></dl>${conflicts.length?`<p class="conflict-note">时间重叠：${esc(conflicts.join('、'))}。提交即确认保留这些安排。</p>`:''}<p>检查以上内容，再滑动确认${editing?'保存修改':'创建任务'}。</p>`}
function selectTaskTab(tab){taskTab=tab;for(const [name,panel] of Object.entries(taskPanels))panel.hidden=name!==tab;taskTabs.querySelectorAll('button').forEach(b=>{const active=b.dataset.taskTab===tab;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active))});$('#task-back').hidden=true;$('#delete-button').hidden=true;taskForm.querySelector('.primary').textContent=tab==='review'?(editing?'保存修改':'创建任务'):'检查并提交';taskBody.scrollTop=0;if(tab==='review')taskReview()}
function validateTaskDraft(){const invalid=[...taskForm.elements].find(el=>el.willValidate&&!el.validity.valid);if(invalid){const pane=Object.entries(taskPanels).find(([,p])=>p.contains(invalid));if(pane)selectTaskTab(pane[0]);invalid.reportValidity();return false}const d=taskDraft();if(d.end_date<d.date||d.schedule_mode==='minute'&&(!d.start_time||!d.end_time||d.date+'T'+d.start_time>=d.end_date+'T'+d.end_time)){selectTaskTab('time');$('#task-error').textContent='结束日期／时间必须晚于开始时间，按日期时可为同一天';return false}$('#task-error').textContent='';return true}
taskTabs.onclick=e=>{const b=e.target.closest('[data-task-tab]');if(!b||busy||confirmationPending)return;if(b.dataset.taskTab==='review'&&!validateTaskDraft())return;selectTaskTab(b.dataset.taskTab)};
const openBeforeTabs=openTask;openTask=function(date,id,edit=false){openBeforeTabs(date,id,edit);if($('#task-dialog').open){$('#task-heading').textContent=editing?'编辑任务':'新建任务';selectTaskTab('content')}};
taskForm.onsubmit=async e=>{e.preventDefault();if(busy||confirmationPending||!validateTaskDraft())return;if(taskTab!=='review'){selectTaskTab('review');return}lastActionButton=taskForm.querySelector('.primary');if(!await askConfirm(editing?'保存以上任务修改？':'创建以上任务？'))return;const data=taskDraft();try{if(await mutation(()=>api(editing?'tasks/'+editing.id:'tasks',editing?'PUT':'POST',data)))$('#task-dialog').close()}catch(error){$('#task-error').textContent=error.message}};
// Template maintenance has peer tabs rather than an expanding JSON form.
const courseAdmin=$('#course-admin'),templateEditor=document.createElement('section');templateEditor.id='template-editor';while(courseAdmin.firstChild){const child=courseAdmin.firstChild;if(child.tagName==='SUMMARY')child.remove();else templateEditor.append(child)}courseAdmin.replaceWith(templateEditor);
// Keep the compatibility ID for the existing permission/client bindings.
templateEditor.id='course-admin';const templateTabs=document.createElement('nav');templateTabs.className='detail-tabs';templateTabs.innerHTML='<button type="button" data-template-tab="courses" class="active">课程模板</button><button type="button" data-template-tab="holidays">停课日期</button>';templateEditor.prepend(templateTabs);const holidayHeading=templateEditor.querySelector('h3');function selectTemplateTab(tab){const courses=tab==='courses';$('#course-json').hidden=!courses;holidayHeading.hidden=$('#holiday-json').hidden=courses;templateTabs.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.templateTab===tab))}templateTabs.onclick=e=>{const b=e.target.closest('[data-template-tab]');if(b)selectTemplateTab(b.dataset.templateTab)};selectTemplateTab('courses');
// Administrative viewer operations belong to account management, not personal sharing.
const adminSection=document.createElement('section');adminSection.id='viewer-admin';const oldShareAdmin=$('#share-admin');while(oldShareAdmin.firstChild){const child=oldShareAdmin.firstChild;if(child.tagName==='SUMMARY')child.remove();else adminSection.append(child)}oldShareAdmin.replaceWith(adminSection);const adminCompatibility=document.createElement('span');adminCompatibility.id='share-admin';adminCompatibility.hidden=true;sharingDialog.append(adminCompatibility);$('#accounts-dialog').append(adminSection);adminSection.hidden=true;
const managementTabs=document.createElement('nav');managementTabs.className='detail-tabs';managementTabs.innerHTML='<button type="button" class="active" data-management-tab="accounts">全部账户</button><button type="button" data-management-tab="viewers">展示账户</button>';$('#accounts-summary').before(managementTabs);const adminError=document.createElement('p');adminError.id='viewer-admin-error';adminError.setAttribute('role','alert');adminSection.append(adminError);
function managementTab(tab){const viewer=tab==='viewers';adminSection.hidden=!viewer;$('#share-admin-form').hidden=viewer&&!viewerAdminLoaded;for(const el of [$('#accounts-summary'),$('#accounts-search').closest('label'),createAccountButton,$('#accounts-list'),$('#accounts-error')])el.hidden=viewer;managementTabs.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.managementTab===tab))}
managementTabs.onclick=async e=>{const b=e.target.closest('[data-management-tab]');if(!b||shareBusy)return;managementTab(b.dataset.managementTab);if(b.dataset.managementTab==='viewers'&&!viewerAdminLoaded)try{adminError.textContent='正在加载展示账户…';await originalLoadShares();viewerAdminLoaded=true;viewerDraftBaseline=viewerDraftSnapshot();$('#share-admin-form').hidden=false;adminError.textContent=''}catch(error){adminError.textContent=error.message}};
const accountManagementOpen=$('#accounts-button').onclick;$('#accounts-button').onclick=async()=>{viewerAdminLoaded=false;viewerDraftBaseline='';$('#share-admin-form').reset();adminError.textContent='';managementTab('accounts');await accountManagementOpen()};
$('#share-admin-form').onsubmit=async e=>{
  e.preventDefault();if(shareBusy||confirmationPending)return;
  const form=e.target,data=Object.fromEntries(new FormData(form));data.id=Number(data.id);data.owner_id=Number(data.owner_id);data.active=form.elements.active.checked;
  adminError.textContent='';
  if(data.action==='create'&&data.password!==data.confirm){adminError.textContent='两次密码不一致';return}
  lastActionButton=form.querySelector('.primary');
  if(!await askConfirm(data.action==='rebind'?'重新绑定会清空原授权并退出全部旧会话，确认？':'确认执行展示账户操作？'))return;
  shareBusy=true;
  try{
    await api('shares','POST',data);form.reset();await originalLoadShares();viewerDraftBaseline=viewerDraftSnapshot();
    accountRows=(await api('users')).accounts;renderAccounts();toast('操作成功；新建或重新绑定后需日程所有者开启分享');
  }catch(error){adminError.textContent=error.message}finally{shareBusy=false}
};
// Only calendar weeks and the short category list retain native disclosure controls.
const categoryDisclosure=$('#category-section'),categoryContainer=document.createElement('section');categoryContainer.id='category-section';while(categoryDisclosure.firstChild){const child=categoryDisclosure.firstChild;if(child.tagName==='SUMMARY'){const h=document.createElement('div');h.className='side-caption';h.textContent=child.textContent;categoryContainer.append(h);child.remove()}else categoryContainer.append(child)}categoryDisclosure.replaceWith(categoryContainer);
// The outer modal stays open while existing dialog objects act as internal pages.
function modalViewStamp(dialog){
  if(!state)return null;
  if(['task-details','deferred-details'].includes(dialog.id)){
    const task=[...state.tasks,...(state.deferred_tasks||[])].find(t=>t.id===dialog.dataset.taskId);
    return task?String(task.version):'missing';
  }
  if(['course-series-dialog','timetable-dialog'].includes(dialog.id))return JSON.stringify({plan:state.course_plan,rows:state.course_dates});
  if(dialog.id==='course-details')return JSON.stringify(state.course_dates?.find(c=>c.course_key===dialog.dataset.courseKey&&c.original_date===dialog.dataset.courseDate)||null);
  return null;
}
const desktopModal=window.DesktopModal=ModalShell.install({
  stamp:modalViewStamp,
  resume:dialog=>refreshReturnedDetails(dialog),
  canDismiss:dialog=>dialog.classList.contains('task-conflict-dialog')||!(busy||accountBusy||courseSaving||shareBusy||confirmationPending)
});
// A selected sharing editor returns to its account list before leaving sharing.
closeSharing=async function(){if(shareBusy)return;if(!shareEditor.hidden){await $('#share-back').onclick();return}$('#dashboard-token-value').value='';sharingDialog.close()};$('#sharing-close').onclick=closeSharing;
let viewerDraftBaseline='',viewerAdminLoaded=false;function viewerDraftSnapshot(){return JSON.stringify(Object.fromEntries(new FormData($('#share-admin-form'))))}
const managementTabBeforeGuard=managementTab;managementTab=function(tab){managementTabBeforeGuard(tab);};
const closeAccounts=async()=>{if(shareBusy||accountBusy)return;if(viewerAdminLoaded&&viewerDraftSnapshot()!==viewerDraftBaseline){lastActionButton=$('#accounts-close');if(!await askConfirm('放弃未提交的展示账户管理操作？'))return;$('#share-admin-form').reset();viewerDraftBaseline=viewerDraftSnapshot()}$('#accounts-dialog').close()};$('#accounts-close').onclick=closeAccounts;$('#accounts-dialog').addEventListener('cancel',e=>{e.preventDefault();closeAccounts()});

// Creation and editing of categories are peers, keeping reminder fields off the list.
const categoryTabs=document.createElement('nav');categoryTabs.className='detail-tabs';categoryTabs.innerHTML='<button type="button" class="active" data-category-tab="existing">已有分类</button><button type="button" data-category-tab="new">新增分类</button>';$('#category-rows').before(categoryTabs);function selectCategoryTab(tab){$('#category-rows').hidden=tab!=='existing';$('#category-form').hidden=tab!=='new';$('.category-add-heading').hidden=tab!=='new';categoryTabs.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.categoryTab===tab))}categoryTabs.onclick=e=>{const b=e.target.closest('[data-category-tab]');if(b&&!categoryBusy)selectCategoryTab(b.dataset.categoryTab)};selectCategoryTab('existing');
// Disclosure wrappers in the utility window no longer carry disclosure semantics.
for(let i=0;i<utilityGroups.length;i++){const details=utilityGroups[i],section=document.createElement('section');section.hidden=details.hidden;while(details.firstChild){if(details.firstChild.tagName==='SUMMARY')details.firstChild.remove();else section.append(details.firstChild)}details.replaceWith(section);utilityGroups[i]=section}
DialogEffects.mount(utilityGroups[0]);
selectUtility=function(tab){utilityTab=tab;utilityGroups.forEach((group,i)=>group.hidden=i!==(tab==='settings'?0:1));utilityDialog.querySelectorAll('[data-utility-tab]').forEach(b=>{const active=b.dataset.utilityTab===tab;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active))})};
function dailyReminders(date,tasks){const end=Date.parse(date+'T23:59:59+08:00'),now=Math.min(Date.now(),end),rows=[];for(const task of tasks){if(task.done)continue;const points=[];if(task.due)points.push({label:'截止',at:task.due});for(const m of task.milestones||[])if(!m.done)points.push({label:m.label||'节点',at:m.stop_at});for(const point of points){const at=Date.parse(point.at.endsWith('+08:00')?point.at:point.at+'+08:00');if(at<=end)rows.push({task,...point,ms:at,late:at<now})}}rows.sort((a,b)=>a.ms-b.ms);if(!rows.length)return '';return `<section class="daily-reminders" aria-label="待办提醒"><h3>待办提醒 <span>${rows.length} 项未完成 · 逾期与当天到期</span></h3><div>${rows.map(row=>`<button class="${row.late?'overdue':''}" data-task="${esc(row.task.id)}"><span>${row.late?'!':'◆'}</span><strong>${esc(row.task.short_title||row.task.title)} · ${esc(row.label)}</strong><small>${esc(row.at.slice(5,16).replace('T',' '))}${row.late?' · 已逾期':''}</small></button>`).join('')}</div></section>`}
const taskDetailsBeforeReturn=showTaskDetails;showTaskDetails=function(id){taskDetailsBeforeReturn(id);const dialog=$('#task-details');if(dialog)dialog.dataset.taskId=id};const courseDetailsBeforeReturn=showCourseDetails;showCourseDetails=function(key,date){courseDetailsBeforeReturn(key,date);const dialog=$('#course-details');if(dialog){dialog.dataset.courseKey=key;dialog.dataset.courseDate=date}};
function refreshReturnedDetails(dialog){
  if(dialog.id==='course-series-dialog'&&dialog.dataset.courseId)showCourseSeries(dialog.dataset.courseId);
  if(dialog.id==='timetable-dialog')nextCoursePreview();
  if(dialog.id==='task-details'&&dialog.dataset.taskId){
    if(!state.tasks.some(t=>t.id===dialog.dataset.taskId)){dialog.close();return}
    const tab=dialog.querySelector('[data-detail-tab].active')?.dataset.detailTab;
    showTaskDetails(dialog.dataset.taskId);if(tab)dialog.querySelector(`[data-detail-tab="${tab}"]`)?.click();
  }
  if(dialog.id==='course-details'&&dialog.dataset.courseKey){
    const tab=dialog.querySelector('[data-course-detail-tab].active')?.dataset.courseDetailTab;
    showCourseDetails(dialog.dataset.courseKey,dialog.dataset.courseDate);if(tab)dialog.querySelector(`[data-course-detail-tab="${tab}"]`)?.click();
  }
}
// Preview returns to the same sharing editor rather than the dashboard root.
let sharePreviewReturn=null;const personalShareClick=$('#my-shares').onclick;$('#my-shares').onclick=async e=>{const preview=e.target.closest('[data-share-preview]');if(preview)sharePreviewReturn={id:Number(preview.dataset.sharePreview),tab:policyTab};await personalShareClick(e)};const exitPreviewBeforeReturn=$('#exit-preview').onclick;$('#exit-preview').onclick=async()=>{await exitPreviewBeforeReturn();if(sharePreviewReturn&&!state.readonly){const target=sharePreviewReturn;sharePreviewReturn=null;await loadShares();sharingDialog.showModal();await selectShare(target.id);selectPolicyTab(target.tab)}};
// Category migration is a child window with explicit context, not an expanding row.
const categoryMoveDialog=document.createElement('dialog');categoryMoveDialog.id='category-move-dialog';categoryMoveDialog.innerHTML='<form id="category-move-form"><div class="dialog-head"><h2>迁移并删除分类</h2><button type="button" data-close aria-label="返回分类管理">×</button></div><p id="category-move-context"></p><label>接收任务的分类<select name="target" required></select></label><p data-error role="alert"></p><button class="primary">迁移并删除</button></form>';document.body.append(categoryMoveDialog);
function prepareCategoryActions(){for(const row of $('#category-rows').querySelectorAll('form')){row.dataset.sourceName=state.categories[Number(row.dataset.categoryIndex)].name;row.dataset.persisted=JSON.stringify(Object.fromEntries(new FormData(row)))}for(const detail of $('#category-rows').querySelectorAll('.category-remove')){const row=detail.closest('form'),index=Number(row.dataset.categoryIndex),button=document.createElement('button');button.type='button';button.textContent='迁移 / 删除';button.dataset.moveCategory=state.categories[index].name;button.disabled=state.categories.length===1;detail.replaceWith(button);row.dataset.persisted=JSON.stringify(Object.fromEntries(new FormData(row)))}}
$('#category-rows').addEventListener('click',e=>{const button=e.target.closest('[data-move-category]');if(!button||categoryBusy)return;const name=button.dataset.moveCategory;categoryMoveDialog.dataset.category=name;$('#category-move-context').textContent='将「'+name+'」的全部任务迁移到选定分类，然后删除原分类。';categoryMoveDialog.querySelector('select').innerHTML='<option value="">请选择接收分类</option>'+state.categories.filter(c=>c.name!==name).map(c=>`<option>${esc(c.name)}</option>`).join('');categoryMoveDialog.querySelector('[data-error]').textContent='';categoryMoveDialog.showModal()});
categoryMoveDialog.querySelector('[data-close]').onclick=()=>{if(!categoryBusy)categoryMoveDialog.close()};categoryMoveDialog.oncancel=e=>{if(categoryBusy)e.preventDefault()};$('#category-move-form').onsubmit=async e=>{e.preventDefault();if(categoryBusy||confirmationPending)return;const name=categoryMoveDialog.dataset.category,target=e.target.elements.target.value;if(!target)return;lastActionButton=e.target.querySelector('.primary');if(!await askConfirm('将「'+name+'」的全部任务迁移到「'+target+'」并删除原分类？'))return;await changeCategory({action:'delete',name,target});if(!state.categories.some(c=>c.name===name))categoryMoveDialog.close();else categoryMoveDialog.querySelector('[data-error]').textContent=$('#category-error').textContent};
// Navigating to a day makes that date the default for new tasks.
$('#add-button').onclick=()=>openTask(nextView==='today'?nextWeek:today());
window.addEventListener('beforeunload',e=>{if(viewerAdminLoaded&&$('#accounts-dialog').open&&viewerDraftSnapshot()!==viewerDraftBaseline){e.preventDefault();e.returnValue=''}});
// Saving one category must not discard edits in another row or the creation tab.
const changeCategoryBeforeDrafts=changeCategory;
changeCategory=async function(data){
  if(categoryBusy)return;
  const drafts=[...$('#category-rows').querySelectorAll('form')].filter(row=>row.dataset.sourceName!==(data.old||data.name)&&JSON.stringify(Object.fromEntries(new FormData(row)))!==row.dataset.persisted).map(row=>({name:row.dataset.sourceName,values:Object.fromEntries(new FormData(row))}));
  const controls=[...document.querySelectorAll('#category-dialog input,#category-dialog select,#category-dialog button,#category-move-dialog input,#category-move-dialog select,#category-move-dialog button')].map(el=>({el,disabled:el.disabled}));
  controls.forEach(({el})=>el.disabled=true);
  try{
    await changeCategoryBeforeDrafts(data);
    if($('#category-error').textContent)return;
    for(const draft of drafts){const row=[...$('#category-rows').querySelectorAll('form')].find(row=>row.dataset.sourceName===draft.name);if(row)for(const [key,value] of Object.entries(draft.values))if(row.elements[key])row.elements[key].value=value}
    if(data.action==='create')$('#category-form').reset();
  }finally{controls.forEach(({el,disabled})=>el.disabled=disabled)}
};

// Personal notes belong to an original occurrence, independently of time changes.
const courseDetailsBeforeAnnotations=showCourseDetails;
showCourseDetails=function(key,date){
  courseDetailsBeforeAnnotations(key,date);
  if(state.readonly)return;
  const dialog=$('#course-details'),course=state.course_dates?.find(c=>c.course_key===key&&c.original_date===date);
  if(!dialog||!course)return;
  const form=document.createElement('form');form.className='course-annotation-form';
  form.innerHTML=`<nav class="detail-tabs" role="tablist" aria-label="课程详情">${[['info','详细信息'],['notes','修改备注'],['homework','作业设置'],['schedule','课程调整']].map(([id,label])=>`<button type="button" role="tab" id="course-tab-${id}" aria-controls="course-panel-${id}" data-course-detail-tab="${id}">${label}</button>`).join('')}</nav><div class="course-tab-body"><section role="tabpanel" id="course-panel-info" aria-labelledby="course-tab-info" data-course-panel="info"></section><section role="tabpanel" id="course-panel-notes" aria-labelledby="course-tab-notes" data-course-panel="notes" hidden><label>课程备注（选填）<textarea name="notes" rows="6" maxlength="4000" placeholder="本次课要带的材料、课堂提醒等">${esc(course.notes||'')}</textarea></label></section><section role="tabpanel" id="course-panel-homework" aria-labelledby="course-tab-homework" data-course-panel="homework" hidden><label class="check"><input name="homework_required" type="checkbox" ${course.homework_required?'checked':''}>本次课需交作业</label><label class="check" data-homework-done><input name="homework_done" type="checkbox" ${course.homework_done?'checked':''}>作业已完成</label><label data-homework-notes>作业说明（选填）<textarea name="homework_notes" rows="6" maxlength="4000" placeholder="填写题号、提交方式或其他要求">${esc(course.homework_notes||'')}</textarea></label></section><section role="tabpanel" id="course-panel-schedule" aria-labelledby="course-tab-schedule" data-course-panel="schedule" hidden></section></div><div class="course-annotation-footer"><p data-error role="alert"></p><button class="primary" type="submit">保存备注与作业</button></div>`;
  form.querySelector('[data-course-panel="info"]').append(dialog.querySelector('.task-parameters'));
  const overview=document.createElement('div');overview.className='course-overview';form.querySelector('[data-course-panel="info"]').append(overview);
  const renderOverview=data=>{overview.innerHTML=`<section><h3>课程备注</h3><p class="course-overview-text">${esc(data.notes||'未填写备注')}</p></section><section><h3>交作业</h3><p class="course-overview-status">${data.homework_required?'本次课需交作业 · '+(data.homework_done?'已完成':'未完成'):'本次课未设置交作业要求'}</p>${data.homework_required||data.homework_notes?`<h4>${data.homework_required?'作业说明':'作业说明草稿（未启用）'}</h4><p class="course-overview-text">${esc(data.homework_notes||'未填写作业说明')}</p>`:''}</section>`};renderOverview(course);

  const scheduleActions=dialog.querySelector('.task-detail-actions');scheduleActions.before(form);form.querySelector('[data-course-panel="schedule"]').append(scheduleActions);
  const tabs=[...form.querySelectorAll('[data-course-detail-tab]')];
  const selectTab=id=>{form.querySelector('[type=submit]').style.visibility=['notes','homework'].includes(id)?'visible':'hidden';for(const tab of tabs){const active=tab.dataset.courseDetailTab===id;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1}for(const panel of form.querySelectorAll('[data-course-panel]'))panel.hidden=panel.dataset.coursePanel!==id;form.querySelector('.course-tab-body').scrollTop=0};
  for(const [index,tab] of tabs.entries()){tab.onclick=()=>selectTab(tab.dataset.courseDetailTab);tab.onkeydown=e=>{let next;if(e.key==='ArrowRight')next=(index+1)%tabs.length;else if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();tabs[next].click();tabs[next].focus()}}selectTab('info');
  const toggle=()=>{form.querySelector('[data-homework-done]').hidden=!form.elements.homework_required.checked;form.querySelector('[data-homework-notes]').hidden=!form.elements.homework_required.checked;};
  form.elements.homework_required.onchange=toggle;toggle();
  const snapshot=()=>JSON.stringify({notes:form.elements.notes.value,homework_required:form.elements.homework_required.checked,homework_done:form.elements.homework_required.checked&&form.elements.homework_done.checked,homework_notes:form.elements.homework_notes.value});let original=snapshot();
  const canLeave=async()=>!courseSaving&&!confirmationPending&&(snapshot()===original||await askConfirm('放弃未保存的课程备注和作业设置？'));
  dialog.querySelector('[data-close]').onclick=async()=>{if(await canLeave())dialog.close()};
  dialog.oncancel=e=>{e.preventDefault();dialog.querySelector('[data-close]').click()};
  for(const button of dialog.querySelectorAll('.task-detail-actions button')){const action=button.onclick;button.onclick=async e=>{if(await canLeave())return action?.call(button,e)}}
  form.onsubmit=async e=>{
    e.preventDefault();if(courseSaving||confirmationPending)return;
    const data=JSON.parse(snapshot()),button=form.querySelector('[type=submit]'),error=form.querySelector('[data-error]');
    courseSaving=true;button.disabled=true;error.textContent='';
    try{await api('course-annotations','PUT',{...courseIdentity(course,key,date),...data});original=JSON.stringify(data);renderOverview(data);selectTab('info');await refresh();toast('已保存课程备注与作业设置')}catch(err){error.textContent=err.message}finally{courseSaving=false;button.disabled=false}
  };
};

// Copy into the normal creation form; saving creates a separate task.
function copyTask(id){
  if(state.readonly||busy||confirmationPending)return;
  const source=state.tasks.find(task=>task.id===id);if(!source)return;
  openTask(source.date);
  for(const name of ['title','short_title','date','end_date','category','due','notes','start_time','end_time'])taskForm.elements[name].value=source[name]||'';
  taskForm.elements.schedule_mode.value=source.start_time?'minute':'date';scheduleModeUI();
  taskForm.elements.done.checked=false;
  setMilestoneRows((source.milestones||[]).map(node=>({...node,done:false})));
  taskSnapshot=JSON.stringify(Object.fromEntries(new FormData(taskForm)));
  $('#task-heading').textContent='复制任务';selectTaskTab('content');taskForm.elements.title.focus();
}
const taskDetailsBeforeCopy=showTaskDetails;showTaskDetails=function(id){
  taskDetailsBeforeCopy(id);if(state.readonly)return;
  const actions=$('#task-details .task-detail-actions');if(!actions)return;
  const button=document.createElement('button');button.type='button';button.textContent='复制任务';button.dataset.copyTask=id;button.onclick=()=>copyTask(id);
  actions.querySelector('[data-edit]').after(button);
};

// Node details stay readable; add and edit use a dedicated child dialog.
function openNodeEditor(task,index=null){
  if(state.readonly||busy||confirmationPending)return;
  if(index===null&&(task.milestones||[]).length>=50){toast('每个任务最多添加 50 个节点');return}
  let dialog=$('#node-editor-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='node-editor-dialog';document.body.append(dialog)}
  const node=index===null?{}:task.milestones[index];
  dialog.innerHTML=`<form><div class="dialog-head"><h2>${index===null?'添加节点':'编辑节点'}</h2><button type="button" data-close aria-label="返回节点列表">×</button></div><div class="node-editor-body"><p>${esc(task.title)}</p><label>节点名称<input name="label" maxlength="80" value="${esc(node.label||'')}" placeholder="如：初稿完成"></label><label>节点时间（北京时间）<input name="stop_at" type="datetime-local" required value="${esc((node.stop_at||'').slice(0,16))}"></label><label class="check"><input name="done" type="checkbox" ${node.done?'checked':''}>已完成</label><p data-error role="alert"></p></div><div class="node-editor-actions"><button type="button" class="soft-danger" data-delete ${index===null?'disabled':''}>删除节点</button><button type="submit" class="primary">保存节点</button></div></form>`;
  const form=dialog.querySelector('form'),read=()=>({label:form.elements.label.value,stop_at:form.elements.stop_at.value,done:form.elements.done.checked});let original=JSON.stringify(read());
  const close=async()=>{if(busy||confirmationPending)return;if(JSON.stringify(read())!==original&&!await askConfirm('放弃未保存的节点修改？'))return;dialog.close()};
  dialog.querySelector('[data-close]').onclick=close;dialog.oncancel=e=>{e.preventDefault();close()};
  async function save(removing=false){
    if(busy||confirmationPending)return;const error=form.querySelector('[data-error]');error.textContent='';
    lastActionButton=form.querySelector(removing?'[data-delete]':'[type=submit]');
    if(!await askConfirm(removing?'删除这个节点？':'保存这个节点？'))return;
    const milestones=(task.milestones||[]).map(m=>({...m}));
    if(removing)milestones.splice(index,1);else if(index===null)milestones.push(read());else milestones[index]=read();
    try{if(await mutation(()=>api('tasks/'+task.id,'PUT',{...task,milestones}))){original=JSON.stringify(read());dialog.close();toast(removing?'节点已删除':'节点已保存')}}catch(err){error.textContent=err.message}
  }
  form.onsubmit=e=>{e.preventDefault();save()};form.querySelector('[data-delete]').onclick=()=>save(true);
  dialog.showModal();form.elements.label.focus();
}
const taskDetailsBeforeNodeEditor=showTaskDetails;showTaskDetails=function(id){
  taskDetailsBeforeNodeEditor(id);if(state.readonly)return;
  const task=state.tasks.find(t=>t.id===id),dialog=$('#task-details');if(!task||!dialog)return;
  const label=[...dialog.querySelectorAll('dt')].find(el=>el.textContent==='关键节点'),field=label?.nextElementSibling;if(!field)return;
  label.classList.add('node-field-label');field.classList.add('task-node-field');
  field.innerHTML=`<div class="detail-node-list">${(task.milestones||[]).map((node,index)=>`<div class="detail-node-item"><div><strong>${esc(node.label||'关键节点')}</strong><small>${esc(milestoneTime(node))} · ${node.done?'已完成':'未完成'}</small></div><div class="detail-node-actions"><button type="button" data-toggle-node="${index}">${node.done?'标为未完成':'标为完成'}</button><button type="button" data-edit-node="${index}">编辑</button></div></div>`).join('')||'<p class="hint-empty">暂未设置节点。</p>'}</div><button type="button" data-add-node>＋ 添加节点</button>`;
  field.querySelector('[data-add-node]').onclick=()=>openNodeEditor(task);
  field.querySelectorAll('[data-edit-node]').forEach(button=>button.onclick=()=>openNodeEditor(task,Number(button.dataset.editNode)));
  field.querySelectorAll('[data-toggle-node]').forEach(button=>button.onclick=async()=>{
    if(busy||confirmationPending)return;
    const index=Number(button.dataset.toggleNode),node=task.milestones[index],error=dialog.querySelector('[data-error]');lastActionButton=button;
    if(!await askConfirm('将「'+(node.label||'关键节点')+'」标为'+(node.done?'未完成':'完成')+'？'))return;
    const milestones=task.milestones.map((m,i)=>i===index?{...m,done:!m.done}:m);button.disabled=true;error.textContent='';
    try{if(await mutation(()=>api('tasks/'+id,'PUT',{...task,milestones}))){showTaskDetails(id);dialog.querySelector('[data-detail-tab="nodes"]').click()}}catch(err){error.textContent=err.message}finally{button.disabled=false}
  });

};

$('#calendar').addEventListener('click',event=>{const button=event.target.closest('[data-open-node]');if(!button)return;event.stopImmediatePropagation();openTask(null,button.dataset.task);$('#task-details[open] [data-detail-tab="nodes"]')?.click()},true);
// Keep native date fields to four-digit years, including dynamically added fields.
function limitDateYear(input){
  if(!(input instanceof HTMLInputElement)||!['date','datetime-local'].includes(input.type))return;
  const maximum=input.type==='date'?'9999-12-31':'9999-12-31T23:59';
  if(!input.max||input.max>maximum)input.max=maximum;
}
document.querySelectorAll('input').forEach(limitDateYear);
document.addEventListener('focusin',event=>limitDateYear(event.target));
new MutationObserver(records=>{for(const record of records){if(record.type==='attributes')limitDateYear(record.target);for(const node of record.addedNodes){if(node.nodeType!==1)continue;limitDateYear(node);node.querySelectorAll('input').forEach(limitDateYear)}}}).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['type']});

// The designer can return directly to the owner's cancellation and makeup list.
let courseAdjustmentsPending=new URLSearchParams(location.search).get('courses')==='adjustments';
const renderBeforeCourseLink=render;
render=function(...args){
  renderBeforeCourseLink(...args);
  if(!courseAdjustmentsPending||!state||state.readonly)return;
  courseAdjustmentsPending=false;
  queueMicrotask(()=>Promise.resolve($('#timetable-button').onclick()).then(()=>{
    if($('#timetable-dialog').open){courseTab='changes';nextCoursePreview()}
  }).catch(error=>toast(error.message)));
};
if(state&&courseAdjustmentsPending)render();
