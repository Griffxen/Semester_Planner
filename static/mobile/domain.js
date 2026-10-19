/* DOM-free mobile projections. Dates and clocks always mean Beijing time. */
(function (root) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const add = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const monday = date => add(date, -((new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const formatDate = date => date ? date.slice(5).replace('-', '/') : '';
  function taskWhen(task, full = false) {
    const a = full ? task.date : formatDate(task.date), b = full ? task.end_date : formatDate(task.end_date);
    if (task.start_time) return task.date === task.end_date ? `${a} ${task.start_time}–${task.end_time}` : `${a} ${task.start_time} — ${b} ${task.end_time}`;
    return task.date === task.end_date ? a : `${a} — ${b}`;
  }
  function allowedDate(data, date) { return !data.readonly || !!(data.share?.enabled && date >= data.share.start && date <= data.share.end); }
  function filteredTasks(data, filters) {
    const query = (filters.query || '').trim().toLocaleLowerCase();
    return data.tasks.filter(task => (!filters.category || task.category === filters.category) && (!filters.hideDone || !task.done) && (!query || [task.title, task.short_title, task.notes, ...(task.milestones || []).map(n => n.label)].join(' ').toLocaleLowerCase().includes(query)));
  }
  function dayEntries(data, date, filters) {
    if (!allowedDate(data, date)) return {timed:[], dated:[], ongoing:[], courses:[], nodes:[]};
    const tasks = filteredTasks(data, filters), daily = tasks.filter(t => t.date === date && t.end_date === date);
    const ongoing = tasks.filter(t => t.date <= date && t.end_date >= date && t.date !== t.end_date);
    const courses = filters.showCourses ? (data.course_dates || []).filter(c => c.date === date && !c.cancelled) : [];
    // A node may occur outside its parent task's planned interval.
    const nodes = tasks.flatMap(t => (t.milestones || []).map((node,index) => ({task:t,node,index})).filter(x => x.node.stop_at.slice(0,10) === date && (!filters.hideDone || !x.node.done)));
    const deadlines=tasks.filter(t=>!t.done&&t.due?.slice(0,10)===date).map(task=>({kind:'deadline',time:task.due.slice(11,16),task}));
    const timed = [...daily.filter(t => t.start_time).map(task => ({kind:'task',time:task.start_time,task})), ...courses.map(course => ({kind:'course',time:course.time.slice(0,5),course})), ...nodes.map(x => ({...x,kind:'node',time:x.node.stop_at.slice(11,16)})),...deadlines].sort((a,b) => a.time.localeCompare(b.time));
    return {timed, dated:daily.filter(t => !t.start_time), ongoing, courses, nodes};
  }
  function workloadCounts(data,date,filters) {
    const entries=dayEntries(data,date,filters);
    if(!allowedDate(data,date))return {slots:0,dated:0,points:0,untimed:0};
    const tasks=filteredTasks(data,filters);
    const projected=(data.date_counts||[]).find(item=>item.date===date)?.count||0;
    const ends=tasks.filter(task=>task.date<task.end_date&&task.end_date===date).length;
    const dated=entries.dated.length+projected;
    // Nodes and planned ends add workload; an independent deadline is a reminder, not another item.
    const points=entries.nodes.length+ends;
    const slots=entries.courses.length+tasks.filter(task=>task.start_time&&task.date<=date&&task.end_date>=date&&(task.end_date!==date||task.end_time!=='00:00')).length;
    return {slots,dated,points,untimed:dated+points};
  }

  function busyIntervals(data, date, filters) {
    const intervals = [];
    const push = (start,end) => {const mins = x => Number(x.slice(0,2))*60+Number(x.slice(3,5));const a=mins(start),b=mins(end);if(Number.isFinite(a)&&b>a)intervals.push([a,b]);};
    for (const task of filteredTasks(data,filters)) if (task.start_time && task.date<=date && task.end_date>=date) push(task.date===date?task.start_time:'00:00',task.end_date===date?task.end_time:'23:59');
    if(filters.showCourses) for(const c of data.course_dates||[]) if(c.date===date&&!c.cancelled){const times=c.time.match(/\d{2}:\d{2}/g)||[];if(times.length===2)push(...times);}
    const merged=[];
    for(const interval of intervals.sort((a,b)=>a[0]-b[0])) {const prev=merged.at(-1);if(prev&&interval[0]<=prev[1])prev[1]=Math.max(prev[1],interval[1]);else merged.push([...interval]);}
    return merged;
  }
  const DENSITY_KEY='semester-density-threshold';
  let densityFallback=.5;
  function densityThreshold() {
    try {const value=Number(root.localStorage.getItem(DENSITY_KEY));if(value>=.1&&value<=2)return value;}catch(error){}
    return densityFallback;
  }
  function setDensityThreshold(value) {
    value=Number(value);
    if(!Number.isFinite(value)||value<.1||value>2)throw new Error('密度阈值应在 0.1–2 项/小时之间');
    densityFallback=value;
    try {root.localStorage.setItem(DENSITY_KEY,String(value));return true;}catch(error){return false;}
  }
  function scheduleDensity(intervals, count, start=480, end=1440, threshold=densityThreshold()) {
    const busy=[];
    for(const [a,b] of intervals.map(([a,b])=>[Math.max(start,a),Math.min(end,b)]).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0])) {
      const previous=busy.at(-1);
      if(previous&&a<=previous[1])previous[1]=Math.max(previous[1],b);
      else busy.push([a,b]);
    }
    const free=[];let cursor=start;
    for(const [a,b] of busy){if(a>cursor)free.push([cursor,a]);cursor=b;}
    if(cursor<end)free.push([cursor,end]);
    const freeMinutes=free.reduce((sum,[a,b])=>sum+b-a,0);
    const density=freeMinutes?count*60/freeMinutes:count?null:0;
    // One shared sensitivity threshold, without estimating task duration.
    const strength=count?Math.min(1,density===null?1:density/(Number.isFinite(threshold)&&threshold>0?threshold:.5)):0;
    return {busy,free,freeMinutes,density,strength};
  }
  const domain={esc,today,add,monday,formatDate,taskWhen,allowedDate,filteredTasks,dayEntries,workloadCounts,busyIntervals,densityThreshold,setDensityThreshold,scheduleDensity};
  root.MobileDomain=domain;
  if(typeof module!=='undefined')module.exports=domain;
})(typeof window==='undefined'?globalThis:window);
