/* Stable course identities and source-specific calendar rules in both clients. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const holiday = {name:'来源 A 停课',start:'2026-10-24',end:'2026-10-24'};
const group = {course_id:'logical-a',name:'数学',slots:[{slot_id:'slot-a',calendar_id:'source-a',day:1,time:'09:00–10:00'},{slot_id:'slot-b',calendar_id:'source-b',day:4,time:'11:00–12:00'}]};
const row = (key, time, kind='regular') => ({occurrence_id:key+':2026-10-22',course_id:'logical-a',slot_id:key,course_key:key,original_date:'2026-10-22',original_time:time,date:'2026-10-22',time,name:'数学',kind,cancelled:false});
const data = {course_plan:{courses:[group,{course_id:'same-name',name:'数学',slots:[]}],holidays:[],calendars:[{calendar_id:'source-a',holidays:[holiday]},{calendar_id:'source-b',holidays:[]}]},timetable:group.slots.map(slot=>({...slot,course_id:slot.slot_id,name:'数学'})),course_exceptions:[],holidays:[holiday],tasks:[],course_dates:[row('slot-a','09:00–10:00'),row('slot-b','11:00–12:00'),{...row('extra-a','15:00–16:00','extra'),source_holidays:[holiday]},{...row('stopped','12:00–13:00'),cancelled:true,holiday:true}]};
const source = fs.readFileSync(path.join(root,'static/app.js'),'utf8');
const context = {state:data,esc:escape,today:()=> '2026-10-22'};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('// A slot keeps'),source.indexOf("$('#personal-course-changes').onclick=")), context);
const mobile = {utils:{esc:escape,today:()=> '2026-10-22'},data};
const mobileContext = {window:{Mobile:mobile}};
vm.createContext(mobileContext);
vm.runInContext(fs.readFileSync(path.join(root,'static/mobile/courses.js'),'utf8').replace(/\}\)\(\);\s*$/, 'globalThis.courseHelpers={groups,identity,status,holidayNames,occurrence,conflictNames};})();'), mobileContext);
const json = value => JSON.parse(JSON.stringify(value));
const desktop = {groups:context.personalCourseGroups,identity:context.courseIdentity,status:context.courseStatus,holidayNames:context.courseHolidayWarnings,occurrence:context.courseOccurrence,conflictNames:context.courseConflictWarnings};
for (const [client, helpers] of [['desktop',desktop],['mobile',mobileContext.courseHelpers]]) {
  assert.equal(helpers.groups().length,2,client+': equal names must not merge course IDs');
  assert.equal(helpers.groups()[0].slots.length,2,client+': one course owns multiple slots');
  assert.equal(helpers.occurrence('slot-a','2026-10-22').occurrence_id,'slot-a:2026-10-22');
  assert.equal(helpers.occurrence('slot-b','2026-10-22').occurrence_id,'slot-b:2026-10-22',client+': same-day lessons remain distinct');
  assert.equal(helpers.occurrence('extra-a','2026-10-22').kind,'extra',client+': an extra lesson needs no fixed slot');
  assert.equal(helpers.identity(data.course_dates[2]).occurrence_id,'extra-a:2026-10-22',client+': annotations use stable extra lesson identity');
  assert.deepEqual(json(helpers.holidayNames('2026-10-24',data.course_dates[0])),['来源 A 停课']);
  assert.deepEqual(json(helpers.holidayNames('2026-10-24',data.course_dates[1])),[],client+': source A holidays must not stop source B lessons');
  assert.deepEqual(json(helpers.holidayNames('2026-10-24',data.course_dates[2])),['来源 A 停课'],client+': extra lessons retain their source calendar');
  assert.deepEqual(json(helpers.conflictNames('2026-10-22','12:00–13:00','nothing')),[],client+': stopped lessons do not occupy the calendar');
  assert.deepEqual(json(helpers.conflictNames('2026-10-22','15:30–16:30','nothing')),['数学'],client+': extras participate in conflicts');
  assert.deepEqual(json(helpers.conflictNames('2026-10-22','15:30–16:30','extra-a:2026-10-22')),[],client+': editing does not conflict with itself');
  assert.match(helpers.status({...data.course_dates[0],kind:'makeup',cancelled:true,holiday:true}),/补课已取消，原课仍停课/);
}
assert.equal(context.courseBlocks([data.course_dates[3]]),'','stopped rows are available to details, not actual calendar rendering');
console.log('Desktop/mobile course grouping, stable occurrences, source calendars and actual occupancy passed');
