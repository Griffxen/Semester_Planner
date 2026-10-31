/* A pending session can access only its own credential setup. */
(() => {
  'use strict';
  const $=selector=>document.querySelector(selector),form=$('#setup-form'),button=$('#setup-submit');
  const preference=new URLSearchParams(location.search).get('return');
  const mobile=preference==='mobile'||preference!=='desktop'&&matchMedia('(max-width:700px)').matches;
  const entry=mobile?'/m/':'/',login=mobile?'/m/?next=setup':'/?next=setup';
  let csrf='',account=null,saving=false;
  const clear=()=>{for(const input of form.querySelectorAll('input[type=password]'))input.value='';};
  const leave=target=>{clear();location.replace(target);};
  const showError=message=>{$('#setup-error').textContent=message;};
  function expired(){clear();form.hidden=true;$('#setup-choice').hidden=true;$('#setup-signout').hidden=true;$('#setup-login').href=login;$('#setup-login').hidden=false;showError('会话已过期，请重新登录。');}
  async function request(path,method='GET',payload){
    const response=await fetch('/api/'+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    const result=await response.json();
    if(response.status===401){expired();throw Object.assign(Error('请重新登录。'),{status:401});}
    if(!response.ok)throw Error(result.error||'保存失败，请重试。');
    if(result.csrf)csrf=result.csrf;if(result.user)account=result.user;return result;
  }
  function completed(){
    clear();form.hidden=true;$('#setup-account').textContent=account?'@'+account.name:'';
    if(account?.admin){$('#setup-choice').hidden=false;$('#setup-planning').onclick=()=>leave(entry);$('#setup-management').onclick=()=>leave(mobile?'/m/?workspace=manage':'/?page=manage');}
    else leave(entry);
  }
  form.elements.trust_device.onchange=()=>{$('#setup-device').hidden=!form.elements.trust_device.checked;};
  form.onsubmit=async event=>{
    event.preventDefault();if(saving||!form.reportValidity())return;showError('');
    const fields=form.elements,password=fields.password.value,pin=fields.pin.value;
    if(password.length<12){showError('密码至少12位。');return;}
    if(password!==fields.confirm_password.value){showError('两次密码不一致。');return;}
    if(!/^[0-9]{4,6}$/.test(pin)){showError('PIN应为4–6位数字。');return;}
    if(pin!==fields.confirm_pin.value){showError('两次PIN不一致。');return;}
    saving=true;button.disabled=true;
    try{await request('auth/setup','POST',{password,pin,trust_device:fields.trust_device.checked,...(fields.trust_device.checked&&fields.label.value.trim()?{label:fields.label.value.trim()}:{})});completed();}
    catch(error){if(error.status!==401)showError(error.message);}
    finally{saving=false;button.disabled=false;}
  };
  $('#setup-signout').onclick=async()=>{try{await request('logout','POST',{});leave(login);}catch(error){if(error.status!==401)showError(error.message);}};
  window.addEventListener('pagehide',clear);
  (async()=>{try{const context=await request('auth/context');account=context.user;$('#setup-signout').hidden=false;$('#setup-account').textContent='@'+(account?.name||'');if(context.setup_required||context.auth?.setup_required)form.hidden=false;else completed();}catch(error){if(error.status===401)leave(login);else showError(error.message);}})();
})();
