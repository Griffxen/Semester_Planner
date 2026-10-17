/* Local display preference, shared by phone and desktop. */
window.WorkloadSettings=(()=>{
  const U=MobileDomain;
  function mount(host,onChange=()=>{}) {
    host.innerHTML='<div class="density-settings"><label>最深颜色对应的密度 <output data-density-value></output><input data-density-input type="range" min="0.1" max="2" step="0.1" aria-label="最深颜色对应的密度"></label><div class="density-samples" aria-label="密度与颜色示例"></div><p data-density-note role="status" hidden></p><button type="button" data-density-reset>恢复默认</button></div>';
    const input=host.querySelector('[data-density-input]');input.value=U.densityThreshold();
    function preview(){
      const value=Number(input.value);host.querySelector('[data-density-value]').textContent=value.toFixed(1)+' 项/小时';
      host.querySelector('.density-samples').innerHTML=[0,.25,.5,.75,1].map(r=>'<span><i class="timebar '+(r?'has-untimed':'')+'"></i><small>'+Number((value*r).toFixed(2))+'</small></span>').join('');
      host.querySelectorAll('.density-samples .timebar').forEach((bar,i)=>bar.style.setProperty('--density-strength',String(i/4)));
    }
    function apply(){const persisted=U.setDensityThreshold(input.value);preview();const note=host.querySelector('[data-density-note]');note.hidden=persisted;note.textContent=persisted?'':'设置未能保存';onChange();window.dispatchEvent(new CustomEvent('workload:density'));}
    input.oninput=apply;host.querySelector('[data-density-reset]').onclick=()=>{input.value=.5;apply();};preview();
  }
  function openMobile(){window.Mobile.openPage({title:'密度设置',onMount:page=>mount(page.querySelector('.m-page-body'))});}
  return {mount,openMobile};
})();
