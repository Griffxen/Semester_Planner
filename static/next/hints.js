/* Pure Beijing-time projections, independent of DOM and filters. */
function taskTimeHints(tasks, now) {
  const high = now + 12 * 3600000;
  return tasks.filter(task => !task.done).map(task => {
    const points = [];
    const addPoint = (kind, label, at, done, dateOnly = false) => {
      const ms = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(at) ? at : at + '+08:00');
      // Past starts are history, not unfinished work. End/due/milestone points remain until complete.
      if (!done && Number.isFinite(ms) && ms <= high && (kind !== 'start' || ms >= now)) points.push({kind, label, at, ms, done: false, dateOnly});
    };
    addPoint('start', '开始', task.date + 'T' + (task.start_time || '00:00'), false, !task.start_time);
    addPoint('end', '结束', task.end_date + 'T' + (task.end_time || '23:59'), false, !task.end_time);
    if (task.due) addPoint('due', '截止', task.due, false);
    for (const m of task.milestones || []) addPoint('milestone', m.label || '节点', m.stop_at, m.done);
    points.sort((a, b) => a.ms - b.ms);
    return {task, points, nearest: points.length ? Math.min(...points.map(p => Math.abs(p.ms - now))) : Infinity};
  }).filter(x => x.points.length).sort((a, b) => a.nearest - b.nearest || String(a.task.id).localeCompare(String(b.task.id)));
}

// Group actual unfinished past points without treating clipped sharing ends as due.
function overdueTaskGroups(tasks, now) {
  return taskTimeHints(tasks, now).map(({task, points}) => ({
    task,
    points: points.filter(point => point.ms < now && point.kind !== 'start' && !(point.kind === 'end' && task.continues_after))
  })).filter(group => group.points.length)
    .sort((a, b) => a.points[0].ms - b.points[0].ms || String(a.task.id).localeCompare(String(b.task.id)));
}
function courseTimeHints(courses,now){const rows=courses.filter(c=>!c.cancelled).map(course=>{const times=course.time.match(/\d{2}:\d{2}/g)||[];return {course,start:Date.parse(course.date+'T'+times[0]+'+08:00'),end:Date.parse(course.date+'T'+times[1]+'+08:00')}}).filter(x=>Number.isFinite(x.start)&&Number.isFinite(x.end));return {current:rows.filter(x=>x.start<=now&&now<x.end).sort((a,b)=>a.end-b.end),next:rows.filter(x=>x.start>now).sort((a,b)=>a.start-b.start)[0]||null}}

// Calendar entries belong to node dates, independent of the parent task range.
function calendarMilestones(tasks,date,hideDone=false){
  return tasks.flatMap(task=>(task.milestones||[]).filter(node=>node.stop_at.slice(0,10)===date&&(!hideDone||!node.done)).map(node=>({task,node})))
    .sort((a,b)=>a.node.stop_at.localeCompare(b.node.stop_at)||String(a.task.id).localeCompare(String(b.task.id)));
}

// Only actual range ends get a daily block; clipped sharing boundaries are not ends.
function calendarTaskEnds(tasks,date,hideDone=false){
  return tasks.filter(task=>(task.end_date>task.date||task.continues_before)&&task.end_date===date&&!task.continues_after&&(!hideDone||!task.done))
    .sort((a,b)=>(a.end_time||'99:99').localeCompare(b.end_time||'99:99')||String(a.id).localeCompare(String(b.id)));
}
