'use strict';
const assert = require('node:assert/strict');
const D = require('../static/timetables/domain.js');
const slot = (id, values = {}) => ({ slot_id: id, day: 1, time: '08:00-09:40', start: 1, end: 18, weeks: 'all', time_mode: 'clock', ...values });
const plan = { version: 4, courses: [{ course_id: 'a', name: '数理统计', slots: [slot('legacy-a')] }, { course_id: 'b', name: '数理统计', slots: [slot('legacy-b', { day: 4 })] }], periods: [], holidays: [] };

// A logical course with two fixed slots remains two occurrences, even on the same day.
const merged = D.mergeCourses(plan, ['a', 'b'], 'a');
assert.equal(merged.courses.length, 1);
assert.deepEqual(merged.courses[0].slots.map(item => item.slot_id), ['legacy-a', 'legacy-b']);
assert.deepEqual(merged.course_aliases, { b: 'a' });
assert.equal(plan.courses.length, 2, 'merge must not mutate the input draft');
const split = D.splitSlot(merged, 'a', 'legacy-b', 'new', '数理统计习题');
assert.equal(split.courses.length, 2);
assert.equal(split.courses[1].slots[0].slot_id, 'legacy-b', 'split preserves slot identity');
assert.deepEqual(D.candidates(plan.courses), [{ name: '数理统计', course_ids: ['a', 'b'] }]);
assert.deepEqual(D.candidates(merged.courses), []);

// Detect conflicts only when weekday, week interval, parity and time all overlap.
const parity = [{ course_id: 'a', name: '单周课', slots: [slot('odd', { weeks: 'odd', start: 3, end: 9 })] }, { course_id: 'b', name: '双周课', slots: [slot('even', { weeks: 'even' })] }];
assert.equal(D.conflicts(parity, 3).length, 0);
assert.equal(D.allConflicts(parity).length, 0);
assert.equal(D.activeInWeek(parity[0].slots[0], 1), false);
assert.equal(D.activeInWeek(parity[0].slots[0], 3), true);
assert.equal(D.activeInWeek(parity[0].slots[0], 10), false);
parity[1].slots[0].weeks = 'all';
assert.deepEqual(D.allConflicts(parity)[0].weeks, [3, 5, 7, 9]);
parity[1].slots[0].time = '09:40-10:30';
assert.equal(D.allConflicts(parity).length, 0, 'adjacent lessons do not overlap');
parity[1].slots[0].day = 2;
parity[1].slots[0].time = '08:00-09:40';
assert.equal(D.allConflicts(parity).length, 0);

// Resolving a period uses ordered stable IDs and updates only period-linked slots.
const periods = [{ id: 'first', label: '第一节', start: '08:00', end: '08:45' }, { id: 'second', label: '第二节', start: '08:55', end: '09:40' }];
const periodSlot = slot('period', { time_mode: 'period', period_start: 'first', period_end: 'second' });
assert.equal(D.resolvePeriods(periodSlot, periods), '08:00-09:40');
const periodPlan = { courses: [{ course_id: 'a', name: '微积分', slots: [periodSlot, slot('clock')] }], periods };
const changedPeriods = periods.map(item => ({ ...item })); changedPeriods[1].end = '09:45';
const changed = D.updatePeriods(periodPlan, changedPeriods);
assert.equal(changed.affected.length, 1);
assert.equal(changed.plan.courses[0].slots[0].time, '08:00-09:45');
assert.equal(changed.plan.courses[0].slots[1].time, '08:00-09:40');
assert.equal(periodPlan.courses[0].slots[0].time, '08:00-09:40');
assert.throws(() => D.updatePeriods(periodPlan, periods.slice(0, 1)), /引用此节次/);
assert.throws(() => D.resolvePeriods({ period_start: 'second', period_end: 'first' }, periods), /连续起止节次/);
assert.throws(() => D.validatePeriods([{ id: '1', start: '10:00', end: '09:00' }]), /结束时刻/);
assert.throws(() => D.validatePeriods([{ id: '1', start: '08:00', end: '09:00' }, { id: '1', start: '09:00', end: '10:00' }]), /重复/);
assert.throws(() => D.validateSlot(slot('bad', { time: '23:00-01:00' }), []), /跨午夜/);
assert.throws(() => D.validateSlot(slot('bad', { start: 4, end: 3 }), []), /起止周/);
assert.throws(() => D.validateSlot(slot('bad', { end: 19 }), []), /起止周/);
assert.equal(D.validateSlot(periodSlot, periods).time, '08:00-09:40');

// Editing one personal/source calendar must not change other imported period lessons.
const multipleCalendars = { periods, calendars: [{ calendar_id: 'source-a', periods }, { calendar_id: 'source-b', periods }], courses: [{ course_id: 'a', name: '多来源课程', slots: [periodSlot, { ...periodSlot, slot_id: 'source-a-slot', calendar_id: 'source-a' }, { ...periodSlot, slot_id: 'source-b-slot', calendar_id: 'source-b' }] }] };
const rootChange = D.updatePeriods(multipleCalendars, changedPeriods);
assert.deepEqual(rootChange.plan.courses[0].slots.map(item => item.time), ['08:00-09:45', '08:00-09:40', '08:00-09:40']);
const sourceChange = D.updatePeriods(multipleCalendars, changedPeriods, 'source-a');
assert.deepEqual(sourceChange.plan.courses[0].slots.map(item => item.time), ['08:00-09:40', '08:00-09:45', '08:00-09:40']);
assert.deepEqual(sourceChange.plan.periods, periods);
assert.deepEqual(D.periodsForSlot(sourceChange.plan, { calendar_id: 'source-a' }), changedPeriods);
const threePeriods = [periods[0], { id: 'middle', start: '08:45', end: '08:55' }, periods[1]];
assert.throws(() => D.updatePeriods({ ...periodPlan, periods: threePeriods }, periods), /引用此节次/);

assert.equal(D.dateAtWeek('2026-09-07', 2, 4), '2026-09-17');
assert.equal(D.holidayAt([{ name: '停课', start: '2026-09-17', end: '2026-09-18' }], '2026-09-17').length, 1);
assert.equal(D.holidayAt([{ name: '停课', start: '2026-09-17', end: '2026-09-18' }], '2026-09-19').length, 0);
console.log('Timetable designer rules passed: stable identities, week conflicts, period/calendar isolation and date boundaries.');
