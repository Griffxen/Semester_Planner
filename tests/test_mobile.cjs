/* Boundary cases for the independent mobile calendar, without DOM or real data. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const U = require('../static/mobile/domain.js');
const filters = {category:'',query:'',hideDone:false,showCourses:true};
const tasks = [
  {id:'daily',title:'练习',category:'课业',date:'2026-10-17',end_date:'2026-10-17',start_time:'09:00',end_time:'10:00',done:false,milestones:[]},
  {id:'long',title:'阅读',category:'科研',date:'2026-10-12',end_date:'2026-10-25',start_time:'',end_time:'',done:false,milestones:[{label:'独立节点',stop_at:'2026-10-26T19:00+08:00',done:false},{label:'已完成节点',stop_at:'2026-10-17T18:00+08:00',done:true}]},
  {id:'due',title:'独立截止',category:'个人',date:'2026-10-20',end_date:'2026-10-20',due:'2026-10-17T23:59',done:false,milestones:[]},
  {id:'dated',title:'日期安排',category:'个人',date:'2026-10-17',end_date:'2026-10-17',done:false,milestones:[]},
];
const data = {readonly:false,tasks,categories:[],course_dates:[{name:'示例课',date:'2026-10-17',time:'09:30–11:00',cancelled:false},{name:'取消课',date:'2026-10-17',time:'13:00–14:00',cancelled:true}]};
const entries=U.dayEntries(data,'2026-10-17',filters);
assert.deepEqual(entries.timed.map(x=>x.kind),['task','course','node','deadline']);
assert.equal(entries.dated.length,1);
assert.equal(entries.ongoing.length,1);
assert.deepEqual(U.busyIntervals(data,'2026-10-17',filters),[[540,660]],'overlapping time slots must be merged; date tasks are not all-day busy');
const emptyDay=U.scheduleDensity([],4);
assert.equal(emptyDay.freeMinutes,16*60);
assert.equal(emptyDay.density,4/16);
const overlapping=U.scheduleDensity([[540,660],[600,780]],4);
assert.deepEqual(overlapping.busy,[[540,780]]);
assert.deepEqual(overlapping.free,[[480,540],[780,1440]]);
assert.equal(overlapping.freeMinutes,12*60,'overlapping busy slots must not be subtracted twice');
assert.equal(overlapping.density,4/12);
assert.ok(overlapping.strength>emptyDay.strength,'same workload is darker with less free time');
assert.ok(U.scheduleDensity([],6).strength>emptyDay.strength,'more undated tasks increase density');
assert.equal(U.scheduleDensity([[0,480]],4).density,emptyDay.density,'before-08:00 time must not reduce the visible free window');
assert.deepEqual(U.scheduleDensity([[420,540],[1380,1500]],4).free,[[540,1380]],'clip intervals to 08:00–24:00');
const fullyBooked=U.scheduleDensity([[0,1440]],3);
assert.deepEqual(fullyBooked.free,[]);
assert.equal(fullyBooked.density,null,'fully booked days have no finite workload density');
assert.equal(U.scheduleDensity([],0).strength,0,'no undated tasks means no tint');
assert.equal(U.dayEntries(data,'2026-10-26',filters).nodes[0].task.id,'long','nodes remain visible outside parent planned range');
assert.equal(U.dayEntries(data,'2026-10-17',{...filters,hideDone:true}).nodes.length,0);
assert.equal(U.dayEntries(data,'2026-10-17',{...filters,showCourses:false}).courses.length,0);
assert.equal(U.filteredTasks(data,{...filters,query:'独立节点'})[0].id,'long');
assert.equal(U.filteredTasks(data,{...filters,category:'个人'}).length,2);
const shared={...data,readonly:true,share:{enabled:true,start:'2026-10-17',end:'2026-10-18'}};
assert.equal(U.dayEntries(shared,'2026-10-26',filters).timed.length,0);
assert.equal(U.allowedDate({...shared,share:{...shared.share,enabled:false}},'2026-10-17'),false);
assert.equal(U.monday('2026-10-18'),'2026-10-12');
assert.equal(U.add('2026-12-31',1),'2027-01-01');
assert.equal(U.esc('<script>"&'), '&lt;script&gt;&quot;&amp;');

const bootstrap=fs.readFileSync(path.join(__dirname,'../static/mobile-entry.js'),'utf8');
function entry(width,search='',stored=null){
  let redirect=null;
  const memory=new Map(stored?[['semester-desktop',stored]]:[]);
  vm.runInNewContext(bootstrap,{URLSearchParams,location:{search,hash:'',replace:url=>{redirect=url;}},sessionStorage:{setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k),getItem:k=>memory.get(k)},matchMedia:()=>({matches:width<=700})});
  return redirect;
}
assert.equal(entry(390),'/m/');
assert.equal(entry(700),'/m/');
assert.equal(entry(701),null);
assert.equal(entry(390,'?desktop=1'),null);
assert.equal(entry(390,'','1'),null);
assert.equal(entry(390,'?mobile=1','1'),'/m/');
console.log('Mobile calendar, free-time density and entry selection checks passed');

assert.deepEqual(U.workloadCounts(data,'2026-10-17',filters),{slots:2,dated:1,points:2,untimed:3});
assert.equal(U.workloadCounts(data,'2026-10-17',{...filters,hideDone:true}).untimed,2);
assert.deepEqual(U.workloadCounts(data,'2026-10-25',filters),{slots:0,dated:0,points:1,untimed:1},'long task end counts once on its end date');
assert.equal(U.workloadCounts(data,'2026-10-24',filters).untimed,0,'long task is not counted on every day');
assert.equal(U.workloadCounts(data,'2026-10-26',filters).untimed,1,'point node counts without occupied duration');
assert.equal(U.workloadCounts(shared,'2026-10-26',filters).untimed,0,'share boundary remains enforced');
assert.equal(U.workloadCounts({...data,tasks:tasks.map(t=>t.id==='long'?{...t,done:true}:t)},'2026-10-25',{...filters,hideDone:true}).untimed,0);

assert.equal(U.scheduleDensity([],4,480,1440,.25).strength,1);
assert.equal(U.scheduleDensity([],4,480,1440,1).strength,.25);
assert.throws(()=>U.setDensityThreshold(0));
assert.throws(()=>U.setDensityThreshold(Infinity));
U.setDensityThreshold(1);assert.equal(U.densityThreshold(),1);assert.equal(U.scheduleDensity([],4).strength,.25);U.setDensityThreshold(.5);

assert.deepEqual(U.workloadCounts(data,'2026-10-17',{...filters,showCourses:false}),{slots:1,dated:1,points:2,untimed:3});
assert.deepEqual(U.workloadCounts(data,'2026-10-17',{...filters,category:'个人'}),{slots:1,dated:1,points:1,untimed:2});
const overlapData={...data,tasks:[...tasks,{...tasks[0],id:'overlap',start_time:'09:30',end_time:'10:30'}]};
assert.equal(U.workloadCounts(overlapData,'2026-10-17',filters).slots,3,'count scheduled arrangements separately even when their occupied times overlap');
