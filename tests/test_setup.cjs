/* Setup uses only the pending context and submits credentials once, without trusting by default. */
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('static/setup/setup.js','utf8');
async function scenario(unauthorized=false){
  const requests=[],redirects=[],field=value=>({value}),elements={password:field(''),confirm_password:field(''),pin:field(''),confirm_pin:field(''),trust_device:{checked:false},label:field('')};
  const passwordFields=[elements.password,elements.confirm_password,elements.pin,elements.confirm_pin];
  const form={elements,hidden:true,querySelectorAll:()=>passwordFields,reportValidity:()=>true};
  const nodes={'#setup-form':form};for(const id of ['setup-submit','setup-account','setup-choice','setup-planning','setup-management','setup-error','setup-login','setup-device','setup-signout'])nodes['#'+id]={hidden:true,textContent:'',disabled:false};
  const context={document:{querySelector:selector=>nodes[selector]},window:{addEventListener(){}},location:{search:'?return=https://example.invalid/',replace:target=>redirects.push(target)},matchMedia:()=>({matches:false}),URLSearchParams,Error,console,
    async fetch(url,options){requests.push({url,options});const pending=url.endsWith('/context');return {status:unauthorized?401:200,ok:!unauthorized,async json(){return unauthorized?{error:'expired'}:{user:{id:1,name:'admin',admin:1,root_admin:1},auth:{setup_required:pending},setup_required:pending,csrf:pending?'pending-csrf':'rotated-csrf'};}};}};
  vm.runInNewContext(source,context);await new Promise(resolve=>setImmediate(resolve));
  return {requests,redirects,elements,form,nodes};
}
(async()=>{
  const test=await scenario();assert.deepEqual(test.requests.map(item=>item.url),['/api/auth/context']);assert.equal(test.form.hidden,false);assert.equal(test.elements.trust_device.checked,false);
  Object.assign(test.elements.password,{value:'a-long-enough-password-2026'});test.elements.confirm_password.value='different';test.elements.pin.value=test.elements.confirm_pin.value='012345';
  await test.form.onsubmit({preventDefault(){}});assert.equal(test.requests.length,1,'Mismatch must not submit credentials');
  test.elements.confirm_password.value=test.elements.password.value;await test.form.onsubmit({preventDefault(){}});
  const submit=test.requests[1];assert.equal(submit.url,'/api/auth/setup');assert.equal(submit.options.headers['X-CSRF-Token'],'pending-csrf');
  const payload=JSON.parse(submit.options.body);assert.equal(payload.pin,'012345');assert.equal(payload.trust_device,false);assert.equal(payload.password,'a-long-enough-password-2026');
  assert.equal(test.nodes['#setup-choice'].hidden,false);assert.equal(test.elements.password.value,'');assert.equal(test.elements.pin.value,'');
  test.nodes['#setup-management'].onclick();assert.equal(test.redirects.at(-1),'/?page=manage','Return parameters cannot redirect off-site');
  const expired=await scenario(true);assert.equal(expired.redirects.at(-1),'/?next=setup');
  console.log('first setup UI checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
