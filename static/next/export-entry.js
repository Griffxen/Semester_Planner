/* Override only renewed frontend entry points, leaving the legacy snapshot intact. */
(()=>{
 const launch=(initialFormat='image')=>PlannerExport.open({initialFormat,data:state,api,previewId:previewId||null});
 $('#image-button').textContent='自选图片 / JSON';$('#image-button').onclick=()=>launch();
 $('#export-button').textContent='完整 JSON 备份';$('#export-button').onclick=()=>launch('backup');
})();
