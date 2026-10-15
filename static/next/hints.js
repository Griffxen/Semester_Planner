/* Pure Beijing-time projections, independent of DOM and filters. */
function taskTimeHints(tasks, now) {
  const high = now + 12 * 3600000;
  return tasks.filter(task => !task.done).map(task => {
    const points = [];
    const addPoint = (kind, label, at, done, dateOnly = false) => {
      const ms = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(at) ? at : at + '+08:00');
      // Unfinished past points have no lower time limit; completed points disappear.
      if (!done && Number.isFinite(ms) && ms <= high) points.push({kind, label, at, ms, done: false, dateOnly});
    };
    addPoint('start', '开始', task.date + 'T' + (task.start_time || '00:00'), false, !task.start_time);
    addPoint('end', '结束', task.end_date + 'T' + (task.end_time || '23:59'), false, !task.end_time);
    if (task.due) addPoint('due', '截止', task.due, false);
    for (const m of task.milestones || []) addPoint('milestone', m.label || '节点', m.stop_at, m.done);
    points.sort((a, b) => a.ms - b.ms);
    return {task, points, nearest: points.length ? Math.min(...points.map(p => Math.abs(p.ms - now))) : Infinity};
  }).filter(x => x.points.length).sort((a, b) => a.nearest - b.nearest || String(a.task.id).localeCompare(String(b.task.id)));
}
function courseTimeHints(courses,now){const rows=courses.filter(c=>!c.cancelled).map(course=>{const times=course.time.match(/\d{2}:\d{2}/g)||[];return {course,start:Date.parse(course.date+'T'+times[0]+'+08:00'),end:Date.parse(course.date+'T'+times[1]+'+08:00')}}).filter(x=>Number.isFinite(x.start)&&Number.isFinite(x.end));return {current:rows.filter(x=>x.start<=now&&now<x.end).sort((a,b)=>a.end-b.end),next:rows.filter(x=>x.start>now).sort((a,b)=>a.start-b.start)[0]||null}}
