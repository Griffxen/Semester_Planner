/* Local display preference, shared by phone and desktop. */
window.WorkloadSettings=(()=>{
  const U=MobileDomain;
  function mount(host,onChange=()=>{}) {
    host.innerHTML='<div class="density-settings"><label>最深颜色对应的密度 <output data-density-value></output><input data-density-input type="range" min="0.1" max="2" step="0.1" aria-label="最深颜色对应的密度"></label><div class="density-samples" aria-label="密度与颜色示例"></div><p data-density-note role="status" hidden></p><button type="button" data-density-reset>恢复默认</button></div>';
    const input=host.querySelector('[data-density-input]');input.value=U.densityThreshold();
    function preview(){
      const value=Number(input.value);host.querySelector('[data-density-value]').textContent=value.toFixed(1)+' 项/小时';
      host.querySelector('.density-samples').innerHTML=[0,.25,.5,.75,1].map(r=>'<span><i class="timebar '+(r?'has-untimed':'')+'"></i><small>'+Number((value*r).toFixed(2))+'</small></span>').join('');
      host.querySelectorAll('.density-samples .timebar').forEach((bar,i)=>bar.style.setProperty('--density-strength',String(i/4)));
    }
    function apply(){const persisted=U.setDensityThreshold(input.value);preview();const note=host.querySelector('[data-density-note]');note.hidden=persisted;note.textContent=persisted?'':'设置未能保存';onChange();window.dispatchEvent(new CustomEvent('workload:density'));}
    input.oninput=apply;host.querySelector('[data-density-reset]').onclick=()=>{input.value=.5;apply();};preview();
  }
  function openMobile(){window.Mobile.openPage({title:'密度设置',onMount:page=>mount(page.querySelector('.m-page-body'))});}
  return {mount,openMobile};
})();
/* Read-only week distribution, sharing the mobile density projection. */
(() => {
  'use strict';
  const U=MobileDomain, {esc,add,monday,today,formatDate}=U;
  const tools=document.querySelector('.nav-tools');
  if(!tools)return;
  const trigger=document.createElement('button');
  trigger.id='time-distribution-button';trigger.type='button';trigger.dataset.icon='grid';trigger.textContent='时间分布';
  tools.append(trigger);decorateIcons(tools);
  if(typeof setToolbarHeight==='function')setToolbarHeight();
  const dialog=document.createElement('dialog');dialog.id='time-distribution-dialog';
  dialog.setAttribute('aria-labelledby','time-distribution-title');
  dialog.innerHTML='<header class="workload-head"><h2 id="time-distribution-title">本周时间分布</h2><button type="button" data-workload-close aria-label="关闭时间分布">×</button></header><div class="workload-controls"><button type="button" data-workload-shift="-7" aria-label="查看上一周时间分布">←</button><strong data-workload-period></strong><button type="button" data-workload-shift="7" aria-label="查看下一周时间分布">→</button><button type="button" data-workload-today>本周</button></div><div class="workload-legend"><span><i class="timeline-key"></i>定时时段</span><span><i class="timeline-key is-untimed"></i>未定时密度</span><button type="button" data-density-toggle>密度设置</button><span>08:00–24:00</span></div><div class="workload-density" hidden></div><div class="workload-body" aria-live="polite"></div>';
  document.body.append(dialog);
  const densityPanel=dialog.querySelector('.workload-density'),densityToggle=dialog.querySelector('[data-density-toggle]');
  densityToggle.setAttribute('aria-expanded','false');
  densityToggle.onclick=()=>{densityPanel.hidden=!densityPanel.hidden;densityToggle.setAttribute('aria-expanded',String(!densityPanel.hidden));if(!densityPanel.hidden)WorkloadSettings.mount(densityPanel,render);};
  let date=today(),data=null,filters=null,generation=0;
  const body=dialog.querySelector('.workload-body');
  const currentFilters=()=>({category:filter||'',query:document.querySelector('#search')?.value||'',hideDone:!!document.querySelector('#hide-done')?.checked,showCourses:!!document.querySelector('#show-courses')?.checked});
  function render(){
    const lo=monday(date);
    dialog.querySelector('[data-workload-period]').textContent=lo+' — '+add(lo,6);
    if(!data)return;
    body.innerHTML=Array.from({length:7},(_,i)=>{
      const day=add(lo,i),heading=`<div class="workload-date">周${'一二三四五六日'[i]}<strong>${formatDate(day)}</strong></div>`;
      if(!U.allowedDate(data,day))return `<section class="workload-day">${heading}<span class="workload-error">授权范围外</span></section>`;
      const entries=U.dayEntries(data,day,filters),intervals=U.busyIntervals(data,day,filters);
      const counts=U.workloadCounts(data,day,filters),untimed=counts.untimed;
      const load=U.scheduleDensity(intervals,untimed);

      const scheduled=load.busy.map(([a,b])=>`<i data-timeline-start="${a}" data-timeline-end="${b}"></i>`).join('');
      const hint=untimed?`${untimed} 项未定时安排，${load.density===null?'无空闲时段':`密度 ${load.density.toFixed(2)} 项/小时`}`:'没有未定时安排';
      return `<section class="workload-day ${day===today()?'is-today':''}">${heading}<div class="workload-day-main"><div class="workload-day-title"><span>${counts.slots} 个定时时段 · ${counts.dated} 项未定时 · ${counts.points} 个时间点</span></div><div class="timebar workload-bar ${untimed?'has-untimed':''}" data-strength="${load.strength}" role="img" aria-label="${esc('08:00 至 24:00；'+hint+'；暖棕色为工作量提示，不是已占用时段')}">${scheduled}<span class="timebar-dots" aria-hidden="true"><b class="at-8"></b><b class="at-12"></b><b class="at-18"></b><b class="at-24"></b></span></div><div class="workload-day-meta">${intervals.some(([a])=>a<480)?'<span>08:00 前另有定时安排</span>':''}</div></div></section>`;
    }).join('');
    body.querySelectorAll('.timebar[data-strength]').forEach(el=>el.style.setProperty('--density-strength',el.dataset.strength));
    body.querySelectorAll('[data-timeline-start]').forEach(el=>{el.style.left=(Number(el.dataset.timelineStart)-480)/960*100+'%';el.style.width=(Number(el.dataset.timelineEnd)-Number(el.dataset.timelineStart))/960*100+'%';if(el.hasAttribute('data-strength'))el.style.setProperty('--density-strength',el.dataset.strength);});
  }
  async function load(){
    const ticket=++generation;
    body.innerHTML='<p class="workload-error">正在读取安排…</p>';
    try{
      const result=await api(previewId?'share-preview/'+previewId:'state');
      if(!dialog.open||ticket!==generation)return;
      data=result;filters=currentFilters();
      if(filters.category&&!data.categories.some(category=>category.name===filters.category))filters.category='';
      render();
    }catch(error){if(dialog.open&&ticket===generation){data=null;body.innerHTML='<p class="workload-error" role="alert"></p>';body.querySelector('p').textContent=error.message;}}
  }
  trigger.onclick=()=>{date=typeof nextWeek==='string'?nextWeek:today();dialog.showModal();render();load();};
  dialog.querySelector('[data-workload-close]').onclick=()=>dialog.close();
  dialog.querySelectorAll('[data-workload-shift]').forEach(button=>{button.onclick=()=>{date=add(date,Number(button.dataset.workloadShift));render();};});
  dialog.querySelector('[data-workload-today]').onclick=()=>{date=today();render();};
  dialog.addEventListener('close',()=>{generation++;data=null;body.replaceChildren();trigger.focus({preventScroll:true});});
  window.addEventListener('storage',event=>{if(event.key==='semester-density-threshold'&&dialog.open)render();});
  setInterval(()=>{if(dialog.open&&data?.readonly)load();},60000);
})();
