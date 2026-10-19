(()=>{
 const launch=(initialFormat='image')=>PlannerExport.open({initialFormat,data:Mobile.data,api:Mobile.api,previewId:Mobile.previewId||null});
 Mobile.exportImage=()=>launch();Mobile.exportData=()=>launch('backup');
})();
