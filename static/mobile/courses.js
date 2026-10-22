/* Personal course occurrences keep their original identity across schedule changes. */
(() => {
  'use strict';
  const M = window.Mobile;
  const {esc, today, formatDate} = M.utils;
  const days = ['', '一', '二', '三', '四', '五', '六', '日'];
  const empty = text => `<p class="m-empty">${esc(text)}</p>`;
  const dateLabel = date => formatDate ? formatDate(date) : date;
  const rule = course => `周${days[Number(course.day)] || course.day} · ${course.weeks === 'odd' ? '单周' : course.weeks === 'even' ? '双周' : '每周'} · 第 ${course.start || 1}–${course.end || 18} 周`;
  const series = key => (M.data.timetable || []).find(course => course.course_id === key);
  const groups = () => Array.isArray(M.data.course_plan?.courses) ? M.data.course_plan.courses : (M.data.timetable || []).map(slot => ({course_id: slot.logical_course_id || slot.course_id, name: slot.name, slots: [{...slot, slot_id: slot.course_id}]}));
  const identity = course => ({...(course.occurrence_id ? {occurrence_id: course.occurrence_id} : {}), course_key: course.course_key, date: course.original_date});
  const status = course => course.cancelled ? (course.kind === 'makeup' ? '补课已取消，原课仍停课' : course.kind === 'extra' ? '额外加课已取消' : course.holiday ? '停课日期' : '已取消') : course.kind === 'makeup' ? '补课' : course.kind === 'extra' ? '额外加课' : course.adjusted ? '已调课' : '按原课表上课';
  const holidayNames = (date, row) => {
    const plan = M.data.course_plan;
    if (!plan) return [...new Set((M.data.holidays || []).filter(item => item.start <= date && date <= item.end).map(item => item.name || '停课日期'))];
    const course = groups().find(item => item.course_id === row?.course_id), slot = groups().flatMap(item => item.slots || []).find(item => item.slot_id === (row?.slot_id || row?.course_key)) || (!row?.slot_id ? course?.slots?.[0] : null);
    const calendar = (plan.calendars || []).find(item => item.calendar_id === slot?.calendar_id), rules = calendar?.holidays || row?.source_holidays || plan.holidays || [];
    return [...new Set(rules.filter(item => item.start <= date && date <= item.end).map(item => item.name || '停课日期'))];
  };
  async function saveSchedule(path, method, payload) {
    try { return await M.api(path, method, payload); }
    catch (error) {
      if (!payload.allow_holiday && (/holiday/i.test(error.code || '') || /节假日|停课日期/.test(error.message)) && await M.confirm(error.message + ' 确定仍在这一天上课？', '确认停课日期上课')) return M.api(path, method, {...payload, allow_holiday: true});
      throw error;
    }
  }
  function conflictNames(date, time, ignoreId) {
    const [start, end] = time.match(/\d{2}:\d{2}/g) || [];
    const names = (M.data.course_dates || []).filter(row => {
      const [a, b] = (row.time || '').match(/\d{2}:\d{2}/g) || [];
      return !row.cancelled && row.date === date && row.occurrence_id !== ignoreId && start < b && end > a;
    }).map(row => row.name);
    for (const task of M.data.tasks || []) if (!task.done && task.start_time && date + 'T' + start < task.end_date + 'T' + task.end_time && date + 'T' + end > task.date + 'T' + task.start_time) names.push(task.title);
    return [...new Set(names)];
  }
  const changeFor = (key, date) => (M.data.course_exceptions || []).find(change => change.course_key === key && change.date === date);
  function occurrence(key, date) {
    const row = (M.data.course_dates || []).find(course => course.course_key === key && course.original_date === date);
    if (row) return row;
    const course = series(key), change = changeFor(key, date);
    if (!course || !change) return null;
    return {...course, course_id: groups().find(group => group.slots.some(slot => slot.slot_id === key))?.course_id || key, course_key: key, original_date: date, original_time: change.original_time || course.time,
      date: change.new_date || date, time: change.new_time || course.time,
      cancelled: !!change.cancelled, adjusted: true};
  }
  function annotation(course) {
    return {notes: course.notes || '', homework_required: !!course.homework_required,
      homework_notes: course.homework_notes || '', homework_done: !!course.homework_required && !!course.homework_done};
  }
  function watchData(page, render) {
    const listener = () => {
      if (!page.isConnected) window.removeEventListener('mobile:data', listener);
      else render();
    };
    window.addEventListener('mobile:data', listener);
  }
  async function write(page, action, message, label) {
    try { return await M.write(action, message, label); }
    catch (error) { M.error(page, error); return false; }
  }
  function courseSummary(course) {
    return `<p class="m-meta">${esc(dateLabel(course.date))} · ${esc(course.time || '')}${course.room ? ' · ' + esc(course.room) : ''}</p>
      <p class="m-meta">${esc(status(course))}${course.archived ? ' · 原始安排已归档，个人记录仍保留' : ''}</p>
      ${course.adjusted ? `<p class="m-meta">原安排：${esc(dateLabel(course.original_date))} · ${esc(course.original_time || '')}</p>` : ''}`;
  }
  async function restore(page, key, date) {
    if (M.readonly()) return false;
    const course = occurrence(key, date); if (!course) return false;
    const extra = course.kind === 'extra', special = ['extra', 'makeup'].includes(course.kind), holidays = extra ? holidayNames(course.date, course) : [];
    const saved = await write(page, () => special ? saveSchedule('course-makeups/' + encodeURIComponent(course.occurrence_id), 'PUT', {action: 'restore', allow_holiday: !!holidays.length}) : M.api('course-exceptions', 'PUT', {...identity(course), cancelled: false, new_date: '', new_time: ''}),
      extra ? `恢复「${course.name}」这次额外加课？` + (holidays.length ? ` 该日为 ${holidays.join('、')}，确认后仍安排上课。` : '') : `恢复「${course.name}」原定 ${date} 的课表安排？若原日期为所属课表的停课日期，仍会停课。`, '确认恢复');
    if (saved) M.toast(extra ? '已恢复额外加课' : '已恢复原课表');
    return saved;
  }

  M.openCourse = function (key, originalDate) {
    const initial = occurrence(key, originalDate);
    if (!initial) { M.toast('这次课程已不在当前课表中，请刷新后查看'); return; }
    return M.openPage({title: initial.name || '课程详情',
      body: '<div data-course-content></div>',
      actions: '<div class="m-actions" data-course-actions></div>',
      onMount(page) {
        const render = () => {
          const course = occurrence(key, originalDate), content = page.querySelector('[data-course-content]'), actions = page.querySelector('[data-course-actions]');
          if (!course) { content.innerHTML = empty('这次课程已不在当前课表中。'); actions.innerHTML = ''; page.querySelector('.m-page-actions').hidden = true; return; }
          const data = annotation(course), readonly = M.readonly();
          content.innerHTML = `<section class="m-section"><h2>${esc(course.name || '课程')}</h2>${courseSummary(course)}</section>
            ${readonly ? '' : `<section class="m-section"><h2>本次作业</h2><p>${data.homework_required ? '需交作业 · ' + (data.homework_done ? '已完成' : '未完成') : '未设置交作业要求'}</p>
              ${data.homework_notes ? `<p class="m-prewrap">${esc(data.homework_notes)}</p>` : ''}</section>
            <section class="m-section"><h2>课程备注</h2><p class="m-prewrap">${esc(data.notes || '未填写备注')}</p></section>
            <section class="m-section"><h2>本次课程安排</h2><p class="m-meta">仅调整这一次课程。</p>
              <div class="m-actions">
              ${course.cancelled ? '' : '<button type="button" data-action="adjust-course">调整时间</button>'}
              ${changeFor(key, originalDate) || course.kind === 'makeup' || course.kind === 'extra' && course.cancelled ? '<button type="button" data-action="restore-course">' + (course.kind === 'extra' ? '恢复额外加课' : '恢复原课表') + '</button>' : ''}
              ${course.kind === 'extra' ? '' : '<button type="button" data-action="makeup-course">' + (course.kind === 'makeup' && !course.cancelled ? '修改补课' : '安排补课') + '</button>'}
              ${course.cancelled ? '' : '<button type="button" class="danger" data-action="cancel-course">取消本次课程</button>'}</div></section>`}`;
          actions.innerHTML = readonly ? '' : `${data.homework_required ? `<button type="button" class="primary" data-action="toggle-course-homework">${data.homework_done ? '标为未完成' : '作业完成'}</button>` : ''}<button type="button" ${data.homework_required ? '' : 'class="primary"'} data-action="edit-course-annotation">编辑备注</button>`;
          page.querySelector('.m-page-actions').hidden = !actions.innerHTML.trim();
          page.querySelector('[data-action="edit-course-annotation"]')?.addEventListener('click', () => openAnnotation(key, originalDate));
          page.querySelector('[data-action="adjust-course"]')?.addEventListener('click', () => openAdjustment(key, originalDate));
          page.querySelector('[data-action="makeup-course"]')?.addEventListener('click', () => openMakeup(course.course_id, course));
          page.querySelector('[data-action="restore-course"]')?.addEventListener('click', () => restore(page, key, originalDate));
          page.querySelector('[data-action="toggle-course-homework"]')?.addEventListener('click', async () => {
            const current = occurrence(key, originalDate);
            if (!current || M.readonly()) return;
            const next = {...annotation(current), homework_done: !current.homework_done};
            if (await write(page, () => M.api('course-annotations', 'PUT', {...identity(current), ...next}),
              `将「${current.name}」原定 ${originalDate} 这次课的作业标为${next.homework_done ? '已完成' : '未完成'}？`, '确认作业状态')) M.toast(next.homework_done ? '作业已完成' : '作业已标为未完成');
          });
          page.querySelector('[data-action="cancel-course"]')?.addEventListener('click', async () => {
            if (M.readonly()) return;
            if (await write(page, () => ['makeup', 'extra'].includes(course.kind) ? M.api('course-makeups/' + encodeURIComponent(course.occurrence_id), 'PUT', {action: 'cancel'}) : M.api('course-exceptions', 'PUT', {...identity(course), cancelled: true, new_date: '', new_time: ''}),
              `取消「${course.name}」的这次${course.kind === 'makeup' ? '补课？原课仍保持停课。' : '课程？'}`, '确认取消课程')) M.toast('已取消本次课程');
          });
          M.decorate(page);
        };
        render(); watchData(page, render);
      }});
  };

  function openAnnotation(key, date) {
    const course = occurrence(key, date);
    if (!course || M.readonly()) return;
    const initial = annotation(course);
    let form, baseline = JSON.stringify(initial);
    const draft = () => ({notes: form.elements.notes.value, homework_required: form.elements.homework_required.checked,
      homework_notes: form.elements.homework_notes.value, homework_done: form.elements.homework_required.checked && form.elements.homework_done.checked});
    return M.openPage({title: '备注与作业', dirty: () => !!form && JSON.stringify(draft()) !== baseline,
      body: `<p class="m-meta">${esc(course.name)} · 原定 ${esc(date)} 的这次课</p><form data-course-annotation>
        <label class="m-field">课程备注<textarea name="notes" rows="5" maxlength="4000">${esc(initial.notes)}</textarea></label>
        <label class="m-check"><input name="homework_required" type="checkbox" ${initial.homework_required ? 'checked' : ''}>本次课需交作业</label>
        <div data-homework-fields><label class="m-check"><input name="homework_done" type="checkbox" ${initial.homework_done ? 'checked' : ''}>作业已完成</label>
        <label class="m-field">作业说明<textarea name="homework_notes" rows="5" maxlength="4000">${esc(initial.homework_notes)}</textarea></label></div>
        <p class="m-meta">内容记录在本次课，调课、恢复和重新导入课表后仍保留。</p></form>`,
      actions: '<button type="button" class="primary" data-action="save-course-annotation">保存备注与作业</button>',
      onMount(page) {
        form = page.querySelector('form');
        const toggle = () => { page.querySelector('[data-homework-fields]').hidden = !form.elements.homework_required.checked; };
        toggle(); form.elements.homework_required.addEventListener('change', toggle);
        form.addEventListener('submit', event => { event.preventDefault(); page.querySelector('[data-action="save-course-annotation"]').click(); });
        page.querySelector('[data-action="save-course-annotation"]').addEventListener('click', async () => {
          if (!form.reportValidity() || M.readonly()) return;
          const payload = draft();
          if (await write(page, () => M.api('course-annotations', 'PUT', {...identity(course), ...payload}),
            `保存「${course.name}」原定 ${date} 这次课的备注与作业设置？`, '确认保存')) {
            baseline = JSON.stringify(payload); M.toast('已保存备注与作业'); await M.back({force: true});
          }
        });
      }});
  }

  function openAdjustment(key, originalDate) {
    const course = occurrence(key, originalDate);
    if (course && !M.readonly()) openSchedule(course, 'adjust', course);
  }
  function openMakeup(courseId, source = null) {
    const group = groups().find(item => item.course_id === courseId); if (!group || M.readonly()) return;
    openSchedule(source || {course_id: group.course_id, name: group.name, date: today(), time: group.slots[0]?.time || '09:00–10:00', room: group.slots[0]?.room || ''}, source ? 'makeup' : 'extra', source);
  }
  function openSchedule(course, mode, source) {
    const times = (course.time || '').match(/\d{2}:\d{2}/g) || [], start = M.data.settings.start, end = M.utils.add(start, 125);
    const title = mode === 'makeup' ? '安排补课' : mode === 'extra' ? '添加额外课程' : '调整本次课程';
    const initialDate = course.date >= start && course.date <= end ? course.date : start;
    let form, baseline;
    const draft = () => ({date: form.elements.date.value, start: form.elements.start_time.value, end: form.elements.end_time.value, room: form.elements.room?.value || ''});
    return M.openPage({title, dirty: () => !!form && JSON.stringify(draft()) !== baseline,
      body: `<p>${esc(course.name)}</p>${source ? `<p class="m-meta">原安排：${esc(source.original_date)} · ${esc(source.original_time || course.time)}</p>` : ''}<form>
        <label class="m-field">上课日期<input name="date" type="date" required min="${start}" max="${end}" value="${esc(initialDate)}"></label>
        <label class="m-field">开始时间<input name="start_time" type="time" required step="60" value="${esc(times[0] || '')}"></label>
        <label class="m-field">结束时间<input name="end_time" type="time" required step="60" value="${esc(times[1] || '')}"></label>
        ${mode !== 'adjust' || ['extra', 'makeup'].includes(course.kind) ? `<label class="m-field">地点（选填）<input name="room" maxlength="120" value="${esc(course.room || '')}"></label>` : ''}
        <p class="m-meta">按北京时间安排。${mode === 'makeup' ? '补课沿用原课次的备注与作业，原时间不再占用。' : mode === 'extra' ? '额外课程有独立备注与作业，不改变固定课表。' : '仅调整这一次课程。'}</p></form>`,
      actions: '<button type="button" class="primary" data-action="save-schedule">保存课程安排</button>',
      onMount(page) {
        form = page.querySelector('form'); baseline = JSON.stringify(draft());
        form.addEventListener('submit', event => { event.preventDefault(); page.querySelector('[data-action="save-schedule"]').click(); });
        page.querySelector('[data-action="save-schedule"]').addEventListener('click', async () => {
          if (!form.reportValidity() || M.readonly()) return;
          const value = draft(); if (value.start >= value.end) { M.error(page, new Error('结束时间必须晚于开始时间')); return; }
          const time = value.start + '–' + value.end, holidays = holidayNames(value.date, course), conflicts = conflictNames(value.date, time, source?.occurrence_id);
          const message = `将「${course.name}」安排在 ${value.date} ${time}？` + (holidays.length ? ` 该日为 ${holidays.join('、')}，确认后仍安排上课。` : '') + (conflicts.length ? ` 与 ${conflicts.join('、')} 时间重叠，确定保留？` : '');
          let path, method, payload;
          if (mode === 'adjust' && !['extra', 'makeup'].includes(course.kind)) {
            path = 'course-exceptions'; method = 'PUT'; payload = {...identity(source), cancelled: false, new_date: value.date === source.original_date ? '' : value.date, new_time: time === source.original_time ? '' : time, allow_holiday: !!holidays.length};
          } else if (mode === 'adjust' || source?.kind === 'makeup') {
            path = 'course-makeups/' + encodeURIComponent(source.occurrence_id); method = 'PUT'; payload = {action: 'update', date: value.date, time, room: value.room, allow_holiday: !!holidays.length};
          } else {
            path = 'course-makeups'; method = 'POST'; payload = {course_id: course.course_id, ...(source ? {source_occurrence_id: source.occurrence_id} : {}), date: value.date, time, room: value.room, allow_holiday: !!holidays.length};
          }
          if (await write(page, () => saveSchedule(path, method, payload), message, '确认课程安排')) {
            baseline = JSON.stringify(value); M.toast('课程安排已保存'); await M.back({force: true});
          }
        });
      }});
  }

  function occurrenceButton(course) {
    return `<button type="button" class="m-card m-task-card" data-action="open-course" data-course-key="${esc(course.course_key)}" data-original-date="${esc(course.original_date)}">
      <strong>${esc(dateLabel(course.date))} · ${esc(course.time)}</strong>
      <span class="m-meta">${esc(course.room || '未设置地点')}${' · ' + status(course)}${course.homework_required ? ' · 作业' + (course.homework_done ? '已完成' : '未完成') : ''}</span>
      ${course.adjusted ? `<span class="m-meta">原定 ${esc(course.original_date)}</span>` : ''}</button>`;
  }
  function bindOccurrenceButtons(page) {
    page.querySelectorAll('[data-action="open-course"]').forEach(button => button.addEventListener('click', () => M.openCourse(button.dataset.courseKey, button.dataset.originalDate)));
  }
  function openSeries(id) {
    const course = groups().find(item => item.course_id === id); if (!course) return;
    return M.openPage({title: course.name, body: '<div data-series-list></div>', actions: '<button type="button" class="primary" data-action="extra-course">添加额外课程</button>',
      onMount(page) {
        const render = () => {
          const current = groups().find(item => item.course_id === id); if (!current) return;
          const slots = new Set(current.slots.map(slot => slot.slot_id));
          const rows = (M.data.course_dates || []).filter(row => row.course_id === id || slots.has(row.slot_id || row.course_key)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
          const future = rows.filter(row => !row.cancelled && row.date >= today()), past = rows.filter(row => !row.cancelled && row.date < today()).reverse(), cancelled = rows.filter(row => row.cancelled);
          const pastOpen = page.querySelector('[data-course-past]')?.open;
          page.querySelector('[data-series-list]').innerHTML = current.slots.map(slot => `<p class="m-meta">${esc(rule(slot))} · ${esc(slot.time)}${slot.room ? ' · ' + esc(slot.room) : ''}</p>`).join('') + `<p><a href="/timetables/?personal=1">编辑课程与时段</a></p><section class="m-section"><h2>接下来的课程 · ${future.length}</h2>${future.map(occurrenceButton).join('') || empty('当前学期没有后续课程。')}</section>${past.length ? `<details class="m-section" data-course-past ${pastOpen ? 'open' : ''}><summary>过去课程 · ${past.length}</summary>${past.map(occurrenceButton).join('')}</details>` : ''}<section class="m-section"><h2>停课与取消记录 · ${cancelled.length}</h2>${cancelled.map(occurrenceButton).join('') || empty('暂无停课记录。')}</section>`;
          bindOccurrenceButtons(page); M.decorate(page);
        };
        page.querySelector('[data-action="extra-course"]').addEventListener('click', () => openMakeup(id));
        render(); watchData(page, render);
      }});
  }

  M.openCourses = function () {
    if (M.readonly()) { M.toast('只读日程不提供课程管理'); return; }
    let tab = 'personal';
    return M.openPage({title: '课程安排', body: `<nav class="m-tabs" aria-label="课程安排">${[['personal', '我的课程'], ['changes', '临时调整'], ['template', '可用模板']].map(([id, label]) => `<button type="button" data-course-tab="${id}">${label}</button>`).join('')}</nav><div data-courses-list></div>`,
      onMount(page) {
        const render = () => {
          page.querySelectorAll('[data-course-tab]').forEach(button => { const active = button.dataset.courseTab === tab; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
          const body = page.querySelector('[data-courses-list]');
          if (tab === 'personal') {
            const courses = groups();
            body.innerHTML = `<p class="m-meta">共 ${courses.length} 门课程，${(M.data.timetable || []).length} 个固定时段。选择课程查看全部课次及作业。</p><p><a href="/timetables/?personal=1">设计我的课程与时段</a></p>` + (courses.map(course => `<button type="button" class="m-card m-task-card" data-course-series="${esc(course.course_id)}"><strong>${esc(course.name)}</strong>${course.slots.map(slot => `<span class="m-meta">${esc(rule(slot))} · ${esc(slot.time)}</span>`).join('')}</button>`).join('') || empty('尚未添加课程。可在可用模板中预览并导入。'));
            body.querySelectorAll('[data-course-series]').forEach(button => button.addEventListener('click', () => openSeries(button.dataset.courseSeries)));
          }
          if (tab === 'changes') {
            const rows = (M.data.course_dates || []).filter(course => course.adjusted || course.cancelled || course.archived || ['makeup', 'extra'].includes(course.kind)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
            body.innerHTML = '<p class="m-meta">选择停课或取消的原课次可安排补课；取消补课后原课仍停课。</p>' + (rows.map(course => `<section class="m-card"><h2>${esc(course.name)}</h2>${occurrenceButton(course)}</section>`).join('') || empty('暂无临时调整与停课记录。'));
          }
          if (tab === 'template') body.innerHTML = '<section class="m-card"><h2>课表模板设计器</h2><p>各份模板可分别预览、合并导入和更新；提交前查看差异并保留个人修改。</p><a href="/timetables/">浏览可用模板与导入</a></section>';
          bindOccurrenceButtons(page); M.decorate(page);
        };
        page.querySelectorAll('[data-course-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.courseTab; render(); }));
        render(); watchData(page, render);
      }});
  };
})();
