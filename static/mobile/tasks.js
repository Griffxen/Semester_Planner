/* Mobile task pages share the existing API and keep unfinished edits in memory. */
(function () {
  'use strict';
  const M = window.Mobile;
  const U = M.utils;
  const esc = U.esc;
  const pendingPages = new WeakSet();
  const clone = value => JSON.parse(JSON.stringify(value));
  const localTime = value => String(value || '').slice(0, 16);
  const dateAttrs = 'min="0001-01-01" max="9999-12-31"';
  const momentAttrs = 'min="0001-01-01T00:00" max="9999-12-31T23:59"';
  const findTask = id => [...(M.data?.tasks || []),...(M.data?.deferred_tasks || [])].find(task => String(task.id) === String(id));
  const button = (action, label, classes = '') => `<button type="button" class="${classes}" data-action="${action}">${label}</button>`;
  const errorBox = '<p class="m-error" role="alert" data-error data-page-error></p>';
  const option = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;

  function requireWritable() {
    if (!M.readonly()) return true;
    M.toast('当前日程仅供查看');
    return false;
  }

  function showError(page, error) {
    if (page?.isConnected) M.error(page, error);
    else M.toast(error.message || '操作失败，请重试');
  }

  function watchData(page, render) {
    const dispose = () => window.removeEventListener('mobile:data', update);
    const update = () => { if (!page.isConnected) dispose(); else render(); };
    window.addEventListener('mobile:data', update);
    page.addEventListener('mobile:resume', render);
    page.addEventListener('mobile:dispose', dispose, {once: true});
  }

  // A browser Forward must never submit a form which already completed a write.
  function finishPage(page, message) {
    page.dataset.completed = 'true';
    page.querySelectorAll('.m-page-body input,.m-page-body select,.m-page-body textarea,.m-page-body button').forEach(field => { field.disabled = true; });
    const footer = page.querySelector('.m-page-actions');
    if (footer) {
      footer.innerHTML = '<span class="m-muted"></span>' + button('completed-back', '返回上一页', 'm-primary');
      footer.querySelector('span').textContent = message;
      footer.querySelector('button').onclick = () => M.back({force: true});
    }
  }

  async function write(page, action, message, label = '确认保存') {
    if (page && pendingPages.has(page)) return false;
    if (page) pendingPages.add(page);
    try {
      return await M.write(action, message, label);
    } catch (error) {
      showError(page, error);
      return false;
    } finally {
      if (page) pendingPages.delete(page);
    }
  }

  function validate(form) {
    const invalid = [...form.elements].find(field => field.willValidate && !field.validity.valid);
    if (invalid) {
      for (let parent = invalid.parentElement; parent && parent !== form; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') parent.open = true;
      }
      invalid.reportValidity();
      return false;
    }
    return true;
  }

  function taskPayload(task) {
    const result = {};
    for (const key of ['title', 'short_title', 'category', 'date', 'end_date', 'start_time', 'end_time', 'due', 'notes']) {
      result[key] = task[key] || '';
    }
    result.end_date ||= result.date;
    result.deferred = !!task.deferred;
    result.deferred_at = task.deferred_at || '';
    result.previous_schedule = clone(task.previous_schedule || {});
    result.done = !!task.done;
    result.milestones = (task.milestones || []).map(node => ({label: node.label || '', stop_at: node.stop_at, done: !!node.done}));
    if (task.version !== undefined) result.version = task.version;
    return result;
  }

  function conflictNames(task, id) {
    if (!task.start_time || task.done) return [];
    const start = task.date + 'T' + task.start_time;
    const end = task.end_date + 'T' + task.end_time;
    const names = (M.data?.tasks || []).filter(other => String(other.id) !== String(id) && !other.done && other.start_time
      && start < other.end_date + 'T' + other.end_time && end > other.date + 'T' + other.start_time).map(other => other.title);
    for (const course of M.data?.course_dates || []) {
      const times = String(course.time || '').match(/\d{2}:\d{2}/g);
      if (!course.cancelled && times?.length === 2 && start < course.date + 'T' + times[1] && end > course.date + 'T' + times[0]) names.push(course.name);
    }
    return [...new Set(names)];
  }

  function scheduleFields(task) {
    return `<label class="m-field">安排方式<select name="schedule_mode">${option('date', '按日期', !task.start_time)}${option('minute', '精确到分钟', !!task.start_time)}</select></label>
      <div class="m-row"><label class="m-field">开始日期<input name="date" type="date" ${dateAttrs} required value="${esc(task.date)}"></label>
      <label class="m-field">计划完成日期<input name="end_date" type="date" ${dateAttrs} required value="${esc(task.end_date)}"></label></div>
      <div class="m-row" data-minute-fields${task.start_time ? '' : ' hidden'}><label class="m-field">开始时间<input name="start_time" type="time" step="60" value="${esc(task.start_time || '09:00')}"></label>
      <label class="m-field">结束时间<input name="end_time" type="time" step="60" value="${esc(task.end_time || '10:00')}"></label></div>`;
  }

  function bindSchedule(form, update) {
    const mode = () => {
      const minute = form.elements.schedule_mode.value === 'minute';
      form.querySelector('[data-minute-fields]').hidden = !minute;
      for (const name of ['start_time', 'end_time']) {
        form.elements[name].disabled = !minute;
        form.elements[name].required = minute;
      }
      update?.();
    };
    form.elements.schedule_mode.addEventListener('change', mode);
    form.elements.date.addEventListener('change', () => {
      if (!form.elements.end_date.value || form.elements.end_date.value < form.elements.date.value) form.elements.end_date.value = form.elements.date.value;
      update?.();
    });
    mode();
  }

  function readSchedule(form, base) {
    const minute = form.elements.schedule_mode.value === 'minute';
    return {...base, date: form.elements.date.value, end_date: form.elements.end_date.value,
      start_time: minute ? form.elements.start_time.value : '', end_time: minute ? form.elements.end_time.value : ''};
  }

  function validSchedule(form, task, page) {
    if (!validate(form)) return false;
    if (task.end_date < task.date || (task.start_time && task.date + 'T' + task.start_time >= task.end_date + 'T' + task.end_time)) {
      showError(page, new Error('结束时间必须晚于开始时间；按日期安排时可以是同一天。'));
      return false;
    }
    return true;
  }

  function conflictNote(names) {
    return names.length ? `<p class="m-warning" role="status">时间与 ${esc(names.slice(0, 5).join('、'))} 重叠。滑动保存将保留这些安排。</p>` : '';
  }

  M.openTask = function (id, {nodeIndex} = {}) {
    const initial = findTask(id);
    if (!initial) { M.toast('这项任务已不存在，请刷新日程'); return; }
    const page = M.openPage({
      title: initial.title,
      body: '<div data-task-content></div>' + errorBox,
      actions: '',
      onMount(current) {
        const render = () => {
          const task = findTask(id);
          const host = current.querySelector('[data-task-content]');
          const actions = current.querySelector('.m-page-actions');
          current.querySelector('.m-page-head h1')?.replaceChildren(document.createTextNode(task?.title || '任务详情'));
          current.setAttribute('aria-label', task?.title || '任务详情');
          if (actions) actions.innerHTML = task && !M.readonly() ? task.deferred ? button('resume','重新安排','m-primary')+button('edit','编辑任务') : button('toggle', task.done ? '标为未完成' : '标为完成', 'm-primary') + button('edit', '编辑任务') : '';
          if (!task) { host.innerHTML = '<p class="m-empty">这项任务已删除或不再分享。</p>'; return; }
          const ro = M.readonly(), busyOnly = !!M.data.share?.busy_only;
          if (task.deferred) {
            host.innerHTML = `<section class="m-section"><h2>${esc(task.title)}</h2><p>${esc(task.category)} · 暂缓</p>${task.short_title?`<p>简称：${esc(task.short_title)}</p>`:''}<p class="m-prewrap">${esc(task.notes || '无备注')}</p>${DeferredTasks.reference(task)}</section><section class="m-section"><div class="m-inline">${button('copy','复制任务')}${button('delete','删除任务','m-danger')}</div></section>`;
            M.decorate(current); return;
          }
          host.innerHTML = `<section class="m-section" data-category="${esc(task.category)}"><h2>${esc(task.title)}</h2>
            <p>${esc(U.taskWhen(task, true))}${task.start_time ? '' : ' · 按日期'}</p>
            ${busyOnly ? '' : `<p class="m-muted">${esc(task.category)} · ${task.done ? '已完成' : '待完成'}</p>
              ${task.short_title ? `<p>简称：${esc(task.short_title)}</p>` : ''}
              <p>截止：${task.due ? esc(localTime(task.due).replace('T', ' ')) : '未设置'}</p>`}</section>
            ${busyOnly ? '' : `<section class="m-section" id="mobile-task-nodes"><div class="m-inline"><h3>关键节点 · ${(task.milestones || []).length}</h3>
              ${ro ? '' : button('manage-nodes', '管理节点')}</div><div class="m-list">${(task.milestones || []).map((node, index) => `<article class="m-item" data-node-index="${index}"><div><strong>${node.done ? '✓ ' : '◆ '}${esc(node.label || '关键节点')}</strong><p class="m-muted">${esc(localTime(node.stop_at).replace('T', ' '))} · ${node.done ? '已完成' : '未完成'}</p></div>
                ${ro ? '' : `<div class="m-inline"><button type="button" data-toggle-node="${index}">${node.done ? '标为未完成' : '标为完成'}</button><button type="button" data-edit-node="${index}">编辑</button></div>`}</article>`).join('') || '<p class="m-empty">暂未设置节点</p>'}</div></section>
              <section class="m-section"><h3>备注</h3><p class="m-prewrap">${esc(task.notes || '未填写备注')}</p></section>`}
            ${ro ? '' : `<section class="m-section"><div class="m-inline">${button('adjust', '调整时间')}${!task.done?button('defer','暂缓'):''}${button('copy', '复制任务')}${button('delete', '删除任务', 'm-danger')}</div></section>`}`;
          M.decorate(current);
        };
        render();
        watchData(current, render);
        current.addEventListener('click', async event => {
          const target = event.target.closest('button');
          if (!target || M.readonly() || pendingPages.has(current)) return;
          const task = findTask(id);
          if (!task) return;
          const action = target.dataset.action;
          if (action === 'resume') M.resumeDeferred(id);
          else if (action === 'defer') {
            if (await write(current, () => M.api('tasks/'+id,'PUT',{...taskPayload(task),deferred:true}), `暂缓「${task.title}」？原安排将保留作参考。`, '确认暂缓')) {
              await M.back({force:true}); M.toast('任务已暂缓');
            }
          }
          else if (action === 'edit') openTaskEditor(task.date, id, false);
          else if (action === 'copy') openTaskEditor(task.date, id, true);
          else if (action === 'adjust') M.adjustTask(id);
          else if (action === 'manage-nodes') openTaskEditor(task.date, id, false, {showNodes: true});
          else if (target.dataset.editNode !== undefined) openTaskEditor(task.date, id, false, {nodeIndex: Number(target.dataset.editNode)});
          else if (target.dataset.toggleNode !== undefined) {
            const index = Number(target.dataset.toggleNode), node = task.milestones[index];
            if (!node) return;
            const payload = taskPayload(task);
            payload.milestones[index].done = !node.done;
            if (await write(current, () => M.api('tasks/' + id, 'PUT', payload), `将「${node.label || '关键节点'}」标为${node.done ? '未完成' : '完成'}？`, '确认修改')) {
              render(); M.toast(node.done ? '节点已标为未完成' : '节点已完成');
            }
          } else if (action === 'toggle') {
            if (await write(current, () => M.api('tasks/' + id, 'PUT', {...taskPayload(task), done: !task.done}), `将「${task.title}」标为${task.done ? '未完成' : '完成'}？`, '确认修改')) {
              render(); M.toast(task.done ? '已标为未完成' : '任务已完成');
            }
          } else if (action === 'delete') {
            const deleted = taskPayload(task);
            if (await write(current, () => M.api('tasks/' + id, 'DELETE', {version: task.version}), `删除「${task.title}」？`, '确认删除')) {
              M.offerUndo('撤销删除「' + task.title + '」', async () => {
                const restoring = {...deleted}; delete restoring.version;
                const restored = await write(null, () => M.api('tasks', 'POST', restoring), `恢复「${deleted.title}」？`, '确认恢复');
                if (restored) M.toast('任务已恢复');
                return restored;
              });
              await M.back({force: true});
            }
          }
        });
        if (nodeIndex !== undefined) requestAnimationFrame(() => current.querySelector(`[data-node-index="${Number(nodeIndex)}"]`)?.scrollIntoView({block: 'center'}));
      }
    });
    return page;
  };

  function openDraftNode(session, index = null) {
    if (index === null && session.nodes.length >= 50) { M.toast('每个任务最多添加 50 个节点'); return; }
    if (index !== null && !session.nodes[index]) { M.toast('这个节点已不存在'); return; }
    const node = index === null ? {label: '', stop_at: '', done: false} : clone(session.nodes[index]);
    if (!node) return;
    let baseline = '', read = () => node;
    return M.openPage({
      title: index === null ? '添加节点' : '编辑节点',
      body: `<form class="m-form" data-node-form novalidate><p class="m-muted">${esc(session.title())} · 修改暂存在任务草稿中</p>
        <label class="m-field">节点名称（选填）<input name="label" maxlength="80" value="${esc(node.label || '')}" placeholder="如：初稿完成"></label>
        <label class="m-field">节点时间（北京时间）<input name="stop_at" type="datetime-local" ${momentAttrs} required value="${esc(localTime(node.stop_at))}"></label>
        <label class="m-check"><input type="checkbox" name="done"${node.done ? ' checked' : ''}>已完成</label>
        <p class="m-muted">节点时间独立于计划区间；返回任务页滑动保存后才会同步。</p>${errorBox}</form>`,
      actions: `${index === null ? '' : button('remove-node', '从草稿删除', 'm-danger')}${button('apply-node', '应用到任务草稿', 'm-primary')}`,
      dirty: () => JSON.stringify(read()) !== baseline,
      onMount(page) {
        const form = page.querySelector('[data-node-form]');
        read = () => ({label: form.elements.label.value.trim(), stop_at: form.elements.stop_at.value, done: form.elements.done.checked});
        baseline = JSON.stringify(read());
        const apply = async () => {
          if (page.dataset.completed) return;
          if (!validate(form)) return;
          if (index === null) session.nodes.push(read()); else session.nodes[index] = read();
          session.renderNodes();
          baseline = JSON.stringify(read());
          finishPage(page, '节点已应用到任务草稿');
          await M.back({force: true});
        };
        page.querySelector('[data-action="apply-node"]').onclick = apply;
        form.onsubmit = event => { event.preventDefault(); apply(); };
        const remove = page.querySelector('[data-action="remove-node"]');
        if (remove) remove.onclick = async () => { if (page.dataset.completed) return; session.nodes.splice(index, 1); session.renderNodes(); finishPage(page, '节点已从任务草稿删除'); await M.back({force: true}); };
      }
    });
  }

  function openDraftExtra(session, kind) {
    const titles={due:'截止时间',notes:'任务备注',other:'简称与完成状态'};
    const initial={...session.extra};let form;
    const read=()=>kind==='due'?{due:form.elements.due.value}:kind==='notes'?{notes:form.elements.notes.value}:{short_title:form.elements.short_title.value.trim(),done:!session.deferred?.()&&form.elements.done.checked};
    let baseline='';
    return M.openPage({title:titles[kind],body:`<form class="m-form" data-extra-form novalidate><p class="m-muted">${esc(session.title())} · 修改暂存在任务草稿中</p>${kind==='due'?`<label class="m-field">截止时间（选填，北京时间）<input name="due" type="datetime-local" ${momentAttrs} value="${esc(localTime(initial.due))}"></label><p class="m-muted">留空表示没有独立截止。修改计划区间不会移动此时间。</p>`:kind==='notes'?`<label class="m-field">任务备注<textarea name="notes" maxlength="4000" rows="12">${esc(initial.notes)}</textarea></label>`:`<label class="m-field">简称（选填）<input name="short_title" maxlength="40" value="${esc(initial.short_title)}" placeholder="用于节点显示"></label><label class="m-check" ${session.deferred?.()?'hidden':''}><input type="checkbox" name="done" ${initial.done?'checked':''}>任务已完成</label>`}</form>`,actions:button('apply-extra','应用到任务草稿','m-primary'),dirty:()=>!!form&&JSON.stringify(read())!==baseline,onMount(page){form=page.querySelector('form');baseline=JSON.stringify(read());const apply=async()=>{if(page.dataset.completed||!validate(form))return;Object.assign(session.extra,read());baseline=JSON.stringify(read());session.renderNodes();finishPage(page,'已应用到任务草稿');await M.back({force:true});};page.querySelector('[data-action="apply-extra"]').onclick=apply;form.onsubmit=event=>{event.preventDefault();apply();};}});
  }

  function openDraftNodes(session) {
    return M.openPage({title:'任务节点',body:'<p class="m-muted">节点独立于计划区间，修改将在保存任务后同步。</p><div class="m-list" data-node-list></div>',actions:button('add-node','添加节点','m-primary'),onMount(page){const render=()=>{page.querySelector('[data-node-list]').innerHTML=session.nodes.map((node,index)=>`<article class="m-item"><div><strong>${node.done?'✓ ':'◆ '}${esc(node.label||'关键节点')}</strong><p class="m-muted">${esc(localTime(node.stop_at).replace('T',' '))} · ${node.done?'已完成':'未完成'}</p></div><button type="button" data-draft-node="${index}">编辑</button></article>`).join('')||'<p class="m-empty">暂未设置节点</p>';};render();page.addEventListener('mobile:resume',render);page.querySelector('[data-action="add-node"]').onclick=()=>openDraftNode(session);page.querySelector('[data-node-list]').onclick=event=>{const target=event.target.closest('[data-draft-node]');if(target)openDraftNode(session,Number(target.dataset.draftNode));};}});
  }

  function openTaskEditor(date, id = null, copy = false, options = {}) {
    if (!requireWritable()) return;
    const source = id ? findTask(id) : null;
    if (id && !source) { M.toast('这项任务已不存在，请刷新日程'); return; }
    const initial = source ? taskPayload(source) : {
      title: '', short_title: '', category: M.data.categories?.[0]?.name || '', date: date || U.today(),
      end_date: date || U.today(), start_time: '', end_time: '', due: '', notes: '', done: false, milestones: []
    };
    if (options.reschedule) Object.assign(initial,DeferredTasks.blank(initial));
    if (!source && options.deferred) initial.deferred = true;
    if (copy) { delete initial.version; delete initial.deferred_at; initial.done = false; initial.milestones = initial.milestones.map(node => ({...node, done: false})); }
    const editingId = copy ? null : id;
    const session = {nodes: clone(initial.milestones), extra:{due:initial.due,short_title:initial.short_title,notes:initial.notes,done:initial.done},title: () => initial.title || '新建任务', renderNodes() {}};
    let baseline = '', read = () => initial;
    const page = M.openPage({
      title: options.reschedule ? '重新安排任务' : copy ? '复制任务' : editingId ? '编辑任务' : '新建任务',
      body: `<form class="m-form" data-task-form novalidate>
        <section class="m-section"><label class="m-field">任务名称<input name="title" maxlength="120" required value="${esc(initial.title)}" placeholder="想完成什么？"></label>
          <label class="m-field">分类<select name="category" required>${(M.data.categories || []).map(category => option(category.name, category.name, category.name === initial.category)).join('')}</select></label>
          <label class="m-field" ${options.reschedule||initial.done?'hidden':''}>任务状态<select name="deferred">${option('false','正常安排',!initial.deferred)}${option('true','暂缓',!!initial.deferred)}</select></label>
          <div data-schedule-fields>${scheduleFields(initial)}<p class="m-muted">北京时间 · 计划区间与截止时间相互独立</p></div></section>
        ${source?.deferred?DeferredTasks.reference(source)+(options.reschedule&&source.previous_schedule?.date?'<button type="button" data-use-previous>带入原安排</button>':''):''}
        <section class="m-section m-setting-list"><button type="button" class="m-setting-row" data-extra="due"><span>截止时间</span><span class="m-meta" data-due-summary></span><span>›</span></button>
          <button type="button" class="m-setting-row" data-extra="notes"><span>备注</span><span class="m-meta" data-notes-summary></span><span>›</span></button>
          <button type="button" class="m-setting-row" data-extra="other"><span>简称与状态</span><span class="m-meta" data-other-summary></span><span>›</span></button>
          <button type="button" class="m-setting-row" data-manage-draft-nodes><span>关键节点</span><span class="m-meta" data-node-count></span><span>›</span></button></section>
        <div data-task-conflicts></div>${errorBox}</form>`,
      actions: button('save-task', editingId ? '保存任务' : '创建任务', 'm-primary'),
      dirty: () => JSON.stringify(read()) !== baseline,
      onMount(current) {
        const form = current.querySelector('[data-task-form]');
        read = () => {
          const draft = readSchedule(form, initial);
          for (const name of ['title', 'category']) draft[name] = form.elements[name].value;
          Object.assign(draft,session.extra);
          draft.title = draft.title.trim(); draft.short_title = draft.short_title.trim();
          draft.milestones = clone(session.nodes);
          draft.deferred = form.elements.deferred.value === 'true';
          if (draft.deferred) Object.assign(draft,{date:'',end_date:'',start_time:'',end_time:'',due:'',milestones:[],done:false});
          return draft;
        };
        session.deferred = () => form.elements.deferred.value === 'true';
        const conflicts = () => { current.querySelector('[data-task-conflicts]').innerHTML = conflictNote(conflictNames(read(), editingId)); };
        bindSchedule(form, conflicts);
        const syncDeferred = () => {
          const deferred = form.elements.deferred.value === 'true';
          form.querySelector('[data-schedule-fields]').hidden = deferred;
          form.querySelector('[data-schedule-fields]').querySelectorAll('input,select').forEach(field => {field.disabled = deferred;});
          if (!deferred) form.elements.schedule_mode.dispatchEvent(new Event('change'));
          for (const target of current.querySelectorAll('[data-extra="due"],[data-manage-draft-nodes]')) target.hidden = deferred;
          conflicts(); session.renderNodes();
        };
        form.elements.deferred.onchange = syncDeferred;
        syncDeferred();

        session.title = () => form.elements.title.value.trim() || '新建任务';
        session.renderNodes = () => {
          current.querySelector('[data-node-count]').textContent = session.nodes.length+' 个节点';
          current.querySelector('[data-due-summary]').textContent=session.extra.due?localTime(session.extra.due).replace('T',' '):'未设置';
          current.querySelector('[data-notes-summary]').textContent=session.extra.notes?session.extra.notes.length+' 字':'未填写';
          current.querySelector('[data-other-summary]').textContent=(session.extra.short_title||'未设置简称')+' · '+(session.deferred()?'暂缓':session.extra.done?'已完成':'待完成');
        };
        session.renderNodes();
        current.querySelector('[data-use-previous]')?.addEventListener('click', () => {
          const previous = clone(source.previous_schedule);
          for (const name of ['date','end_date','start_time','end_time']) form.elements[name].value = previous[name] || '';
          form.elements.schedule_mode.value = previous.start_time ? 'minute' : 'date';
          session.extra.due = previous.due || ''; session.nodes = previous.milestones || [];
          form.elements.schedule_mode.dispatchEvent(new Event('change')); session.renderNodes();
        });
        baseline = JSON.stringify(read());
        form.addEventListener('input', () => { form.elements.title.setCustomValidity(''); conflicts(); });
        form.addEventListener('change', conflicts);
        current.querySelectorAll('[data-extra]').forEach(target=>{target.onclick=()=>openDraftExtra(session,target.dataset.extra);});
        current.querySelector('[data-manage-draft-nodes]').onclick=()=>openDraftNodes(session);
        const save = async () => {
          if (pendingPages.has(current) || current.dataset.completed) return;
          const draft = read();
          form.elements.title.setCustomValidity(draft.title ? '' : '请填写任务名称');
          if (draft.deferred ? !validate(form) : !validSchedule(form, draft, current)) return;
          const names = conflictNames(draft, editingId);
          const message = draft.deferred ? `${editingId?'保存':'创建'}暂缓任务「${draft.title}」？` : `${editingId ? '保存' : '创建'}「${draft.title}」？\n计划 ${U.taskWhen(draft, true)}\n${draft.due?'截止 '+draft.due.replace('T',' '):'未设置独立截止'} · ${draft.milestones.length} 个节点${names.length ? '\n与 ' + names.slice(0, 5).join('、') + ' 重叠，仍然保存。' : ''}`;
          if (await write(current, () => M.api(editingId ? 'tasks/' + editingId : 'tasks', editingId ? 'PUT' : 'POST', draft), message, editingId ? '保存修改' : '创建任务')) {
            baseline = JSON.stringify(read());
            finishPage(current, editingId ? '任务已保存' : '任务已创建');
            await M.back({force: true});
            if (options.reschedule || source?.deferred && !draft.deferred) M.showScheduled(draft.date);
            M.toast(editingId ? '任务已保存' : '任务已创建');
          }
        };
        current.querySelector('[data-action="save-task"]').onclick = save;
        form.onsubmit = event => { event.preventDefault(); save(); };
        if (options.showNodes) requestAnimationFrame(() => openDraftNodes(session));
        if (options.nodeIndex !== undefined) requestAnimationFrame(() => openDraftNode(session, options.nodeIndex));
      }
    });
    return page;
  }

  M.editTask = (date, id = null, copy = false, options = {}) => openTaskEditor(date, id, copy, options);
  M.resumeDeferred = id => openTaskEditor('', id, false, {reschedule:true});

  M.adjustTask = function (id) {
    if (!requireWritable()) return;
    const task = findTask(id);
    if (!task) { M.toast('这项任务已不存在，请刷新日程'); return; }
    if (task.deferred) return M.resumeDeferred(id);
    const initial = taskPayload(task);
    let baseline = '', read = () => initial;
    return M.openPage({
      title: '调整任务时间',
      body: `<form class="m-form" data-adjust-form novalidate><section class="m-section"><h2>${esc(task.title)}</h2><p class="m-muted">原安排：${esc(U.taskWhen(task, true))}</p>
        <div class="m-inline"><button type="button" data-shift="1">顺延 1 天</button><button type="button" data-shift="7">顺延 1 周</button><button type="button" data-shift-today>移到今天</button></div>
        ${scheduleFields(initial)}<p data-adjust-preview></p></section>
        <section class="m-section"><p>截止：${initial.due ? esc(localTime(initial.due).replace('T', ' ')) : '未设置'}（保持不变）</p><p>全部关键节点保持原时间。</p></section><div data-adjust-conflicts></div>${errorBox}</form>`,
      actions: button('save-adjustment', '保存时间', 'm-primary'),
      dirty: () => JSON.stringify(read()) !== baseline,
      onMount(page) {
        const form = page.querySelector('[data-adjust-form]');
        read = () => readSchedule(form, initial);
        const update = () => {
          page.querySelector('[data-adjust-preview]').textContent = '新安排：' + U.taskWhen(read(), true);
          page.querySelector('[data-adjust-conflicts]').innerHTML = conflictNote(conflictNames(read(), id));
        };
        bindSchedule(form, update); baseline = JSON.stringify(read());
        form.addEventListener('input', update); form.addEventListener('change', update);
        const shift = days => {
          try {
            form.elements.date.value = U.add(form.elements.date.value, days);
            form.elements.end_date.value = U.add(form.elements.end_date.value, days);
            update();
          } catch (error) { showError(page, new Error('请先填写有效日期')); }
        };
        page.querySelectorAll('[data-shift]').forEach(target => { target.onclick = () => shift(Number(target.dataset.shift)); });
        page.querySelector('[data-shift-today]').onclick = () => {
          if (!form.elements.date.value) return;
          shift(Math.round((Date.parse(U.today() + 'T12:00:00+08:00') - Date.parse(form.elements.date.value + 'T12:00:00+08:00')) / 86400000));
        };
        const save = async () => {
          if (pendingPages.has(page) || page.dataset.completed) return;
          const draft = read(); if (!validSchedule(form, draft, page)) return;
          const conflicts = conflictNames(draft, id);
          if (await write(page, () => M.api('tasks/' + id, 'PUT', draft), `将「${task.title}」调整为 ${U.taskWhen(draft, true)}？\n截止和节点保持不变。${conflicts.length ? '\n存在时间重叠，仍然保存。' : ''}`, '保存时间')) {
            baseline = JSON.stringify(read()); finishPage(page, '任务时间已更新'); await M.back({force: true}); M.toast('任务时间已更新');
          }
        };
        page.querySelector('[data-action="save-adjustment"]').onclick = save;
        form.onsubmit = event => { event.preventDefault(); save(); };
      }
    });
  };

  M.openJournal = function (date) {
    if (!U.allowedDate(date)) { M.toast('这一天不在分享范围内'); return; }
    if (M.data.share?.busy_only) { M.toast('当前分享未展示手记'); return; }
    const journal = (M.data.journal || []).find(item => item.date === date);
    if (M.readonly()) return M.openPage({title: date + ' · 手记', body: '<section class="m-section" data-shared-journal></section>', actions: '', onMount(page) {
      const render = () => {
        const permitted = !M.data.share?.busy_only && U.allowedDate(date);
        const current = permitted ? (M.data.journal || []).find(item => item.date === date) : null;
        page.querySelector('[data-shared-journal]').innerHTML = `<p class="m-prewrap">${esc(current?.body || (permitted ? '这一天没有手记或未获准分享' : '这一天的手记已不再分享'))}</p>`;
      };
      render(); watchData(page, render);
    }});
    let baseline = journal?.body || '', read = () => baseline;
    const version = journal?.version || 0;
    return M.openPage({
      title: date + ' · 手记',
      body: `<form class="m-form" data-journal-form novalidate><label class="m-field">记录这一天<textarea name="body" rows="12" maxlength="10000" placeholder="记录进展、想法或明天的安排">${esc(baseline)}</textarea></label>${errorBox}</form>`,
      actions: button('save-journal', '保存手记', 'm-primary'),
      dirty: () => read() !== baseline,
      onMount(page) {
        const form = page.querySelector('[data-journal-form]');
        read = () => form.elements.body.value;
        const save = async () => {
          if (pendingPages.has(page) || page.dataset.completed || !validate(form)) return;
          const body = read();
          const message = baseline.trim() && !body.trim() ? `清空 ${date} 的手记？` : `保存 ${date} 的手记？`;
          if (await write(page, () => M.api('journal', 'PUT', {date, body, version}), message, body.trim() ? '保存手记' : '确认清空')) {
            baseline = read(); finishPage(page, '手记已保存'); await M.back({force: true}); M.toast('手记已保存');
          }
        };
        page.querySelector('[data-action="save-journal"]').onclick = save;
        form.onsubmit = event => { event.preventDefault(); save(); };
      }
    });
  };
})();
