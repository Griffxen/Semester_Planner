/* Shared projections: reference times never become a live schedule implicitly. */
(function (root) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const fields = ['title','short_title','category','date','end_date','start_time','end_time','due','notes','done','milestones','version','deferred','deferred_at','previous_schedule'];
  function payload(task) {
    return Object.fromEntries(fields.filter(key => task[key] !== undefined).map(key => [key, clone(task[key])]));
  }
  function backup(data) {
    return {format:1,exportedAt:new Date().toISOString(),settings:data.settings,tasks:[...data.tasks,...(data.deferred_tasks || [])],journal:data.journal,timetable:data.timetable,course_exceptions:data.course_exceptions,holidays:data.holidays};
  }
  function blank(task) {
    return {...payload(task), deferred:false, date:'',end_date:'',start_time:'',end_time:'',due:'',milestones:[]};
  }
  function filtered(data, filters = {}) {
    const query = (filters.query || '').trim().toLocaleLowerCase();
    return (data.deferred_tasks || []).filter(t => (!filters.category || t.category === filters.category) && (!query || [t.title,t.short_title,t.notes,...(t.previous_schedule?.milestones || []).map(n => n.label)].join(' ').toLocaleLowerCase().includes(query)))
      .slice().sort((a,b) => (b.deferred_at || '').localeCompare(a.deferred_at || '') || b.id.localeCompare(a.id));
  }
  function list(tasks) {
    return '<div class="deferred-list">' + (tasks.map(t => `<article class="deferred-row"><button type="button" data-deferred-task="${esc(t.id)}"><strong>${esc(t.title)}</strong><span>${esc(t.category)}</span>${t.notes?`<p>${esc(t.notes)}</p>`:''}</button><button type="button" data-resume-deferred="${esc(t.id)}">重新安排</button></article>`).join('') || '<p class="deferred-empty">暂无暂缓任务</p>') + '</div>';
  }
  function reference(task) {
    const p = task.previous_schedule || {};
    const when = p.date ? p.date + (p.start_time?' '+p.start_time:'') + ' — ' + p.end_date + (p.end_time?' '+p.end_time:'') : '';
    return `<section class="deferred-reference" aria-label="原安排参考"><h3>原安排（参考）</h3>${when?`<p>计划：${esc(when)}</p><p>截止：${esc(p.due?.replace('T',' ') || '未设置')}</p>${(p.milestones || []).map(n => `<p>${n.done?'✓':'○'} ${esc(n.label || '关键节点')} · ${esc(n.stop_at.slice(0,16).replace('T',' '))} · ${n.done?'已完成':'未完成'}</p>`).join('')}`:'<p>没有原安排</p>'}</section>`;
  }
  const api = {payload,blank,filtered,list,reference,clone,backup};
  root.DeferredTasks = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
