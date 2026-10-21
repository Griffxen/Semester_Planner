const assert = require('node:assert/strict');
const {request} = require('../static/task-conflicts.js');
const conflict = code => Object.assign(new Error('业务冲突'), {status:409, code});
(async () => {
  for (const [method,code,flag] of [['PUT','unfinished_milestones','force_complete'],['DELETE','task_not_deferred','force_delete']]) {
    const payload = {version:3, done:true, milestones:[{done:false}]};
    const calls = [];
    const send = async (...args) => {calls.push(args); if(calls.length===1) throw conflict(code); return {ok:true};};
    assert.deepEqual(await request(send,'tasks/a',method,payload,async (error,action) => {assert.equal(action.flag,flag); return true;}), {ok:true});
    assert.equal(calls.length,2);
    assert.equal(calls[1][2][flag],true);
    assert.equal(calls[1][2].version,3);
    assert.equal(calls[1][2].milestones[0].done,false);
    assert.equal(payload[flag],undefined,'force must not leak into a draft or undo record');
    let attempts=0;
    await assert.rejects(request(async()=>{attempts++; throw conflict(code);},'tasks/a',method,payload,async()=>false), error=>error.cancelled);
    assert.equal(attempts,1,'cancel sends no follow-up write');
    let retry=0;
    await assert.rejects(request(async()=>{if(++retry===1)throw conflict(code); throw Object.assign(new Error('版本已变化'),{status:409});},'tasks/a',method,payload,async()=>true), /版本已变化/);
    assert.equal(retry,2,'force retry cannot loop or fetch a newer version');
  }
  for(const error of [Object.assign(new Error('版本冲突'),{status:409}),Object.assign(conflict('unfinished_milestones'),{status:403})]) {
    await assert.rejects(request(async()=>{throw error;},'tasks/a','PUT',{},async()=>{throw new Error('must not confirm');}), value=>value===error);
  }
  assert.deepEqual(await request(async()=>({ok:true}),'tasks','POST',{done:true}),{ok:true});
  console.log('Task force retry, cancellation, draft isolation and stale version checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
