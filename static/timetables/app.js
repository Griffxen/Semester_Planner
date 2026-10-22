/* Course designer: local draft edits are committed together through versioned APIs. */
(function () {
  'use strict';
  const D = window.TimetableDesigner;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const uid = prefix => `${prefix}_${crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)}`;
  const days = ['一', '二', '三', '四', '五', '六', '日'];
  let session, templates = [], accounts = [], plan = null, base = '', personal = false;
  let selectedCourse = '', selectedSlot = '', selectedDay = 1, currentTab = 'courses';
  let formBase = '', periodBase = '', holidayBase = '', permissionBase = '', permissions = null;
  let periodCalendar = '', holidayCalendar = '';
  let busy = false, preview = null, importId = '', nameAction = null, mergeIds = [], toastTimer;
  const mergeSelection = new Set();
  const formValue = form => JSON.stringify([...new FormData(form)]);
  const canEdit = () => !!plan && (personal || (!plan.archived && (!!plan.can_edit || !!plan.can_manage)));
  const canManage = () => !personal && !!plan?.can_manage;
  const slotDirty = () => !$('#slot-form').hidden && !!formBase && formValue($('#slot-form')) !== formBase;
  const periodsDirty = () => !!periodBase && formValue($('#period-form')) !== periodBase;
  const holidaysDirty = () => !!holidayBase && formValue($('#holiday-form')) !== holidayBase;
  const permissionsDirty = () => !!permissionBase && formValue($('#permissions-form')) !== permissionBase;
  const planDirty = () => !!plan && (JSON.stringify(plan) !== base || slotDirty() || periodsDirty() || holidaysDirty());
  const dirty = () => planDirty() || permissionsDirty();
  const draftKey = () => `semester-course-draft:${session?.user?.id || session?.user?.name || 'self'}:${personal ? 'personal' : plan?.template_id}`;
  function notify(message) {
    clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
  }
  function errorAt(error, selector = '#page-error') {
    $(selector).textContent = error.message || String(error);
    if (error.status === 409) { $('#version-warning').hidden = false; $('#latest-link').href = location.href; }
    if (selector === '#page-error') $(selector).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  async function api(path, method = 'GET', data) {
    const response = await fetch(`/api/${path}`, {
      method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(session?.csrf ? { 'X-CSRF-Token': session.csrf } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    let result; try { result = await response.json(); } catch (_) { result = {}; }
    if (!response.ok) {
      if (response.status === 401) { $('#workspace').hidden = true; $('#login').hidden = false; }
      throw Object.assign(Error(result.error || `请求失败（${response.status}）`), { status: response.status, details: result });
    }
    return result;
  }
  function confirm(message, title = '请确认') {
    return new Promise(resolve => {
      const dialog = $('#confirm-dialog'); $('#confirm-heading').textContent = title; $('#confirm-message').textContent = message;
      function finish(value) { dialog.close(); resolve(value); }
      $('#confirm-ok').onclick = () => finish(true); $('#confirm-cancel').onclick = () => finish(false);
      dialog.oncancel = event => { event.preventDefault(); finish(false); };
      dialog.showModal(); $('#confirm-cancel').focus();
    });
  }
  async function leaveDraft() {
    if (!dirty()) return true;
    if (!await confirm('当前有未保存的修改。离开会丢弃此页草稿，是否继续？', '离开课表草稿')) return false;
    clearDraft(); return true;
  }
  function clearDraft() { if (plan) { try { sessionStorage.removeItem(draftKey()); } catch (_) {} } }
  function keepDraft() {
    if (!plan || !canEdit()) return;
    try {
      if (!dirty()) { sessionStorage.removeItem(draftKey()); return; }
      sessionStorage.setItem(draftKey(), JSON.stringify({ plan, base, selectedCourse, selectedSlot, tab: currentTab,
        slot: slotDirty() ? [...new FormData($('#slot-form'))] : null,
        periods: periodsDirty() ? readPeriodRows() : null, holidays: holidaysDirty() ? readHolidayRows() : null, periodCalendar, holidayCalendar,
        permission: permissionsDirty() ? { version: permissions?.version, values: [...new FormData($('#permissions-form'))] } : null }));
    } catch (_) { /* Draft stays in memory if browser storage is unavailable. */ }
  }
  function status() {
    $('#dirty-status').textContent = busy ? '正在保存…' : dirty() ? '有未保存的草稿' : canEdit() ? '已保存' : '只读';
    $('#save').disabled = busy || !canEdit() || !planDirty();
    $('#discard').disabled = busy || !dirty();
    keepDraft();
  }
  async function serial(work) {
    if (busy) return false;
    busy = true; status();
    try { return await work(); } finally { busy = false; status(); }
  }
  function courseById(id) { return plan?.courses.find(course => course.course_id === id); }
  function slotById(id) { return courseById(selectedCourse)?.slots.find(slot => slot.slot_id === id); }
  function normalize(value) {
    return { ...value, courses: (value.courses || []).map(course => ({ ...course, slots: course.slots || [] })), periods: value.periods || [], holidays: value.holidays || [] };
  }
  function setPageQuery() {
    const query = personal ? '?personal=1' : `?template=${encodeURIComponent(plan.template_id)}`;
    history.replaceState(null, '', `/timetables/${query}`);
  }
  function showTab(tab) {
    currentTab = tab; $$('.tab-panel').forEach(panel => { panel.hidden = panel.id !== `panel-${tab}`; });
    $$('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
    if (tab === 'permissions' && canManage() && !permissions) loadPermissions().catch(error => errorAt(error, '#permission-error'));
    status();
  }
  async function loadTemplates(show = true) {
    if (show && !await leaveDraft()) return;
    const data = await api('timetables'); templates = data.templates || []; accounts = data.accounts || accounts;
    $('#create-template').hidden = !session?.user?.admin && !accounts.length;
    renderTemplates();
    if (show) {
      closeEditor(); plan = null; base = ''; permissions = null; permissionBase = ''; periodBase = ''; holidayBase = '';
      $('#designer').hidden = true; $('#template-list').hidden = false;
      $('#nav-templates').classList.add('active'); $('#nav-personal').classList.remove('active');
      history.replaceState(null, '', '/timetables/'); $('#page-error').textContent = '';
    }
  }
  function renderTemplates() {
    $('#template-cards').innerHTML = templates.length ? templates.map(template => {
      const edit = template.can_edit || template.can_manage;
      return `<article class="template-card"><div><span class="badge">${template.archived ? '已归档' : template.can_manage ? '管理员' : edit ? '协作编辑' : '可查看导入'}</span><span class="badge">版本 ${esc(template.version)}</span></div><h2>${esc(template.name)}</h2><p class="muted small">${(template.courses || []).length || template.course_count || 0} 门课程 · ${(template.periods || []).length || template.period_count || 0} 个节次</p><div class="card-actions"><button class="primary" type="button" data-open-template="${esc(template.template_id)}">${edit ? '设计课表' : '查看课表'}</button>${!template.archived ? `<button type="button" data-preview-import="${esc(template.template_id)}">导入／更新</button>` : ''}${template.can_manage ? `<button type="button" data-copy-template="${esc(template.template_id)}">复制</button><button type="button" data-rename-template="${esc(template.template_id)}">重命名</button><button type="button" data-archive-template="${esc(template.template_id)}" ${template.archived ? 'disabled' : ''}>归档</button>` : ''}</div></article>`;
    }).join('') : '<p class="empty">当前没有可用模板。管理员可以新建模板，并单独配置查看导入与协作权限。</p>';
  }
  async function openPlan(id, mine = false, skipLeave = false) {
    if (!skipLeave && !await leaveDraft()) return false;
    const value = await api(mine ? 'course-plan' : `timetables/${encodeURIComponent(id)}`);
    personal = mine; plan = normalize(value); base = JSON.stringify(plan); selectedCourse = ''; selectedSlot = ''; permissions = null;
    permissionBase = ''; periodBase = ''; holidayBase = ''; periodCalendar = ''; holidayCalendar = ''; mergeSelection.clear(); currentTab = 'courses'; closeEditor();
    formBase = ''; $('#slot-form').hidden = true; $('#editor-empty').hidden = false; $('#editor-heading').textContent = '选择一门课程';
    $('#version-warning').hidden = true; $('#page-error').textContent = ''; $('#template-list').hidden = true; $('#designer').hidden = false;
    $('#nav-personal').classList.toggle('active', mine); $('#nav-templates').classList.toggle('active', !mine);
    setPageQuery();
    let saved; try { saved = JSON.parse(sessionStorage.getItem(draftKey()) || 'null'); } catch (_) {}
    renderPlan();
    if (saved?.plan && await confirm('此标签页保留了尚未提交的课表草稿。是否继续编辑草稿？', '恢复草稿')) {
      const latestVersion = plan.version; plan = normalize(saved.plan); base = saved.base || base;
      selectedCourse = saved.selectedCourse || ''; selectedSlot = saved.selectedSlot || ''; periodCalendar = saved.periodCalendar || ''; holidayCalendar = saved.holidayCalendar || ''; renderPlan();
      if (saved.periods) renderPeriods(saved.periods);
      if (saved.holidays) renderHolidays(saved.holidays);
      if (selectedCourse && courseById(selectedCourse)) {
        editSlot(selectedCourse, selectedSlot);
        if (saved.slot) for (const [name, value] of saved.slot) if ($('#slot-form').elements[name]) $('#slot-form').elements[name].value = value;
        timeMode();
      }
      if (latestVersion !== plan.version) { $('#version-warning').hidden = false; $('#latest-link').href = location.href; }
      if (saved.permission && canManage()) {
        await loadPermissions();
        for (const input of $$('#permissions-form input[type=checkbox]')) input.checked = false;
        for (const [name] of saved.permission.values) if ($('#permissions-form').elements[name]) $('#permissions-form').elements[name].checked = true;
        permissions.version = saved.permission.version;
      }
      showTab(saved.tab && (saved.tab !== 'permissions' || canManage()) ? saved.tab : 'courses'); status();
    } else { clearDraft(); }
    return true;
  }
  function renderPlan() {
    $('#plan-kind').textContent = personal ? '个人课程副本' : '课表模板';
    $('#plan-name').textContent = personal ? '我的课程' : plan.name;
    const slots = plan.courses.reduce((n, course) => n + course.slots.length, 0);
    $('#plan-summary').textContent = `${plan.courses.length} 门课程 · ${slots} 个固定时段 · 18 个教学周 · 版本 ${plan.version}${personal ? ' · 来源模板分别更新' : ''}`;
    $('#readonly-warning').hidden = canEdit(); $('#save').hidden = !canEdit(); $('#discard').hidden = !canEdit();
    $('#readonly-warning').textContent = plan.archived ? '此模板已归档，可查阅原内容；已有个人副本继续保留。' : '你可以查看及导入此模板；编辑需要该模板的协作权限。';
    $('#import-template').hidden = personal || !!plan.archived;
    $('[data-tab="permissions"]').hidden = !canManage(); $('[data-tab="sources"]').hidden = !personal;
    $('#add-course').hidden = !canEdit(); $('#merge-courses').hidden = !canEdit();
    renderCourses(); renderWeek(); renderPeriods(); renderHolidays(); renderSources();
    for (const form of [$('#period-form'), $('#holiday-form')]) for (const control of form.elements) control.disabled = !canEdit();
    periodBase = formValue($('#period-form')); holidayBase = formValue($('#holiday-form'));
    showTab(currentTab); status();
  }
  function renderCourses() {
    $('#course-count').textContent = `(${plan.courses.length})`;
    $('#course-list').innerHTML = plan.courses.length ? plan.courses.map(course => `<div class="course-row ${course.course_id === selectedCourse ? 'selected' : ''}">${canEdit() ? `<input type="checkbox" data-merge-select="${esc(course.course_id)}" aria-label="选择合并 ${esc(course.name)}" ${mergeSelection.has(course.course_id) ? 'checked' : ''}>` : ''}<button class="course-select" type="button" data-select-course="${esc(course.course_id)}"><strong class="${course.archived ? 'archived' : ''}">${esc(course.name)}${course.archived ? '（已归档）' : ''}</strong><small>${course.slots.length} 个时段${course.slots.map(slot => ` · 周${days[Number(slot.day) - 1] || '?'}`).join('')}</small></button></div>`).join('') : '<p class="empty">还没有课程，先添加一门课程。</p>';
    const suggestions = D.candidates(plan.courses);
    $('#merge-candidates').innerHTML = canEdit() ? suggestions.map((candidate, index) => `<div class="candidate"><p>发现 ${candidate.course_ids.length} 门同名“${esc(candidate.name)}”</p><button type="button" data-candidate="${index}">确认归为同一门课程</button></div>`).join('') : '';
    $('#merge-courses').disabled = mergeSelection.size < 2;
  }
  function courseHolidays(course, slot) {
    if (!personal) return plan.holidays;
    const calendars = plan.calendars || [];
    const rows = Array.isArray(calendars) ? calendars : Object.values(calendars);
    const source = slot?.calendar_id;
    const calendar = rows.find(item => [item.calendar_id, item.template_id, item.id].includes(source));
    return source ? calendar?.holidays || [] : plan.holidays;
  }
  function renderWeek() {
    if (!plan) return;
    const week = Number($('#preview-week').value || 1), start = session.settings?.start || plan.semester_start || '';
    const items = D.slotsForWeek(plan.courses, week), collisions = D.conflicts(plan.courses, week).filter(item =>
      !D.holidayAt(courseHolidays(item.first.course, item.first.slot), D.dateAtWeek(start, week, item.first.slot.day)).length &&
      !D.holidayAt(courseHolidays(item.second.course, item.second.slot), D.dateAtWeek(start, week, item.second.slot.day)).length);
    const badIds = new Set(collisions.flatMap(item => [item.first.slot.slot_id, item.second.slot.slot_id]));
    const range = items.flatMap(item => D.timeRange(item.slot).map(time => Math.floor(D.minutes(time) / 60))).filter(Number.isFinite);
    const firstHour = Math.min(7, ...range), lastHour = Math.min(23, Math.max(20, ...range));
    const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => firstHour + i);
    const date = D.dateAtWeek(start, week, 1), endDate = D.dateAtWeek(start, week, 7);
    $('#preview-caption').textContent = date ? `${date} 至 ${endDate} · ${week % 2 ? '单周' : '双周'} · ${items.length} 个时段` : `第 ${week} 教学周 · ${week % 2 ? '单周' : '双周'} · ${items.length} 个时段`;
    $('#week-conflicts').hidden = !collisions.length;
    $('#week-conflicts').textContent = collisions.length ? `${collisions.length} 处时间重叠：${collisions.map(item => `${item.first.course.name} / ${item.second.course.name}`).join('；')}。可调整，也可确认后保存。` : '';
    $('#mobile-days').innerHTML = days.map((day, index) => `<button type="button" data-mobile-day="${index + 1}" class="${selectedDay === index + 1 ? 'active' : ''}" aria-pressed="${selectedDay === index + 1}">${day}</button>`).join('');
    let html = `<div class="time-column"><div class="grid-day-head">时间</div>${hours.map(hour => `<div class="grid-hour">${String(hour).padStart(2, '0')}:00</div>`).join('')}</div>`;
    for (let day = 1; day <= 7; day++) {
      const date = D.dateAtWeek(start, week, day), holidays = personal ? [] : D.holidayAt(plan.holidays, date);
      html += `<div class="day-column ${selectedDay === day ? 'mobile-active' : ''}"><div class="grid-day-head ${holidays.length ? 'holiday' : ''}"><strong>星期${days[day - 1]}</strong><small>${esc(holidays.length ? holidays.map(item => item.name).join('、') : date.slice(5))}</small></div>`;
      for (const hour of hours) {
        const matches = items.filter(item => Number(item.slot.day) === day && Math.floor(D.minutes(D.timeRange(item.slot)[0]) / 60) === hour);
        html += `<div class="grid-hour">${canEdit() ? `<button type="button" class="cell-add" data-cell-day="${day}" data-cell-time="${String(hour).padStart(2, '0')}:00" aria-label="星期${days[day - 1]} ${hour}点添加时段">＋</button>` : ''}<div class="slot-stack">${matches.map(({ course, slot }) => {
          const cancelled = D.holidayAt(courseHolidays(course, slot), date).length > 0;
          return `<button type="button" class="slot-card ${course.course_id === selectedCourse ? 'selected' : ''} ${badIds.has(slot.slot_id) ? 'conflict' : ''} ${cancelled ? 'suppressed' : ''}" data-slot="${esc(slot.slot_id)}" data-course="${esc(course.course_id)}" title="${esc(`${course.name} · ${slot.time} · ${D.weekLabel(slot)}${cancelled ? ' · 停课日期' : ''}`)}"><strong>${esc(course.name)}</strong><span>${esc(slot.time)}</span><span>${esc(slot.room || '地点待定')}</span><span>${esc(D.weekLabel(slot))}${cancelled ? ' · 停课' : ''}</span></button>`;
        }).join('')}</div></div>`;
      }
      html += '</div>';
    }
    $('#week-grid').innerHTML = html;
  }
  function closeEditor() {
    $('#editor-panel').classList.remove('mobile-open'); document.body.classList.remove('editor-open');
  }
  async function leaveSlot() {
    if (!slotDirty()) return true;
    return confirm('当前时段表单还未应用到草稿，切换会丢弃表单中的修改。是否继续？', '切换时段');
  }
  function editSlot(courseId, slotId = '', defaults = {}) {
    const course = courseById(courseId); if (!course) return;
    selectedCourse = courseId; selectedSlot = slotId;
    const slot = course.slots.find(item => item.slot_id === slotId), form = $('#slot-form'); form.reset();
    const [start, end] = D.timeRange(slot || {});
    const value = { course_name: course.name, day: slot?.day || defaults.day || selectedDay, start: slot?.start || 1, end: slot?.end || 18,
      weeks: slot?.weeks || 'all', room: slot?.room || '', time_mode: slot?.time_mode || 'clock',
      start_time: start || defaults.time || '08:00', end_time: end || endAfter(defaults.time || '08:00'), period_start: slot?.period_start || '', period_end: slot?.period_end || '' };
    renderPeriodOptions(slot);
    for (const [name, entry] of Object.entries(value)) if (form.elements[name]) form.elements[name].value = entry;
    for (const control of form.elements) control.disabled = !canEdit();
    $('#slot-form').hidden = false; $('#editor-empty').hidden = true; $('#editor-heading').textContent = slot ? '编辑上课时段' : '添加上课时段';
    $('#slot-error').textContent = ''; $('#remove-slot').hidden = !slot || !canEdit(); $('#split-slot').hidden = !slot || course.slots.length < 2 || !canEdit();
    $('#new-slot').hidden = !canEdit(); $('#remove-course').hidden = !canEdit(); $('#apply-slot').hidden = !canEdit();
    timeMode(); formBase = formValue(form); renderCourses(); renderWeek();
    $('#editor-panel').classList.add('mobile-open'); document.body.classList.add('editor-open');
    if (matchMedia('(max-width:760px)').matches) $('#editor-heading').scrollIntoView({ block: 'start' });
    status();
  }
  function endAfter(time) {
    const start = D.minutes(time); if (!Number.isFinite(start)) return '09:40';
    const end = Math.min(start + 100, 23 * 60 + 59);
    return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
  }
  function renderPeriodOptions(slot = {}) {
    const periods = D.periodsForSlot(plan, slot);
    const calendar = calendarRows().find(item => item.calendar_id === slot.calendar_id);
    $('#period-basis').textContent = slot.calendar_id ? `使用来源“${calendar?.name || slot.calendar_id}”的作息` : '使用此课表的作息';
    const html = periods.map(period => `<option value="${esc(period.id)}">${esc(period.label || period.id)} · ${esc(period.start)}–${esc(period.end)}</option>`).join('');
    for (const name of ['period_start', 'period_end']) $('#slot-form').elements[name].innerHTML = '<option value="">选择节次</option>' + html;
  }
  function timeMode() {
    const period = $('#slot-form').elements.time_mode.value === 'period';
    $('#clock-inputs').hidden = period; $('#period-inputs').hidden = !period;
    $('#slot-form').elements.start_time.required = !period; $('#slot-form').elements.end_time.required = !period;
    $('#slot-form').elements.period_start.required = period; $('#slot-form').elements.period_end.required = period;
  }
  async function applySlot(close = true) {
    if (!canEdit() || !selectedCourse) return false;
    const form = $('#slot-form'); if (!form.reportValidity()) return false;
    const data = Object.fromEntries(new FormData(form)), course = courseById(selectedCourse);
    if (!data.course_name.trim()) { errorAt(Error('课程名称不能为空'), '#slot-error'); return false; }
    try {
      const previous = course.slots.find(slot => slot.slot_id === selectedSlot);
      const slot = D.validateSlot({ ...previous, slot_id: previous?.slot_id || uid('slot'), day: Number(data.day), start: Number(data.start), end: Number(data.end),
        weeks: data.weeks, time: `${data.start_time}-${data.end_time}`, room: data.room.trim(), time_mode: data.time_mode,
        period_start: data.time_mode === 'period' ? data.period_start : '', period_end: data.time_mode === 'period' ? data.period_end : '' }, D.periodsForSlot(plan, previous || {}));
      course.name = data.course_name.trim();
      if (previous) course.slots[course.slots.indexOf(previous)] = slot; else course.slots.push(slot);
      selectedSlot = slot.slot_id; $('#slot-error').textContent = ''; formBase = formValue(form);
      renderCourses(); renderWeek(); status(); if (close) { closeEditor(); notify('时段已应用到草稿，请保存课表'); }
      return true;
    } catch (error) { errorAt(error, '#slot-error'); return false; }
  }
  function openName(title, initial, action) {
    nameAction = action; $('#name-heading').textContent = title; $('#name-form').elements.name.value = initial || ''; $('#name-error').textContent = '';
    $('#name-dialog').showModal(); $('#name-form').elements.name.focus();
  }
  async function newCourse(defaults = {}) {
    if (!canEdit() || !await leaveSlot()) return;
    openName('新建课程', '', async name => {
      const course = { course_id: uid('course'), name, slots: [] }; plan.courses.push(course); renderCourses();
      editSlot(course.course_id, '', defaults); status();
    });
  }
  function calendarRows() { return Array.isArray(plan?.calendars) ? plan.calendars : Object.values(plan?.calendars || {}); }
  function calendarConfig(id) { return id ? calendarRows().find(item => String(item.calendar_id) === String(id)) || plan : plan; }
  function renderCalendarOptions(kind, current) {
    $(`#${kind}-calendar-label`).hidden = !personal;
    $(`#${kind}-calendar`).innerHTML = `<option value="">个人新增课程</option>${calendarRows().map(calendar => `<option value="${esc(calendar.calendar_id)}">${esc(calendar.name || calendar.calendar_id)}</option>`).join('')}`;
    $(`#${kind}-calendar`).value = current;
  }
  function renderPeriods(rows) {
    const baseline = rows === undefined;
    if (baseline) { rows = calendarConfig(periodCalendar).periods || []; renderCalendarOptions('period', periodCalendar); }
    $('#period-rows').innerHTML = rows.map(periodRow).join('') || '<p class="empty">尚未设置节次，可以直接填写上课时刻。</p>';
    if (baseline) periodBase = formValue($('#period-form'));
  }
  function periodRow(period) {
    return `<div class="period-row"><label>编号<input name="period-id" value="${esc(period.id)}" maxlength="32" required></label><label>节次名称<input name="period-label" value="${esc(period.label || '')}" maxlength="40" required></label><label>开始<input name="period-start" type="time" value="${esc(period.start)}" required></label><label>结束<input name="period-end" type="time" value="${esc(period.end)}" required></label><button type="button" data-remove-period>删除</button></div>`;
  }
  function readPeriodRows() {
    return $$('#period-rows .period-row').map(row => ({ id: row.querySelector('[name=period-id]').value.trim(), label: row.querySelector('[name=period-label]').value.trim(), start: row.querySelector('[name=period-start]').value, end: row.querySelector('[name=period-end]').value }));
  }
  async function applyPeriods() {
    if (!canEdit() || !$('#period-form').reportValidity()) return false;
    try {
      const rows = readPeriodRows(), result = D.updatePeriods(plan, rows, periodCalendar);
      if (result.affected.length && !await confirm(`${result.affected.map(item => `${item.course}：${item.before} → ${item.after}`).join('\n')}\n\n以上节次课程将一起更新时间，是否应用？`, '作息变更影响课程')) return false;
      plan = result.plan; $('#period-error').textContent = ''; periodBase = formValue($('#period-form'));
      if (!slotDirty() && selectedCourse) editSlot(selectedCourse, selectedSlot);
      renderWeek(); status(); return true;
    } catch (error) { errorAt(error, '#period-error'); return false; }
  }
  function holidayRow(holiday) {
    return `<div class="holiday-row"><label>停课原因<input name="holiday-name" maxlength="60" value="${esc(holiday.name)}" required></label><label>开始日期<input name="holiday-start" type="date" value="${esc(holiday.start)}" required></label><label>结束日期<input name="holiday-end" type="date" value="${esc(holiday.end)}" required></label><button type="button" data-remove-holiday>删除</button></div>`;
  }
  function renderHolidays(rows) {
    const baseline = rows === undefined;
    if (baseline) { rows = calendarConfig(holidayCalendar).holidays || []; renderCalendarOptions('holiday', holidayCalendar); }
    $('#holiday-rows').innerHTML = rows.map(holidayRow).join('') || '<p class="empty">尚未设置停课日期。</p>';
    $('#holiday-caption').textContent = personal ? '这里设置个人课程的停课日期。导入模板的停课规则保存在各自来源中，更新时分别预览。' : '普通周课在这些日期停课，显式调课与补课经确认仍可安排。';
    if (baseline) holidayBase = formValue($('#holiday-form'));
  }
  function readHolidayRows() {
    return $$('#holiday-rows .holiday-row').map(row => ({ name: row.querySelector('[name=holiday-name]').value.trim(), start: row.querySelector('[name=holiday-start]').value, end: row.querySelector('[name=holiday-end]').value }));
  }
  function applyHolidays() {
    if (!canEdit() || !$('#holiday-form').reportValidity()) return false;
    try {
      const rows = readHolidayRows();
      for (const row of rows) if (!row.name || !row.start || !row.end || row.start > row.end) throw Error('停课原因和起止日期不能为空，结束日期不能早于开始日期');
      calendarConfig(holidayCalendar).holidays = rows; holidayBase = formValue($('#holiday-form')); $('#holiday-error').textContent = ''; renderWeek(); status(); return true;
    } catch (error) { errorAt(error, '#holiday-error'); return false; }
  }
  function renderSources() {
    if (!personal) return;
    const sources = Array.isArray(plan.sources) ? plan.sources : Object.entries(plan.sources || {}).map(([template_id, source]) => ({ template_id, ...source }));
    $('#source-list').innerHTML = sources.length ? sources.map(source => `<div class="source-item"><div><strong>${esc(source.name || source.template_name || source.template_id)}</strong><small>已导入版本 ${esc(source.version || source.template_version || source.imported_version || '?')}${source.unavailable || source.revoked || source.archived || source.available === false ? ' · 来源已不可用，保留个人副本' : ''}</small></div>${source.unavailable || source.revoked || source.archived || source.available === false ? '' : `<button type="button" data-preview-import="${esc(source.template_id)}">预览更新</button>`}</div>`).join('') : '<p class="empty">尚未导入模板，个人新增课程会独立保存。</p>';
  }
  async function savePlan() {
    if (!canEdit()) return false;
    if ((slotDirty() || (selectedCourse && !courseById(selectedCourse)?.slots.length)) && !await applySlot(false)) { showTab('courses'); return false; }
    if (periodsDirty() && !await applyPeriods()) { showTab('periods'); return false; }
    if (holidaysDirty() && !applyHolidays()) { showTab('holidays'); return false; }
    const collisions = D.allConflicts(plan.courses);
    if (collisions.length && !await confirm(`${collisions.map(item => `${item.first.course.name} / ${item.second.course.name}：第 ${item.weeks.join('、')} 周`).join('\n')}\n\n仍然保存这份课表？`, '课表存在时间重叠')) return false;
    return serial(async () => {
      try {
        const result = await api(personal ? 'course-plan' : `timetables/${encodeURIComponent(plan.template_id)}`, 'PUT', { ...plan, version: plan.version });
        clearDraft(); plan = normalize(result); base = JSON.stringify(plan); $('#version-warning').hidden = true; $('#page-error').textContent = '';
        if (permissions) permissions.version = plan.version;
        renderPlan(); if (selectedCourse && courseById(selectedCourse)) editSlot(selectedCourse, selectedSlot); closeEditor();
        notify('课表已保存'); return true;
      } catch (error) { errorAt(error); return false; }
    });
  }
  function openMerge(ids) {
    if (!canEdit()) return;
    mergeIds = ids.filter(id => !!courseById(id)); if (mergeIds.length < 2) return;
    $('#merge-caption').textContent = `将以下 ${mergeIds.length} 门课程合为一门：${mergeIds.map(id => courseById(id).name).join('、')}`;
    $('#merge-form').elements.target.innerHTML = mergeIds.map(id => `<option value="${esc(id)}">${esc(courseById(id).name)} · ${courseById(id).slots.length} 个时段</option>`).join('');
    $('#merge-form').elements.name.value = courseById(mergeIds[0]).name; $('#merge-dialog').showModal();
  }
  async function loadPermissions() {
    if (!canManage()) return;
    const templateId = plan.template_id, result = await api(`timetables/${encodeURIComponent(templateId)}/permissions`);
    if (personal || plan?.template_id !== templateId) return;
    permissions = result;
    $('#permissions-form').elements.public.checked = !!permissions.public;
    $('#permission-rows').innerHTML = accounts.filter(account => !account.admin).map(account => {
      const user = (permissions.users || []).find(item => String(item.user_id) === String(account.id));
      return `<div class="permission-row" data-user="${esc(account.id)}"><span>${esc(account.name)}</span><label class="check"><input type="checkbox" name="use-${esc(account.id)}" data-use ${user?.use || user?.edit ? 'checked' : ''}>查看导入</label><label class="check"><input type="checkbox" name="edit-${esc(account.id)}" data-edit ${user?.edit ? 'checked' : ''}>协作编辑</label></div>`;
    }).join('') || '<p class="empty">当前没有可单独授权的普通账户。</p>';
    permissionBase = formValue($('#permissions-form')); status();
  }
  async function savePermissions(event) {
    event.preventDefault(); if (!canManage() || busy) return;
    if (planDirty()) {
      if (!await confirm('先保存课程、作息与停课草稿，再保存此模板权限，是否继续？', '保存课表与权限')) return;
      if (!await savePlan()) return;
    }
    await serial(async () => {
      try {
        const users = $$('#permission-rows .permission-row').map(row => ({ user_id: /^\d+$/.test(row.dataset.user) ? Number(row.dataset.user) : row.dataset.user, use: row.querySelector('[data-use]').checked || row.querySelector('[data-edit]').checked, edit: row.querySelector('[data-edit]').checked }));
        const result = await api(`timetables/${encodeURIComponent(plan.template_id)}/permissions`, 'PUT', { version: permissions?.version ?? plan.version, public: $('#permissions-form').elements.public.checked, users });
        permissions = result; plan.version = result.version; base = JSON.stringify(plan); permissionBase = formValue($('#permissions-form'));
        $('#permission-error').textContent = ''; notify('此模板的权限已保存');
      } catch (error) { errorAt(error, '#permission-error'); }
    });
  }
  function summarize(value) {
    if (value == null) return '无';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value, null, 2);
  }
  async function showImport(id) {
    if (busy) return;
    if (dirty()) { errorAt(Error('请先保存或放弃当前课表草稿，再预览导入，避免草稿与导入结果相互覆盖。')); return; }
    try {
      importId = id; preview = await api(`timetables/${encodeURIComponent(id)}/import-preview`, 'POST', {});
      const template = templates.find(item => item.template_id === id);
      $('#import-caption').textContent = `${template?.name || plan?.name || '课表模板'} · 源版本 ${preview.template_version} → 我的课表版本 ${preview.plan_version}。个人修改默认保留，其他来源内容独立保存。`;
      $('#import-changes').innerHTML = (preview.changes || []).length ? `<p class="import-section-title">源课表变更</p>${preview.changes.map(change => `<div class="import-change"><strong>${esc(({ added: '新增', changed: '修改', removed: '移除' })[change.kind] || change.kind)} · ${esc(change.label || change.key)}</strong><details><summary>查看变更内容</summary><pre>原内容：${esc(summarize(change.before))}\n新内容：${esc(summarize(change.after))}</pre></details></div>`).join('')}` : '<p class="empty">源课表没有新增变更。确认导入不会产生重复课程。</p>';
      $('#import-conflicts').innerHTML = (preview.conflicts || []).length ? `<p class="import-section-title">个人修改冲突（默认保留）</p>${preview.conflicts.map(conflict => `<div class="import-conflict"><label class="check"><input type="checkbox" data-overwrite="${esc(conflict.key)}">用源内容覆盖：${esc(conflict.label || conflict.key)}</label><details><summary>比较个人内容与源内容</summary><pre>个人：${esc(summarize(conflict.personal))}\n来源：${esc(summarize(conflict.incoming))}</pre></details></div>`).join('')}` : '';
      const protectedRows = preview.protected_occurrences || [];
      $('#import-protected').innerHTML = protectedRows.length ? `<p class="import-section-title">保留已有个人记录</p><p class="muted">${protectedRows.length} 个已有备注、作业或临时调整的课次会保留身份和原始安排，可继续查阅。</p>` : '';
      $('#import-error').textContent = ''; $('#confirm-import').disabled = false; $('#import-dialog').showModal();
    } catch (error) { errorAt(error); }
  }
  async function commitImport() {
    if (!preview || busy) return;
    await serial(async () => {
      $('#confirm-import').disabled = true;
      try {
        await api(`timetables/${encodeURIComponent(importId)}/import`, 'POST', { template_version: preview.template_version, plan_version: preview.plan_version, overwrite: $$('#import-conflicts [data-overwrite]:checked').map(input => input.dataset.overwrite) });
        $('#import-dialog').close(); preview = null;
        await openPlan('', true, true); notify('已更新我的课程，未选择覆盖的个人修改已保留');
      } catch (error) { errorAt(error, '#import-error'); if (error.status === 409 || error.status === 403) $('#confirm-import').disabled = true; else $('#confirm-import').disabled = false; }
    });
  }
  async function templateAction(kind, id) {
    const template = templates.find(item => item.template_id === id); if (!template?.can_manage) return;
    if (kind === 'archive') {
      if (!await confirm(`归档“${template.name}”后将停止读取、导入与更新，已有个人副本保留。确认归档？`, '归档模板')) return;
      await api(`timetables/${encodeURIComponent(id)}/archive`, 'POST', { version: template.version }); await loadTemplates(false); notify('模板已归档'); return;
    }
    openName(kind === 'copy' ? '复制模板' : '重命名模板', kind === 'copy' ? `${template.name}（副本）` : template.name, async name => {
      if (kind === 'copy') {
        const result = await api(`timetables/${encodeURIComponent(id)}/copy`, 'POST', { name, version: template.version }); await loadTemplates(false); await openPlan(result.template_id, false, true);
      } else {
        const latest = await api(`timetables/${encodeURIComponent(id)}`);
        await api(`timetables/${encodeURIComponent(id)}`, 'PUT', { ...latest, name, version: template.version }); await loadTemplates(false);
      }
    });
  }
  function downloadDraft() {
    const snapshot = { type: 'course-plan-draft', savedAt: new Date().toISOString(), personal, plan,
      editor: slotDirty() ? Object.fromEntries(new FormData($('#slot-form'))) : null, periods: readPeriodRows(), holidays: readHolidayRows() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `课表草稿-${personal ? '我的课程' : plan.template_id}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function bind() {
    $('#preview-week').innerHTML = Array.from({ length: 18 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    if (session.settings?.start) {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const week = Math.floor((new Date(`${today}T12:00:00Z`) - new Date(`${session.settings.start}T12:00:00Z`)) / 604800000) + 1;
      $('#preview-week').value = String(Math.min(18, Math.max(1, week)));
      selectedDay = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7 + 1;
    }
    $('#nav-personal').onclick = () => openPlan('', true).catch(error => errorAt(error));
    $('#nav-templates').onclick = () => loadTemplates().catch(error => errorAt(error));
    $('#browse-sources').onclick = () => loadTemplates().catch(error => errorAt(error));
    $('#preview-week').onchange = renderWeek;
    $('#mobile-days').onclick = event => { const target = event.target.closest('[data-mobile-day]'); if (target) { selectedDay = Number(target.dataset.mobileDay); renderWeek(); } };
    $$('[data-tab]').forEach(button => { button.onclick = () => showTab(button.dataset.tab); });
    $('#save').onclick = () => savePlan().catch(error => errorAt(error));
    $('#discard').onclick = async () => { if (await confirm('放弃尚未保存的课表、表单和权限修改？', '放弃草稿')) { clearDraft(); plan = JSON.parse(base); await openPlan(plan.template_id, personal, true); } };
    $('#download-draft').onclick = downloadDraft;
    $('#add-course').onclick = () => newCourse().catch(error => errorAt(error));
    $('#course-list').onchange = event => { const input = event.target.closest('[data-merge-select]'); if (!input) return; if (input.checked) mergeSelection.add(input.dataset.mergeSelect); else mergeSelection.delete(input.dataset.mergeSelect); $('#merge-courses').disabled = mergeSelection.size < 2; };
    $('#course-list').onclick = async event => { const button = event.target.closest('[data-select-course]'); if (!button || !await leaveSlot()) return; const course = courseById(button.dataset.selectCourse); editSlot(course.course_id, course.slots[0]?.slot_id || ''); };
    $('#week-grid').onclick = async event => {
      const slot = event.target.closest('[data-slot]'), cell = event.target.closest('[data-cell-day]');
      if (slot) { if (await leaveSlot()) editSlot(slot.dataset.course, slot.dataset.slot); }
      else if (cell && canEdit()) {
        if (selectedCourse && courseById(selectedCourse)) { if (await leaveSlot()) editSlot(selectedCourse, '', { day: Number(cell.dataset.cellDay), time: cell.dataset.cellTime }); }
        else await newCourse({ day: Number(cell.dataset.cellDay), time: cell.dataset.cellTime });
      }
    };
    $('#slot-form').onsubmit = async event => { event.preventDefault(); await applySlot(); };
    $('#slot-form').elements.time_mode.onchange = timeMode;
    $('#close-editor').onclick = closeEditor;
    $('#new-slot').onclick = async () => { if (await leaveSlot()) editSlot(selectedCourse); };
    $('#remove-slot').onclick = async () => {
      if (!canEdit() || !selectedSlot || !await confirm('删除此固定时段？已有备注、作业和临时调整会由系统保留，停止生成新的普通课次。', '删除时段')) return;
      const course = courseById(selectedCourse); course.slots = course.slots.filter(slot => slot.slot_id !== selectedSlot); selectedSlot = ''; formBase = ''; $('#slot-form').hidden = true; $('#editor-empty').hidden = false;
      renderCourses(); renderWeek(); closeEditor(); status();
    };
    $('#remove-course').onclick = async () => {
      const course = courseById(selectedCourse); if (!canEdit() || !course || !await confirm(`删除“${course.name}”的全部固定时段？已有个人课次记录会保留。`, '删除课程')) return;
      plan.courses = plan.courses.filter(item => item.course_id !== course.course_id); mergeSelection.delete(course.course_id); selectedCourse = ''; selectedSlot = ''; formBase = ''; $('#slot-form').hidden = true; $('#editor-empty').hidden = false;
      closeEditor(); renderCourses(); renderWeek(); status();
    };
    $('#split-slot').onclick = async () => {
      if (!canEdit() || !selectedSlot || !await leaveSlot()) return;
      openName('拆分为新课程', courseById(selectedCourse).name, async name => { const id = uid('course'); plan = D.splitSlot(plan, selectedCourse, selectedSlot, id, name); editSlot(id, selectedSlot); status(); });
    };
    $('#merge-courses').onclick = async () => { if (await leaveSlot()) openMerge([...mergeSelection]); };
    $('#merge-candidates').onclick = async event => { const target = event.target.closest('[data-candidate]'); if (target && await leaveSlot()) openMerge(D.candidates(plan.courses)[Number(target.dataset.candidate)].course_ids); };
    $('#merge-form').elements.target.onchange = () => { $('#merge-form').elements.name.value = courseById($('#merge-form').elements.target.value).name; };
    $('#merge-form').onsubmit = event => {
      event.preventDefault(); const id = event.target.elements.target.value, name = event.target.elements.name.value.trim(); if (!name) return;
      plan = D.mergeCourses(plan, mergeIds, id); courseById(id).name = name; mergeSelection.clear(); $('#merge-dialog').close(); editSlot(id, courseById(id).slots[0]?.slot_id || ''); status();
    };
    $('#period-form').onsubmit = async event => { event.preventDefault(); if (await applyPeriods()) notify('作息已应用到草稿，请保存课表'); };
    $('#period-calendar').onchange = async () => {
      const next = $('#period-calendar').value; $('#period-calendar').value = periodCalendar;
      if (periodsDirty() && !await confirm('当前作息表单未应用，切换来源会丢弃此表单修改。是否继续？', '切换作息来源')) return;
      periodCalendar = next; renderPeriods(); status();
    };
    $('#add-period').onclick = () => {
      $('#period-rows .empty')?.remove(); const rows = readPeriodRows(); let id = rows.length + 1; while (rows.some(row => String(row.id) === String(id))) id++;
      $('#period-rows').insertAdjacentHTML('beforeend', periodRow({ id: String(id), label: `第 ${id} 节`, start: rows.at(-1)?.end || '08:00', end: endAfter(rows.at(-1)?.end || '08:00') })); status();
    };
    $('#period-rows').onclick = event => {
      const button = event.target.closest('[data-remove-period]'); if (!button) return;
      const row = button.closest('.period-row'), id = row.querySelector('[name=period-id]').value;
      const oldRows = calendarConfig(periodCalendar).periods || [], removedIndex = oldRows.findIndex(period => String(period.id) === id);
      const referenced = plan.courses.some(course => course.slots.some(slot => {
        if (slot.time_mode !== 'period' || String(slot.calendar_id || '') !== periodCalendar) return false;
        const first = oldRows.findIndex(period => String(period.id) === String(slot.period_start)), last = oldRows.findIndex(period => String(period.id) === String(slot.period_end));
        return removedIndex >= first && removedIndex <= last && first >= 0;
      }));
      if (referenced) { errorAt(Error('此节次仍被课程引用，请先修改对应课程的节次或时间输入方式。'), '#period-error'); return; }
      row.remove(); status();
    };
    $('#holiday-form').onsubmit = event => { event.preventDefault(); if (applyHolidays()) notify('停课日期已应用到草稿，请保存课表'); };
    $('#holiday-calendar').onchange = async () => {
      const next = $('#holiday-calendar').value; $('#holiday-calendar').value = holidayCalendar;
      if (holidaysDirty() && !await confirm('当前停课表单未应用，切换来源会丢弃此表单修改。是否继续？', '切换停课来源')) return;
      holidayCalendar = next; renderHolidays(); status();
    };
    $('#add-holiday').onclick = () => { $('#holiday-rows .empty')?.remove(); $('#holiday-rows').insertAdjacentHTML('beforeend', holidayRow({ name: '', start: '', end: '' })); status(); };
    $('#holiday-rows').onclick = event => { const target = event.target.closest('[data-remove-holiday]'); if (target) { target.closest('.holiday-row').remove(); status(); } };
    $('#permissions-form').onsubmit = savePermissions;
    $('#permission-rows').onchange = event => { const row = event.target.closest('[data-user]'); if (!row) return; if (event.target.hasAttribute('data-edit') && event.target.checked) row.querySelector('[data-use]').checked = true; if (event.target.hasAttribute('data-use') && !event.target.checked) row.querySelector('[data-edit]').checked = false; status(); };
    $('#name-form').onsubmit = async event => {
      event.preventDefault(); const value = event.target.elements.name.value.trim(); if (!value || busy) return;
      try { const action = nameAction; $('#name-dialog').close(); await action(value); } catch (error) { if (!$('#name-dialog').open) $('#name-dialog').showModal(); errorAt(error, '#name-error'); }
    };
    $('#create-template').onclick = () => openName('新建课表模板', '', async name => { const result = await api('timetables', 'POST', { name, courses: [], periods: [], holidays: [] }); await loadTemplates(false); await openPlan(result.template_id, false, true); });
    $('#template-cards').onclick = async event => {
      const button = event.target.closest('button'); if (!button) return;
      try {
        if (button.dataset.openTemplate) await openPlan(button.dataset.openTemplate);
        else if (button.dataset.previewImport) await showImport(button.dataset.previewImport);
        else if (button.dataset.copyTemplate) await templateAction('copy', button.dataset.copyTemplate);
        else if (button.dataset.renameTemplate) await templateAction('rename', button.dataset.renameTemplate);
        else if (button.dataset.archiveTemplate) await templateAction('archive', button.dataset.archiveTemplate);
      } catch (error) { errorAt(error); }
    };
    $('#source-list').onclick = event => { const target = event.target.closest('[data-preview-import]'); if (target) showImport(target.dataset.previewImport); };
    $('#import-template').onclick = () => showImport(plan.template_id);
    $('#confirm-import').onclick = commitImport;
    $$('[data-close-dialog]').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
    for (const form of [$('#slot-form'), $('#period-form'), $('#holiday-form'), $('#permissions-form')]) { form.addEventListener('input', status); form.addEventListener('change', status); }
    $('#theme-toggle').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; try { localStorage.setItem('semester-theme', theme); } catch (_) {} };
    window.addEventListener('beforeunload', event => { if (dirty() || busy) { keepDraft(); event.preventDefault(); event.returnValue = ''; } });
    document.addEventListener('click', async event => {
      const link = event.target.closest('a[href]'); if (!link || link.target === '_blank' || !dirty() || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); if (await leaveDraft()) { base = JSON.stringify(plan); formBase = formValue($('#slot-form')); periodBase = formValue($('#period-form')); holidayBase = formValue($('#holiday-form')); permissionBase = formValue($('#permissions-form')); location.href = link.href; }
    });
  }
  async function init() {
    try {
      session = await api('state');
      if (session.readonly) { $('#loading').textContent = '展示账户只能查看已授权的个人日程。请返回看板。'; return; }
      bind(); await loadTemplates(false); $('#loading').hidden = true; $('#workspace').hidden = false;
      const query = new URLSearchParams(location.search);
      if (query.get('personal') === '1') await openPlan('', true, true);
      else if (query.get('template')) await openPlan(query.get('template'), false, true);
      else { $('#template-list').hidden = false; $('#nav-templates').classList.add('active'); }
    } catch (error) { $('#loading').hidden = true; if (error.status !== 401) errorAt(error); }
  }
  init();
})();
