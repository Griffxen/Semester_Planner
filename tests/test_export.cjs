/* Geometry/pagination checks run without browser or third-party packages. */
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const fs=require('node:fs');
const pages=[];
const context={Blob,Intl,Date,setTimeout,console,document:{fonts:{ready:Promise.resolve()},createElement(tag){
 assert.equal(tag,'canvas');
 const canvas={width:0,height:0,drawn:[],getContext(){return {font:'',measureText:s=>({width:Array.from(s).length*20}),fillRect(){},strokeRect(){},fillText(text,x,y){assert(y<=canvas.height,`text outside page: ${text}`);assert(x>=0);canvas.drawn.push(text);}};},toBlob(cb){pages.push({width:this.width,height:this.height,drawn:this.drawn.slice()});cb(new Blob(['png']));}};return canvas;
}}};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/export.js'),'utf8'),context);
const E=context.PlannerExport;
const d={settings:{name:'演示学期'},range:{start:'2026-10-12',end:'2026-10-18'},selection:{},summary:{},categories:[],journal:[],course_dates:[],date_counts:[],tasks:[{id:'t',title:'任务',category:'科研',date:'2026-10-12',end_date:'2026-10-18',notes:Array.from({length:850},(_,i)=>'备注第'+i+'行').join('\n'),milestones:[{label:'节点',stop_at:'2026-10-13T10:00'}],due:'2026-10-14T12:00'}]};
(async()=>{
 for(const layout of ['list','week']){
  pages.length=0;const blobs=await E.renderImages(d,layout);assert(blobs.length>1);
  assert(pages.every(p=>p.width===(layout==='list'?1200:1600)&&p.height<=6000));
  const text=pages.flatMap(p=>p.drawn).join('\n');for(let i=0;i<850;i++)assert(text.includes('备注第'+i+'行'));
  assert(text.includes('续页'));assert(text.includes('截止'));assert(text.includes('节点'));
 }
 pages.length=0;await E.renderImages({...d,tasks:[]},'list');assert(pages[0].drawn.includes('所选范围内暂无内容'));
 const p=E.selection(d);assert.equal(p.format,'planner-selection-v1');assert(!('timetable' in p));
 const b=E.backup({...d,timetable:['whole'],course_exceptions:[],holidays:[]});assert.equal(b.format,2);assert.equal(b.tasks.length,1);
 const deferred={id:'d',deferred:true,previous_schedule:{date:'2026-09-01',milestones:[{label:'原节点',done:true}]}};
 const complete=E.backup({...d,deferred_tasks:[deferred]});assert.equal(complete.tasks.length,2);assert.deepEqual(complete.tasks[1],deferred);assert.equal(d.tasks.length,1);
 const courseArchive={courses:[{course_id:'math',slots:[{slot_id:'mon'}]}],sources:[{template_id:'default',version:1}]};
 const privateRecord={course_key:'mon',date:'2026-10-12',notes:'保留备注',homework_required:true,homework_notes:'保留作业'};
 const archive=E.backup({...d,course_plan:courseArchive,course_annotations:[privateRecord],course_makeups:[{id:'extra'}],course_occurrence_snapshots:[{id:'old'}]});
 assert.deepEqual(archive.course_plan,courseArchive);assert.deepEqual(archive.course_annotations,[privateRecord]);assert.equal(archive.course_makeups[0].id,'extra');assert.equal(archive.course_occurrence_snapshots[0].id,'old');
 const entries=E.dayEntries(d,'2026-10-13');assert(entries.some(x=>x.lines.join('').includes('节点')));
 console.log('export geometry, pagination, point events and formats passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
