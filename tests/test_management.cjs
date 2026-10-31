/* Regression checks for forced reauthentication despite a cached fresh session. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let pages=[],verifyCalls=0,storageCalls=0;
function page(){
  const error={textContent:''},button={disabled:false},form={password:'a-strong-password-123',querySelector:()=>button};
  return {form,hidden:false,isConnected:true,querySelector(selector){return selector==='form'?form:selector==='[data-pm-error]'?error:null;},querySelectorAll:()=>[],addEventListener(){}};
}
const M={data:{user:{id:1,name:'admin',admin:1},csrf:'old',auth:{method:'password',strong_password:true,password_fresh:true,admin_unlocked:false}},
  async api(path){
    if(path==='auth/verify'){verifyCalls++;return {csrf:'new-'+verifyCalls,auth:{method:'password',strong_password:true,password_fresh:true,admin_unlocked:true}};}
    if(path==='admin/storage'){storageCalls++;if(storageCalls===1)throw Object.assign(Error('verify again'),{status:403,code:'password_required'});return {database:{bytes:4096}};}
    throw Error('Unexpected endpoint: '+path);
  },async reload(){},openAccount(){},openAccounts(){},openPage(){const p=page();pages.push(p);return p;},async back(){},toast(){},goHome(){}};
const context={window:{Mobile:M,addEventListener(){}},document:{addEventListener(){},querySelectorAll:()=>[],querySelector:()=>null},
  MutationObserver:class{observe(){}disconnect(){}},FormData:class{constructor(form){return new Map([['password',form.password]]);}},
  location:{search:''},Intl,Date,URL,URLSearchParams,Map,Set,Error,Promise,Number,String,Object,Array,JSON,setInterval(){return 1;},setTimeout(){},console};
vm.runInNewContext(fs.readFileSync('static/management.js','utf8'),context);
(async()=>{
  const management=context.window.PlannerManagement;
  const unlock=management.ensureAdmin();
  assert.equal(pages.length,1,'A manually locked admin must prompt even while password_fresh is cached true');
  await pages[0].form.onsubmit({preventDefault(){}});await unlock;
  assert.equal(verifyCalls,1);assert.equal(M.data.csrf,'new-1');
  const read=management.request('admin/storage');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pages.length,2,'A server password_required must force verification despite cached freshness');
  await pages[1].form.onsubmit({preventDefault(){}});
  assert.equal((await read).database.bytes,4096);assert.equal(storageCalls,2);assert.equal(verifyCalls,2);
  console.log('management reauthentication checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
