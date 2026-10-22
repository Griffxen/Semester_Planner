/* Shared, dependency-free export studio for desktop and touch shells. */
(function(global){
'use strict';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const add=(d,n)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const save=(blob,name)=>{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);};
const jsonBlob=x=>new Blob([JSON.stringify(x,null,2)],{type:'application/json'});
function backup(d){return {format:2,exportedAt:new Date().toISOString(),settings:d.settings,tasks:[...d.tasks,...(d.deferred_tasks||[])],journal:d.journal,timetable:d.timetable,course_plan:d.course_plan,course_exceptions:d.course_exceptions,course_annotations:d.course_annotations||[],course_makeups:d.course_makeups||[],course_occurrence_snapshots:d.course_occurrence_snapshots||[],holidays:d.holidays};}
function selection(d){return {format:'planner-selection-v1',exportedAt:new Date().toISOString(),...d};}
function taskLines(t){return [t.title+(t.done?' · 已完成':''),
 [t.continues_before?'← 此前已开始':'',t.date+(t.start_time?' '+t.start_time:''),t.end_date!==t.date||t.end_time?'至 '+t.end_date+' '+(t.end_time||''):'',t.continues_after?'此后仍继续 →':'',t.category].filter(Boolean).join(' · '),t.notes].filter(Boolean);}
function dayEntries(d,date,includeRanges=true){
 const entries=[];
 for(const c of d.course_dates.filter(c=>c.date===date))entries.push({lines:[c.time+' · '+c.name+(c.room?' · '+c.room:''),c.notes,c.homework_required?'作业'+(c.homework_done?'已完成':'待提交')+(c.homework_notes?' · '+c.homework_notes:''):''].filter(Boolean)});
 for(const t of d.tasks){
  if(t.date&&t.date<=date&&t.end_date>=date&&(includeRanges||t.date===t.end_date))entries.push({lines:taskLines(t),color:d.categories.find(c=>c.name===t.category)?.color});
  if(t.due?.slice(0,10)===date)entries.push({lines:['截止 '+t.due.slice(11,16)+' · '+t.title]});
  for(const m of t.milestones||[])if(m.stop_at.slice(0,10)===date)entries.push({lines:[(m.done?'✓ ':'◆ ')+m.stop_at.slice(11,16)+' · '+t.title+' · '+(m.label||'关键节点')]});
 }
 for(const j of d.journal.filter(j=>j.date===date))entries.push({lines:['每日手记',j.body]});
 for(const x of d.date_counts||[])if(x.date===date)entries.push({lines:['另有 '+x.count+' 项安排']});
 return entries;
}
function wrap(ctx,text,width){const lines=[];for(const paragraph of String(text).split('\n')){let line='';for(const ch of paragraph){if(ctx.measureText(line+ch).width>width&&line){lines.push(line);line='';}line+=ch;}lines.push(line);}return lines;}
function blocks(d,layout,ctx){
 const result=[],lo=d.range.start,hi=d.range.end;if(lo>hi)return result;
 const cellWidth=layout==='week'?216:1120;
 const flatten=entries=>entries.flatMap(e=>e.lines.flatMap((s,i)=>wrap(ctx,s,cellWidth-28).map(text=>({text,color:i===0?e.color:null}))).concat([{text:''}]));
 if(layout==='list'){
  for(let date=lo;date<=hi;date=add(date,1)){const entries=dayEntries(d,date);if(entries.length)result.push({title:date,cells:[flatten(entries)]});}
 }else{
  let ws=add(lo,-((new Date(lo+'T12:00:00Z').getUTCDay()+6)%7));
  for(;ws<=hi;ws=add(ws,7)){
   result.push({title:ws+' — '+add(ws,6),cells:Array.from({length:7},(_,i)=>{const date=add(ws,i);return [{text:['周一','周二','周三','周四','周五','周六','周日'][i]+' '+date.slice(5)}].concat(date<lo||date>hi?[{text:'范围外'}]:flatten(dayEntries(d,date,false)));})});
   for(const t of d.tasks.filter(t=>t.date&&t.end_date>t.date&&t.date<=add(ws,6)&&t.end_date>=ws)){
    const start=Math.max(0,Math.round((Date.parse(t.date)-Date.parse(ws))/86400000)),end=Math.min(6,Math.round((Date.parse(t.end_date)-Date.parse(ws))/86400000));
    const spanWidth=(end-start+1)*216-28;
    result.push({title:'持续任务',start,span:end-start+1,cells:[taskLines(t).flatMap((s,i)=>wrap(ctx,s,spanWidth).map(text=>({text,color:i===0?d.categories.find(c=>c.name===t.category)?.color:null})))]});
   }
  }
 }
 return result;
}
async function renderImages(d,layout){
 if(document.fonts?.ready)await document.fonts.ready;
 const width=layout==='week'?1600:1200,probe=document.createElement('canvas'),ctx=probe.getContext('2d');if(!ctx)throw Error('此浏览器不支持图片导出');ctx.font='20px sans-serif';
 const source=blocks(d,layout,ctx),pages=[];let page=[],height=150;
 const flush=()=>{if(page.length){pages.push({blocks:page,height:height+60});page=[];height=150;}};
 for(const block of source){
  const fullHeight=60+Math.max(1,...block.cells.map(c=>c.length))*29;
  if(page.length&&fullHeight<=5790&&height+fullHeight+60>6000)flush();
  let offset=0,total=Math.max(1,...block.cells.map(c=>c.length));
  while(offset<total){
   if(6000-height-60<110)flush();
   const capacity=Math.floor((6000-height-60-60)/29),take=Math.min(total-offset,capacity);
   const piece={...block,title:block.title+(offset?' · 续页':''),cells:block.cells.map(c=>c.slice(offset,offset+take)),height:60+take*29};
   if(offset===0&&piece.height+height+60>6000)flush();
   page.push(piece);height+=piece.height;offset+=take;if(offset<total)flush();
  }
 }
 flush();if(!pages.length)pages.push({blocks:[{title:'所选范围内暂无内容',cells:[[]],height:100}],height:310});
 const output=[];
 for(let i=0;i<pages.length;i++){
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=pages[i].height;const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,width,canvas.height);
  const text=(s,x,y,size=20,color='#243c33')=>{c.fillStyle=/^#[0-9a-f]{6}$/i.test(color||'')?color:'#243c33';c.font=size+'px sans-serif';c.fillText(s,x,y);};
  // Long semester titles wrap rather than disappearing off the canvas.
  c.font='28px sans-serif';const title=wrap(c,d.settings.name,width-80);title.slice(0,2).forEach((s,j)=>text(s,40,42+j*32,28));
  text(d.range.start+' — '+d.range.end+' · '+(layout==='week'?'周历':'日期清单')+' · 第 '+(i+1)+' / '+pages.length+' 张',40,115,18);
  let y=150;
  for(const b of pages[i].blocks){
   c.fillStyle='#eef3ef';c.fillRect(40,y,width-80,38);text(b.title,52,y+26,21);y+=50;
   b.cells.forEach((cell,j)=>{const x=40+(layout==='week'?(b.start??j)*216:0),cw=layout==='week'?(b.span||1)*216:width-80;c.strokeStyle='#dce5df';c.strokeRect(x,y-4,cw,b.height-50);cell.forEach((line,k)=>text(line.text,x+12,y+22+k*29,20,line.color));});
   y+=b.height-50;
  }
  text('导出于 '+today()+' · Asia/Shanghai',40,canvas.height-20,16);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('图片生成失败，请缩小范围后重试');output.push(blob);
  // Give navigation and cancellation a chance between pages.
  await new Promise(resolve=>setTimeout(resolve,0));canvas.width=canvas.height=0;
 }
 return output;
}
function mount(root,options){
 const d=options.data,restricted=!!d.readonly,listeners=new AbortController();
 const checks=[['done','包含已完成任务和节点'],['nodes','包含关键节点',true],['timetable','包含课程',true],['notes','任务备注'],['course_notes','课程私人备注'],['homework','课程作业信息'],['busy_only','仅占用时间']];
 root.classList.add('export-studio');
 root.innerHTML=`<div class="ex-formats" role="group" aria-label="导出格式"><button data-format="image">图片</button>${restricted?'':'<button data-format="json">自选 JSON</button><button data-format="backup">完整备份</button>'}</div><nav class="ex-tabs" role="tablist" aria-label="导出步骤"><button role="tab" data-tab="rules">范围与内容</button><button role="tab" data-tab="items">逐条挑选</button><button role="tab" data-tab="preview">预览</button></nav><div class="ex-work"><section data-panel="rules"><form class="ex-rules"><label>日期范围<select name="range"><option value="week">本周</option><option value="two">本周和下周</option><option value="semester">整个学期</option><option value="custom">自定义日期</option></select></label><div class="ex-custom" hidden><label>开始<input name="start" type="date" value="${today()}"></label><label>结束<input name="end" type="date" value="${add(today(),6)}"></label></div><fieldset><legend>任务分类</legend>${d.categories.map(c=>`<label><input type="checkbox" name="categories" value="${esc(c.name)}" checked>${esc(c.name)}</label>`).join('')}</fieldset>${checks.filter(([k])=>!restricted||!['course_notes','homework'].includes(k)).map(([k,label,checked])=>`<label><input type="checkbox" name="${k}" ${checked?'checked':''}>${label}</label>`).join('')}<label>每日手记<select name="journal"><option value="none">不包含</option><option value="all">范围内全部</option><option value="selected">指定日期</option></select></label><fieldset class="ex-journals" hidden><legend>手记日期</legend>${d.journal.filter(j=>j.body).map(j=>`<label><input type="checkbox" name="journal_dates" value="${esc(j.date)}">${esc(j.date)}</label>`).join('')}</fieldset></form></section><section data-panel="items" hidden><p>取消勾选可排除整条内容；任务的截止与节点会一起排除。</p><div class="ex-items"></div></section><section data-panel="preview"><label class="ex-layout">图片排版<select name="layout"><option value="list">日期清单</option><option value="week">七列周历</option></select></label><p class="ex-summary" role="status"></p><div class="ex-preview"></div><div class="ex-pages"><button data-page="-1">上一张</button><span></span><button data-page="1">下一张</button></div></section></div><p class="ex-backup" hidden>完整备份不应用自选筛选，使用 format: 2 JSON 归档，包含课程来源、补课、备注和作业。本次不提供导入恢复。</p><p class="ex-error" role="alert"></p><footer><button class="ex-refresh">更新预览</button><button class="ex-download primary" disabled>下载</button></footer>`;
 const $=s=>root.querySelector(s),form=$('form');let format=restricted?'image':(options.initialFormat||'image'),tab='rules',serial=0,timer,result=null,candidate=null,blobs=[],urls=[],page=0,disposed=false,pending=false,downloadBusy=false;
 const excluded={tasks:new Set(),courses:new Set(),journal:new Set()};
 const clear=()=>{urls.forEach(URL.revokeObjectURL);urls=[];blobs=[];result=null;$('.ex-download').disabled=true;};
 function policy(withExclusions=true){const f=new FormData(form),p={format:format==='backup'?'image':format,range:f.get('range'),start:f.get('start'),end:f.get('end'),categories:f.getAll('categories'),journal:f.get('journal'),journal_dates:f.getAll('journal_dates')};checks.forEach(([key])=>p[key]=!!form.elements[key]?.checked);if(options.previewId!=null)p.preview_id=options.previewId;if(withExclusions)for(const key in excluded)p['exclude_'+key]=[...excluded[key]];return p;}
 function show(){
  root.dataset.tab=tab;root.dataset.format=format;
  root.querySelectorAll('[data-format]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.format===format)));
  root.querySelectorAll('[data-tab]').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.tab===tab));b.tabIndex=b.dataset.tab===tab?0:-1;b.hidden=format==='backup';});
  root.querySelectorAll('[data-panel]').forEach(p=>p.hidden=format==='backup'||p.dataset.panel!==tab);
  $('.ex-backup').hidden=format!=='backup';$('.ex-refresh').hidden=format==='backup';$('.ex-layout').hidden=format!=='image';$('.ex-pages').hidden=format!=='image'||blobs.length<2;
  if(format==='backup')$('.ex-download').disabled=false;
 }
 function showPage(){const host=$('.ex-preview');host.replaceChildren();if(format==='image'){const img=document.createElement('img');img.alt='最终导出图片，第 '+(page+1)+' 张';img.src=urls[page];host.append(img);}else{const pre=document.createElement('pre');pre.textContent=JSON.stringify(result,null,2);host.append(pre);}$('.ex-pages span').textContent=(page+1)+' / '+blobs.length;root.querySelector('[data-page="-1"]').disabled=page===0;root.querySelector('[data-page="1"]').disabled=page>=blobs.length-1;show();}
 function items(data){candidate=data;const groups=[['tasks','任务',[...data.tasks,...(data.date_counts||[]).map(x=>({id:'count:'+x.date,title:x.date+' · 另有 '+x.count+' 项安排'}))],t=>String(t.id),t=>t.title],['courses','课程',data.course_dates,c=>c.export_key,c=>c.date+' '+c.time+' '+c.name],['journal','手记',data.journal,j=>j.date,j=>j.date]];
  $('.ex-items').innerHTML=groups.map(([kind,label,rows,key,title])=>'<fieldset><legend>'+label+' · '+rows.length+'</legend>'+rows.map(row=>`<label><input type="checkbox" data-kind="${kind}" value="${esc(key(row))}" ${excluded[kind].has(String(key(row)))?'':'checked'}>${esc(title(row))}</label>`).join('')+'</fieldset>').join('');
 }
 async function update(){
  if(disposed||format==='backup')return;const id=++serial;pending=true;clear();$('.ex-preview').replaceChildren();$('.ex-error').textContent='';$('.ex-summary').textContent='正在生成预览…';
  try{
   if(form.elements.namedItem('range').value==='custom'&&(!form.elements.start.value||!form.elements.end.value))throw Error('请选择开始和结束日期');
   const raw=policy(),base=await options.api('export-preview','POST',policy(false));if(disposed||id!==serial)return;
   items(base);const data=await options.api('export-preview','POST',raw);if(disposed||id!==serial)return;
   const built=format==='image'?await renderImages(data,$('[name="layout"]').value):[jsonBlob(selection(data))];if(disposed||id!==serial)return;
   const builtUrls=format==='image'?await Promise.all(built.map(b=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('图片预览读取失败'));reader.readAsDataURL(b);}))):[];if(disposed||id!==serial)return;result=selection(data);blobs=built;urls=builtUrls;page=0;
   $('.ex-summary').textContent=`${data.range.start} — ${data.range.end} · ${data.summary.tasks} 项任务 · ${data.summary.courses} 次课程 · ${data.summary.journal} 篇手记${data.summary.arrangements?' · '+data.summary.arrangements+' 项其他安排':''}`;
   $('.ex-download').disabled=false;showPage();
  }catch(error){if(!disposed&&id===serial){$('.ex-error').textContent=error.message;$('.ex-summary').textContent='预览未完成，请重试';}}
  finally{if(id===serial)pending=false;}
 }
 function invalidate(){++serial;pending=false;clear();$('.ex-preview').replaceChildren();$('.ex-summary').textContent='设置已变化，正在更新…';clearTimeout(timer);timer=setTimeout(update,300);show();}
 root.addEventListener('change',e=>{if(e.target.dataset.kind){const set=excluded[e.target.dataset.kind];e.target.checked?set.delete(e.target.value):set.add(e.target.value);}$('.ex-custom').hidden=form.elements.namedItem('range').value!=='custom';$('.ex-journals').hidden=form.elements.namedItem('journal').value!=='selected';invalidate();},{signal:listeners.signal});
 root.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b)return;
  if(b.dataset.format){format=b.dataset.format;invalidate();}
  if(b.dataset.tab){tab=b.dataset.tab;show();}
  if(b.dataset.page){page=Math.max(0,Math.min(blobs.length-1,page+Number(b.dataset.page)));showPage();}
  if(b.classList.contains('ex-refresh')){clearTimeout(timer);update();}
  if(b.classList.contains('ex-download')&&!downloadBusy){
   downloadBusy=true;b.disabled=true;const id=serial;
   try{
    if(format==='backup'){const fresh=await options.api('state');if(fresh.readonly)throw Error('只读日程不能导出完整备份');save(jsonBlob(backup(fresh)),'semester-'+today()+'.json');}
    else if(!pending&&result){
     const fresh=await options.api('export-preview','POST',policy());
     if(disposed||id!==serial)return;
     const previous={...result};delete previous.format;delete previous.exportedAt;
     if(JSON.stringify(fresh)!==JSON.stringify(previous)){invalidate();throw Error('内容或授权已变化，正在重新生成预览，请核对后下载');}
     save(blobs[page],format==='image'?'日程-'+today()+'-'+(page+1)+'.png':'日程自选-'+today()+'.json');
    }
   }catch(error){if(!disposed)$('.ex-error').textContent=error.message;}
   finally{downloadBusy=false;if(!disposed)b.disabled=format!=='backup'&&!result;}
  }
 },{signal:listeners.signal});
 root.querySelector('.ex-tabs').addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const tabs=[...root.querySelectorAll('[data-tab]')],i=tabs.findIndex(b=>b.dataset.tab===tab),n=e.key==='Home'?0:e.key==='End'?2:(i+(e.key==='ArrowRight'?1:2))%3;tab=tabs[n].dataset.tab;show();tabs[n].focus();});
 form.addEventListener('submit',e=>e.preventDefault());show();update();
 return ()=>{disposed=true;listeners.abort();++serial;clearTimeout(timer);clear();root.replaceChildren();};
}
function open(options){
 if(global.Mobile){
  let dispose;const init=page=>{dispose?.();dispose=mount(page.querySelector('.ex-host'),options);};
  const page=global.Mobile.openPage({title:'自选导出',body:'<div class="ex-host"></div>',onMount(page){init(page);page.addEventListener('mobile:resume',()=>init(page));page.addEventListener('mobile:dispose',()=>dispose?.());}});
  if(page){const observer=new MutationObserver(()=>{if(page.hidden)dispose?.();});observer.observe(page,{attributes:true,attributeFilter:['hidden']});page.addEventListener('mobile:dispose',()=>observer.disconnect());}
 }else{
  const dialog=document.createElement('dialog');dialog.className='ex-dialog';dialog.innerHTML='<header><h2>自选导出</h2><button aria-label="关闭导出">×</button></header><div class="ex-host"></div>';document.body.append(dialog);const dispose=mount(dialog.querySelector('.ex-host'),options);dialog.querySelector('header button').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{dispose();dialog.remove();});dialog.showModal();
 }
}
global.PlannerExport={open,mount,renderImages,dayEntries,selection,backup};
})(typeof window==='undefined'?globalThis:window);
