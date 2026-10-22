/* Deferred task presentation over the existing desktop editor and confirmation flow. */
(function () {
  'use strict';
  const D = DeferredTasks;
  const find = id => state?.deferred_tasks?.find(t => t.id === id);
  const entry = document.createElement('button');
  entry.id = 'deferred-button'; entry.type = 'button'; entry.dataset.icon = 'pause';
  $('#category-section').before(entry);
  entry.onclick = () => window.PlannerWorkspace ? PlannerWorkspace.show('deferred') : (workspacePage = 'deferred', render());
  const page = document.createElement('section'); page.id = 'deferred-workspace'; page.hidden = true;
  page.innerHTML = '<header class="workspace-heading"><div><h1>暂缓任务</h1><p>尚未安排日期的任务</p></div><button class="primary" type="button" data-new-deferred>新建任务</button></header><section class="deferred-workspace-panel"><div class="deferred-workspace-tools"><input type="search" id="deferred-search" placeholder="搜索暂缓任务…" aria-label="搜索暂缓任务"><span id="deferred-summary"></span></div><div id="deferred-board"></div></section>';
  document.querySelector('main').append(page);
  page.querySelector('[data-new-deferred]').onclick = () => openTask('', undefined);
  $('#deferred-search').oninput = event => {$('#search').value = event.target.value; render();};
  const renderBefore = render;
  render = function () {
    if (!state) return;
    if (state.readonly && workspacePage === 'deferred') workspacePage = 'home';
    const deferredView = workspacePage === 'deferred';
    renderBefore();
    entry.hidden = !!state.readonly;
    entry.innerHTML = uiIcon('pause') + '<span>暂缓任务 · ' + (state.deferred_tasks || []).length + '</span>';
    entry.classList.toggle('selected', deferredView);
    entry.setAttribute('aria-pressed', String(deferredView));
    if (!deferredView) return;
    const rows = D.filtered(state, {category:filter,query:$('#search').value});
    if ($('#deferred-search').value !== $('#search').value) $('#deferred-search').value = $('#search').value;
    $('#deferred-summary').textContent = (filter || '全部分类') + ' · ' + rows.length + ' 项暂缓任务';
    const markup = D.list(rows);
    if ($('#deferred-board').innerHTML !== markup) $('#deferred-board').innerHTML = markup;
    $('#categories').querySelectorAll('[data-filter]').forEach(button => {
      button.querySelector('span').textContent = D.filtered(state,{category:button.dataset.filter}).length;
    });
  };
  $('#deferred-board').addEventListener('click', event => {
    const resume = event.target.closest('[data-resume-deferred]');
    const detail = event.target.closest('[data-deferred-task]');
    if (resume) editDeferred(resume.dataset.resumeDeferred, true);
    else if (detail) showDeferred(detail.dataset.deferredTask);
  });

  const selector = document.createElement('label'); selector.className = 'deferred-mode';
  selector.innerHTML = '任务状态<select name="deferred"><option value="false">正常安排</option><option value="true">暂缓</option></select>';
  taskPanels.content.prepend(selector);
  const reference = document.createElement('div'); taskPanels.content.append(reference);
  let referenceTask = null, rescheduling = false;
  function syncMode() {
    const deferred = taskForm.elements.deferred.value === 'true';
    for (const name of ['time','nodes']) {
      taskTabs.querySelector(`[data-task-tab="${name}"]`).hidden = deferred;
      taskPanels[name].querySelectorAll('input,select,textarea,button').forEach(el => {el.disabled = deferred;});
    }
    for (const name of ['due','done']) {
      taskForm.elements[name].disabled = deferred;
      taskForm.elements[name].closest('label').hidden = deferred;
    }
    if (!deferred) scheduleModeUI();
    if (deferred && ['time','nodes'].includes(taskTab)) selectTaskTab('content');
    if (taskTab === 'review') taskReview();
  }
  taskForm.elements.deferred.onchange = syncMode;
  const openBefore = openTask;
  openTask = function (date, id, edit = false) {
    if (id && find(id)) {if (edit) editDeferred(id); else showDeferred(id); return;}
    referenceTask = null; rescheduling = false; reference.innerHTML = '';
    openBefore(date, id, edit);
    if (!$('#task-dialog').open) return;
    taskForm.elements.deferred.value = !id && workspacePage === 'deferred' ? 'true' : 'false';
    selector.hidden = !!editing?.done;
    syncMode(); resetBaseline();
  };
  function resetBaseline() {taskSnapshot = JSON.stringify(Object.fromEntries(new FormData(taskForm)));}
  function fillSchedule(p) {
    for (const name of ['date','end_date','start_time','end_time','due']) taskForm.elements[name].value = p[name] || '';
    taskForm.elements.schedule_mode.value = p.start_time ? 'minute' : 'date';
    setMilestoneRows(D.clone(p.milestones || [])); syncMode();
  }
  function editDeferred(id, resume = false, copy = false) {
    const task = find(id); if (!task || state.readonly || busy || confirmationPending) return;
    openTask('', undefined);
    editing = copy ? null : {...D.payload(task),id:task.id};
    referenceTask = task; rescheduling = resume;
    for (const name of ['title','short_title','category','notes']) taskForm.elements[name].value = task[name] || '';
    taskForm.elements.done.checked = false;
    taskForm.elements.deferred.value = resume ? 'false' : 'true';
    selector.hidden = resume;
    fillSchedule({});
    reference.innerHTML = D.reference(task) + (resume && task.previous_schedule?.date ? '<button type="button" data-use-previous>带入原安排</button>' : '');
    reference.querySelector('[data-use-previous]')?.addEventListener('click', () => {fillSchedule(task.previous_schedule); selectTaskTab('time');});
    $('#task-heading').textContent = resume ? '重新安排任务' : copy ? '复制暂缓任务' : '编辑暂缓任务';
    syncMode(); selectTaskTab('content'); resetBaseline();
  }
  $('#task-dialog').addEventListener('close', () => {
    const resumed = referenceTask?.deferred && editing && state?.tasks.find(t => t.id === editing.id);
    if (resumed) {if (window.PlannerWorkspace) PlannerWorkspace.show('home', {view:'today', date:resumed.date}); else {workspacePage = 'home'; nextView = 'today'; nextWeek = resumed.date; render();}}
  });
  const draftBefore = taskDraft;
  taskDraft = function () {
    const deferred = taskForm.elements.deferred.value === 'true';
    let result;
    if (deferred) {
      result = {title:taskForm.elements.title.value.trim(),short_title:taskForm.elements.short_title.value.trim(),category:taskForm.elements.category.value,notes:taskForm.elements.notes.value,done:false,date:'',end_date:'',start_time:'',end_time:'',due:'',milestones:[]};
      if (editing) result.version = editing.version;
    } else result = draftBefore();
    result.deferred = deferred;
    if (referenceTask && !editing) result.previous_schedule = D.clone(referenceTask.previous_schedule || {});
    return result;
  };
  const validateBefore = validateTaskDraft;
  validateTaskDraft = function () {
    if (taskForm.elements.deferred.value !== 'true') return validateBefore();
    const invalid = [...taskForm.elements].find(el => el.willValidate && !el.validity.valid);
    if (invalid) {selectTaskTab('content'); invalid.reportValidity(); return false;}
    if (!taskForm.elements.title.value.trim()) {selectTaskTab('content'); $('#task-error').textContent = '请填写任务名称'; return false;}
    $('#task-error').textContent = ''; return true;
  };
  const reviewBefore = taskReview;
  taskReview = function () {
    if (taskForm.elements.deferred.value !== 'true') return reviewBefore();
    const d = taskDraft();
    taskPanels.review.innerHTML = `<h3>${esc(d.title)}</h3><dl class="task-parameters"><dt>分类</dt><dd>${esc(d.category)}</dd><dt>简称</dt><dd>${esc(d.short_title || '无')}</dd><dt>状态</dt><dd>暂缓</dd><dt>备注</dt><dd>${esc(d.notes || '无')}</dd></dl>`;
  };
  const tabBefore = selectTaskTab;
  selectTaskTab = function (tab) {
    if (taskForm.elements.deferred.value === 'true' && ['time','nodes'].includes(tab)) tab = 'content';
    tabBefore(tab);
    if (rescheduling && tab === 'review') taskForm.querySelector('.primary').textContent = '保存并重新安排';
  };

  async function deferTask(task, button, error) {
    if (busy || confirmationPending) return;
    lastActionButton = button;
    if (!await askConfirm('暂缓「'+task.title+'」？原安排将保留作参考。','确认暂缓')) return;
    try {
      if (await mutation(() => api('tasks/'+task.id,'PUT',{...D.payload(task),deferred:true}))) {
        $('#task-details')?.close(); toast('任务已暂缓');
      }
    } catch (e) {error.textContent = e.message;}
  }
  const detailsBefore = showTaskDetails;
  showTaskDetails = function (id) {
    if (find(id)) {showDeferred(id); return;}
    detailsBefore(id);
    const task = state.tasks.find(t => t.id === id), dialog = $('#task-details');
    if (!task || task.done || state.readonly || !dialog) return;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '暂缓'; button.dataset.deferTask = id;
    dialog.querySelector('.task-detail-actions').append(button);
    button.onclick = () => deferTask(task, button, dialog.querySelector('[data-error]'));
  };
  const detailDialog = document.createElement('dialog'); detailDialog.id = 'deferred-details'; document.body.append(detailDialog);
  function showDeferred(id) {
    const task = find(id); if (!task || state.readonly) return;
    detailDialog.dataset.taskId = id;
    detailDialog.innerHTML = `<div class="dialog-head"><h2>${esc(task.title)}</h2><button type="button" data-close aria-label="关闭">×</button></div><div class="deferred-detail-body"><p>${esc(task.category)} · 暂缓</p>${task.short_title?`<p>简称：${esc(task.short_title)}</p>`:''}<p class="deferred-note">${esc(task.notes || '无备注')}</p>${D.reference(task)}</div><div class="task-detail-actions"><button type="button" data-resume class="primary">重新安排</button><button type="button" data-edit>编辑</button><button type="button" data-copy>复制任务</button><button type="button" data-delete class="soft-danger">删除</button></div><p data-error role="alert"></p>`;
    detailDialog.querySelector('[data-close]').onclick = () => detailDialog.close();
    detailDialog.querySelector('[data-resume]').onclick = () => editDeferred(id, true);
    detailDialog.querySelector('[data-edit]').onclick = () => editDeferred(id);
    detailDialog.querySelector('[data-copy]').onclick = () => editDeferred(id, false, true);
    detailDialog.querySelector('[data-delete]').onclick = async event => {
      if (busy || confirmationPending) return;
      lastActionButton = event.currentTarget;
      if (!await askConfirm('删除「'+task.title+'」？','确认删除')) return;
      try {
        if (await mutation(() => api('tasks/'+id,'DELETE',{version:task.version}))) {
          undoDelete = D.payload(task); $('#undo-delete').hidden = false; detailDialog.close(); toast('任务已删除，可撤销');
        }
      } catch (e) {detailDialog.querySelector('[data-error]').textContent = e.message;}
    };
    detailDialog.showModal();
  }
  const returnedBefore = refreshReturnedDetails;
  refreshReturnedDetails = function (dialog) {
    if (dialog === detailDialog) {
      if (find(dialog.dataset.taskId)) showDeferred(dialog.dataset.taskId);
      else dialog.close();
    } else returnedBefore(dialog);
  };
  // Preserve complete backups when the optional export studio is not installed.
  if (!window.PlannerExport) $('#export-button').onclick = () => {
    if (!state || state.readonly) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(D.backup(state),null,2)],{type:'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'semester-'+today()+'.json';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url),60000);
  };
  if (state) render();
})();
