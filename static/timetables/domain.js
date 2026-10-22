/* Shared, DOM-free timetable rules. Stable slot IDs survive course regrouping. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TimetableDesigner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  function minutes(value) {
    if (!/^\d{2}:\d{2}$/.test(String(value))) return NaN;
    const [hour, minute] = value.split(':').map(Number);
    return hour < 24 && minute < 60 ? hour * 60 + minute : NaN;
  }
  function timeRange(slot) {
    const match = String(slot.time || '').match(/^(\d{2}:\d{2})\s*[-–—~～至]\s*(\d{2}:\d{2})$/);
    return match ? [match[1], match[2]] : ['', ''];
  }
  function activeInWeek(slot, week) {
    if (slot.archived) return false;
    if (week < Number(slot.start || 1) || week > Number(slot.end || 18)) return false;
    const rule = String(slot.weeks || 'all');
    return !((['odd', '单', '单周'].includes(rule) && week % 2 === 0) ||
      (['even', '双', '双周'].includes(rule) && week % 2 === 1));
  }
  function weekLabel(slot) {
    const rule = String(slot.weeks || 'all');
    const suffix = ['odd', '单', '单周'].includes(rule) ? ' · 单周' : ['even', '双', '双周'].includes(rule) ? ' · 双周' : '';
    return `${slot.start || 1}–${slot.end || 18} 周${suffix}`;
  }
  function slotsForWeek(courses, week) {
    return (courses || []).filter(course => !course.archived).flatMap(course =>
      (course.slots || []).filter(slot => activeInWeek(slot, week)).map(slot => ({ course, slot }))
    ).sort((a, b) => Number(a.slot.day) - Number(b.slot.day) || timeRange(a.slot)[0].localeCompare(timeRange(b.slot)[0]) || a.course.name.localeCompare(b.course.name));
  }
  function layoutDay(items) {
    const result = (items || []).map(({ course, slot }) => {
      const [startMinute, endMinute] = timeRange(slot).map(minutes);
      return { course, slot, startMinute, endMinute };
    }).filter(item => Number.isFinite(item.startMinute) && Number.isFinite(item.endMinute) && item.startMinute < item.endMinute)
      .sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || String(a.slot.slot_id || '').localeCompare(String(b.slot.slot_id || '')));
    let group = [], columnEnds = [], groupEnd = -Infinity;
    const finishGroup = () => {
      for (const item of group) item.columnCount = columnEnds.length;
    };
    for (const item of result) {
      if (item.startMinute >= groupEnd) {
        finishGroup(); group = []; columnEnds = []; groupEnd = -Infinity;
      }
      const available = columnEnds.findIndex(end => end <= item.startMinute);
      item.column = available < 0 ? columnEnds.length : available;
      columnEnds[item.column] = item.endMinute;
      groupEnd = Math.max(groupEnd, item.endMinute);
      group.push(item);
    }
    finishGroup();
    return result;
  }
  function conflicts(courses, week) {
    const items = slotsForWeek(courses, week), result = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (Number(a.slot.day) !== Number(b.slot.day)) continue;
        const [as, ae] = timeRange(a.slot).map(minutes), [bs, be] = timeRange(b.slot).map(minutes);
        if (as < be && bs < ae) result.push({ first: a, second: b, week });
      }
    }
    return result;
  }
  function allConflicts(courses) {
    const pairs = new Map();
    for (let week = 1; week <= 18; week++) {
      for (const item of conflicts(courses, week)) {
        const key = [item.first.slot.slot_id, item.second.slot.slot_id].sort().join('|');
        if (pairs.has(key)) pairs.get(key).weeks.push(week);
        else pairs.set(key, { ...item, weeks: [week] });
      }
    }
    return [...pairs.values()];
  }
  function validatePeriods(periods) {
    const ids = new Set();
    for (const period of periods || []) {
      if (!period.id || ids.has(String(period.id))) throw Error('节次编号不能为空或重复');
      ids.add(String(period.id));
      if (!(minutes(period.start) < minutes(period.end))) throw Error(`${period.label || period.id}：结束时刻必须晚于开始时刻`);
    }
    for (let i = 1; i < (periods || []).length; i++) {
      if (minutes(periods[i].start) < minutes(periods[i - 1].end)) throw Error('节次必须按时间先后排列，且不能重叠');
    }
    return periods;
  }
  function resolvePeriods(slot, periods) {
    const first = periods.findIndex(period => String(period.id) === String(slot.period_start));
    const last = periods.findIndex(period => String(period.id) === String(slot.period_end));
    if (first < 0 || last < first) throw Error('请选择有效的连续起止节次');
    return `${periods[first].start}-${periods[last].end}`;
  }
  function periodsForSlot(plan, slot) {
    if (!slot.calendar_id) return plan.periods || [];
    const calendars = Array.isArray(plan.calendars) ? plan.calendars : Object.values(plan.calendars || {});
    return calendars.find(calendar => String(calendar.calendar_id) === String(slot.calendar_id))?.periods || [];
  }
  function updatePeriods(plan, periods, calendarId = '') {
    validatePeriods(periods);
    const result = clone(plan), affected = [];
    for (const course of result.courses || []) {
      for (const slot of course.slots || []) {
        if (slot.time_mode !== 'period' || String(slot.calendar_id || '') !== String(calendarId)) continue;
        const oldPeriods = periodsForSlot(plan, slot);
        const oldFirst = oldPeriods.findIndex(period => String(period.id) === String(slot.period_start));
        const oldLast = oldPeriods.findIndex(period => String(period.id) === String(slot.period_end));
        if (oldFirst >= 0 && oldLast >= oldFirst && oldPeriods.slice(oldFirst, oldLast + 1).some(period => !periods.some(next => String(next.id) === String(period.id)))) {
          throw Error(`“${course.name}”仍引用此节次，请先修改课程时段后再删除节次`);
        }
        let time;
        try { time = resolvePeriods(slot, periods); }
        catch (_) { throw Error(`“${course.name}”仍引用此节次，请先修改课程时段后再删除节次`); }
        if (time !== slot.time) affected.push({ course: course.name, slot_id: slot.slot_id, before: slot.time, after: time });
        slot.time = time;
      }
    }
    if (calendarId) {
      const calendars = Array.isArray(result.calendars) ? result.calendars : Object.values(result.calendars || {});
      const calendar = calendars.find(item => String(item.calendar_id) === String(calendarId));
      if (!calendar) throw Error('未找到此来源课表的作息');
      calendar.periods = clone(periods);
    } else result.periods = clone(periods);
    return { plan: result, affected };
  }
  function validateSlot(slot, periods) {
    if (!(Number.isInteger(Number(slot.day)) && Number(slot.day) >= 1 && Number(slot.day) <= 7)) throw Error('请选择星期一至星期日');
    if (!(Number.isInteger(Number(slot.start)) && Number.isInteger(Number(slot.end)) && slot.start >= 1 && slot.end <= 18 && Number(slot.start) <= Number(slot.end))) throw Error('起止周须在 1–18 周以内，且结束周不能早于开始周');
    const normalized = { ...slot, day: Number(slot.day), start: Number(slot.start), end: Number(slot.end) };
    if (normalized.time_mode === 'period') normalized.time = resolvePeriods(normalized, periods || []);
    const [start, end] = timeRange(normalized).map(minutes);
    if (!(start < end)) throw Error('结束时刻必须晚于开始时刻，不支持跨午夜上课');
    return normalized;
  }
  function candidates(courses) {
    const groups = new Map();
    for (const course of courses || []) {
      if (course.archived) continue;
      const key = course.name.trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(course.course_id);
    }
    return [...groups.entries()].filter(([, ids]) => ids.length > 1).map(([name, course_ids]) => ({ name, course_ids }));
  }
  function mergeCourses(plan, ids, targetId) {
    const result = clone(plan), selected = new Set(ids);
    if (selected.size < 2) throw Error('至少选择两门课程');
    const target = result.courses.find(course => course.course_id === targetId);
    if (!target || !selected.has(targetId)) throw Error('保留的课程必须在选择范围内');
    const aliases = { ...(result.course_aliases || {}) };
    const seen = new Set(target.slots.map(slot => slot.slot_id));
    for (const course of result.courses) {
      if (course.course_id === targetId || !selected.has(course.course_id)) continue;
      for (const slot of course.slots || []) {
        if (!seen.has(slot.slot_id)) { target.slots.push(slot); seen.add(slot.slot_id); }
      }
      aliases[course.course_id] = targetId;
    }
    for (const id of Object.keys(aliases)) {
      if (selected.has(aliases[id])) aliases[id] = targetId;
    }
    result.courses = result.courses.filter(course => !selected.has(course.course_id) || course.course_id === targetId);
    result.course_aliases = aliases;
    return result;
  }
  function splitSlot(plan, courseId, slotId, newId, name) {
    if (!name.trim()) throw Error('课程名称不能为空');
    const result = clone(plan), course = result.courses.find(item => item.course_id === courseId);
    const slot = course && course.slots.find(item => item.slot_id === slotId);
    if (!slot) throw Error('未找到该时段');
    if (course.slots.length < 2) throw Error('只有一个时段时，可直接修改课程名称');
    course.slots = course.slots.filter(item => item.slot_id !== slotId);
    result.courses.push({ course_id: newId, name: name.trim(), slots: [slot] });
    return result;
  }
  function dateAtWeek(start, week, day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '')) return '';
    const date = new Date(`${start}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + (week - 1) * 7 + day - 1);
    return date.toISOString().slice(0, 10);
  }
  function holidayAt(holidays, date) {
    return date ? (holidays || []).filter(item => item.start <= date && item.end >= date) : [];
  }
  return { clone, minutes, timeRange, activeInWeek, weekLabel, slotsForWeek, layoutDay, conflicts, allConflicts, validateSlot, validatePeriods, resolvePeriods, periodsForSlot, updatePeriods, candidates, mergeCourses, splitSlot, dateAtWeek, holidayAt };
});
