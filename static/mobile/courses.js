/* Personal course occurrences keep their original identity across schedule changes. */
(() => {
  'use strict';
  const M = window.Mobile;
  const {esc, today, formatDate} = M.utils;
  const days = ['', '一', '二', '三', '四', '五', '六', '日'];
  const dateLimits = 'min="0001-01-01" max="9999-12-31"';
  const empty = text => `<p class="m-empty">${esc(text)}</p>`;
  const dateLabel = date => formatDate ? formatDate(date) : date;
  const rule = course => `周${days[Number(course.day)] || course.day} · ${course.weeks === 'odd' ? '单周' : course.weeks === 'even' ? '双周' : '每周'} · 第 ${course.start || 1}–${course.end || 16} 周`;
  const series = key => (M.data.timetable || []).find(course => course.course_id === key);
  const changeFor = (key, date) => (M.data.course_exceptions || []).find(change => change.course_key === key && change.date === date);
  function occurrence(key, date) {
    const row = (M.data.course_dates || []).find(course => course.course_key === key && course.original_date === date);
    if (row) return row;
    const course = series(key), change = changeFor(key, date);
    if (!course || !change) return null;
    return {...course, course_key: key, original_date: date, original_time: change.original_time || course.time,
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
      ${course.cancelled ? '<p class="m-meta">本次课程已取消</p>' : course.adjusted ? '<p class="m-meta">本次课程已调整</p>' : ''}
      ${course.adjusted ? `<p class="m-meta">原安排：${esc(dateLabel(course.original_date))} · ${esc(course.original_time || '')}</p>` : ''}`;
  }
  async function restore(page, key, date) {
    if (M.readonly()) return false;
    const course = occurrence(key, date), name = course?.name || series(key)?.name || '这门课程';
    const saved = await write(page, () => M.api('course-exceptions', 'PUT', {course_key: key, date, cancelled: false, new_date: '', new_time: ''}),
      `恢复「${name}」原定 ${date} 的这次课程？`, '确认恢复');
    if (saved) M.toast('已恢复本次课程的原安排');
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
              ${changeFor(key, originalDate) ? '<button type="button" data-action="restore-course">恢复原课表</button>' : ''}
              ${course.cancelled ? '' : '<button type="button" class="danger" data-action="cancel-course">取消本次课程</button>'}</div></section>`}`;
          actions.innerHTML = readonly ? '' : `${data.homework_required ? `<button type="button" class="primary" data-action="toggle-course-homework">${data.homework_done ? '标为未完成' : '作业完成'}</button>` : ''}<button type="button" ${data.homework_required ? '' : 'class="primary"'} data-action="edit-course-annotation">编辑备注</button>`;
          page.querySelector('.m-page-actions').hidden = !actions.innerHTML.trim();
          page.querySelector('[data-action="edit-course-annotation"]')?.addEventListener('click', () => openAnnotation(key, originalDate));
          page.querySelector('[data-action="adjust-course"]')?.addEventListener('click', () => openAdjustment(key, originalDate));
          page.querySelector('[data-action="restore-course"]')?.addEventListener('click', () => restore(page, key, originalDate));
          page.querySelector('[data-action="toggle-course-homework"]')?.addEventListener('click', async () => {
            const current = occurrence(key, originalDate);
            if (!current || M.readonly()) return;
            const next = {...annotation(current), homework_done: !current.homework_done};
            if (await write(page, () => M.api('course-annotations', 'PUT', {course_key: key, date: originalDate, ...next}),
              `将「${current.name}」原定 ${originalDate} 这次课的作业标为${next.homework_done ? '已完成' : '未完成'}？`, '确认作业状态')) M.toast(next.homework_done ? '作业已完成' : '作业已标为未完成');
          });
          page.querySelector('[data-action="cancel-course"]')?.addEventListener('click', async () => {
            if (M.readonly()) return;
            if (await write(page, () => M.api('course-exceptions', 'PUT', {course_key: key, date: originalDate, cancelled: true, new_date: '', new_time: ''}),
              `取消「${course.name}」原定 ${originalDate} 的这一次课程？`, '确认取消课程')) M.toast('已取消本次课程');
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
          if (await write(page, () => M.api('course-annotations', 'PUT', {course_key: key, date, ...payload}),
            `保存「${course.name}」原定 ${date} 这次课的备注与作业设置？`, '确认保存')) {
            baseline = JSON.stringify(payload); M.toast('已保存备注与作业'); await M.back({force: true});
          }
        });
      }});
  }

  function openAdjustment(key, originalDate) {
    const course = occurrence(key, originalDate), original = series(key);
    if (!course || !original || M.readonly()) return;
    const times = (course.time || '').match(/\d{2}:\d{2}/g) || [];
    let form, baseline;
    const draft = () => ({date: form.elements.date.value, start: form.elements.start_time.value, end: form.elements.end_time.value});
    return M.openPage({title: '调整本次课程', dirty: () => !!form && JSON.stringify(draft()) !== baseline,
      body: `<p>${esc(course.name)}</p><p class="m-meta">原安排：${esc(originalDate)} · ${esc(course.original_time || original.time)}</p><form data-course-adjustment>
        <label class="m-field">上课日期<input name="date" type="date" required ${dateLimits} value="${esc(course.date)}"></label>
        <label class="m-field">开始时间<input name="start_time" type="time" required step="60" value="${esc(times[0] || '')}"></label>
        <label class="m-field">结束时间<input name="end_time" type="time" required step="60" value="${esc(times[1] || '')}"></label>
        <p class="m-meta">按北京时间安排，仅调整这一次课程。</p></form>`,
      actions: '<button type="button" class="primary" data-action="save-course-adjustment">保存本次调整</button>',
      onMount(page) {
        form = page.querySelector('form'); baseline = JSON.stringify(draft());
        form.addEventListener('submit', event => { event.preventDefault(); page.querySelector('[data-action="save-course-adjustment"]').click(); });
        page.querySelector('[data-action="save-course-adjustment"]').addEventListener('click', async () => {
          if (!form.reportValidity() || M.readonly()) return;
          const value = draft();
          if (value.start >= value.end) { M.error(page, new Error('结束时间必须晚于开始时间')); return; }
          if ((M.data.holidays || []).some(holiday => holiday.start <= value.date && value.date <= holiday.end)) { M.error(page, new Error('所选日期为节假日，请选择其他日期')); return; }
          const time = value.start + '–' + value.end;
          const payload = {course_key: key, date: originalDate, cancelled: false, new_date: value.date === originalDate ? '' : value.date, new_time: time === original.time ? '' : time};
          if (await write(page, () => M.api('course-exceptions', 'PUT', payload),
            `将「${course.name}」这次课程调整为 ${value.date} ${time}？`, '确认调整')) {
            baseline = JSON.stringify(value); M.toast('已调整本次课程'); await M.back({force: true});
          }
        });
      }});
  }

  function occurrenceButton(course) {
    return `<button type="button" class="m-card m-task-card" data-action="open-course" data-course-key="${esc(course.course_key)}" data-original-date="${esc(course.original_date)}">
      <strong>${esc(dateLabel(course.date))} · ${esc(course.time)}</strong>
      <span class="m-meta">${esc(course.room || '未设置地点')}${course.cancelled ? ' · 已取消' : course.adjusted ? ' · 已调课' : ''}${course.homework_required ? ' · 作业' + (course.homework_done ? '已完成' : '未完成') : ''}</span>
      ${course.adjusted ? `<span class="m-meta">原定 ${esc(course.original_date)}</span>` : ''}</button>`;
  }
  function bindOccurrenceButtons(page) {
    page.querySelectorAll('[data-action="open-course"]').forEach(button => button.addEventListener('click', () => M.openCourse(button.dataset.courseKey, button.dataset.originalDate)));
  }
  function openSeries(key) {
    const course = series(key);
    if (!course) return;
    return M.openPage({title: course.name, body: '<div data-series-list></div>',
      onMount(page) {
        const render = () => {
          const rows = (M.data.course_dates || []).filter(row => row.course_key === key).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
          const future = rows.filter(row => row.date >= today()), past = rows.filter(row => row.date < today()).reverse();
          const pastOpen = page.querySelector('[data-course-past]')?.open;
          page.querySelector('[data-series-list]').innerHTML = `<p class="m-meta">${esc(rule(course))} · ${esc(course.time)}</p><section class="m-section"><h2>接下来的课程 · ${future.length}</h2>
            ${future.map(occurrenceButton).join('') || empty('当前学期没有后续课程。')}</section>${past.length ? `<details class="m-section" data-course-past ${pastOpen ? 'open' : ''}><summary>过去课程 · ${past.length}</summary>${past.map(occurrenceButton).join('')}</details>` : ''}`;
          bindOccurrenceButtons(page); M.decorate(page);
        };
        render(); watchData(page, render);
      }});
  }
  function templateRows(courses, clickable) {
    return courses.length ? courses.slice().sort((a, b) => a.day - b.day || String(a.time).localeCompare(String(b.time))).map(course =>
      `<${clickable ? 'button type="button"' : 'div'} class="m-card${clickable ? ' m-task-card' : ''}" ${clickable ? `data-action="open-course-series" data-course-key="${esc(course.course_id)}"` : ''}>
      <strong>${esc(course.name)}</strong><span class="m-meta">${esc(rule(course))}</span><span class="m-meta">${esc(course.time)}${course.room ? ' · ' + esc(course.room) : ''}</span></${clickable ? 'button' : 'div'}>`).join('') : empty(clickable ? '尚未导入个人课表。可在公共模板中预览并导入。' : '公共模板暂无课程。');
  }

  M.openCourses = function () {
    if (M.readonly()) { M.toast('只读日程不提供课程管理'); return; }
    let tab = 'personal', template = null, loading = false;
    return M.openPage({title: '课程安排', body: `<nav class="m-tabs" aria-label="课程安排">${[['personal', '我的课表'], ['changes', '临时调整'], ['template', '公共模板']].map(([id, label]) => `<button type="button" data-action="course-tab" data-course-tab="${id}">${label}</button>`).join('')}</nav><div data-courses-list></div>`,
      actions: '<div class="m-actions" data-courses-actions></div>',
      onMount(page) {
        const render = () => {
          page.querySelectorAll('[data-course-tab]').forEach(button => { const active = button.dataset.courseTab === tab; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
          const body = page.querySelector('[data-courses-list]'), actions = page.querySelector('[data-courses-actions]');
          actions.innerHTML = '';
          if (tab === 'personal') body.innerHTML = `<p class="m-meta">已导入 ${(M.data.timetable || []).length} 条课程安排。选择课程查看每次课及作业。</p>${templateRows(M.data.timetable || [], true)}`;
          if (tab === 'changes') {
            const changes = (M.data.course_exceptions || []).slice().sort((a, b) => (a.new_date || a.date).localeCompare(b.new_date || b.date));
            body.innerHTML = changes.map((change, index) => {
              const course = series(change.course_key);
              return `<section class="m-card"><strong>${esc(course?.name || '已移出课表的课程')}</strong><p class="m-meta">原定 ${esc(change.date)} · ${esc(change.original_time || course?.time || '')}</p>
                <p>${change.cancelled ? '本次已取消' : esc((change.new_date || change.date) + ' · ' + (change.new_time || course?.time || ''))}</p>
                ${occurrence(change.course_key, change.date) ? `<button type="button" data-action="open-course" data-course-key="${esc(change.course_key)}" data-original-date="${esc(change.date)}">查看本次课程</button>` : ''}
                <button type="button" data-action="restore-course-change" data-change-index="${index}">恢复原课表</button></section>`;
            }).join('') || empty('暂无临时课程调整。');
            page.querySelectorAll('[data-action="restore-course-change"]').forEach(button => button.addEventListener('click', () => { const change = changes[Number(button.dataset.changeIndex)]; restore(page, change.course_key, change.date); }));
          }
          if (tab === 'template') {
            body.innerHTML = loading ? empty('正在读取公共模板…') : template ? `<p class="m-meta">公共模板共 ${template.courses.length} 条课程安排。</p>${templateRows(template.courses, false)}
              <section class="m-section"><h2>节假日</h2>${template.holidays.length ? template.holidays.map(holiday => `<p>${esc(holiday.name)}<span class="m-meta"> · ${esc(holiday.start)} — ${esc(holiday.end)}</span></p>`).join('') : empty('暂无节假日设置。')}</section>` : '<button type="button" data-action="retry-course-template">重新读取公共模板</button>';
            if (template && !loading) actions.innerHTML = '<button type="button" class="primary" data-action="import-course-template">导入到我的课表</button>' + (M.data.user?.admin ? '<button type="button" data-action="edit-course-template">编辑公共模板</button>' : '');
            page.querySelector('[data-action="retry-course-template"]')?.addEventListener('click', loadTemplate);
            page.querySelector('[data-action="import-course-template"]')?.addEventListener('click', async () => {
              if (M.readonly()) return;
              if (await write(page, () => M.api('timetable', 'POST', {}), (M.data.timetable || []).length ? '用当前公共模板更新你的个人课表？已有单次课程调整和备注会保留。' : '将公共课程模板导入你的个人课表？', '确认导入')) {
                tab = 'personal'; render(); M.toast('已导入个人课表');
              }
            });
            page.querySelector('[data-action="edit-course-template"]')?.addEventListener('click', () => openTemplateEditor(template, saved => { template = saved; render(); }));
          }
          page.querySelectorAll('[data-action="open-course-series"]').forEach(button => button.addEventListener('click', () => openSeries(button.dataset.courseKey)));
          page.querySelector('.m-page-actions').hidden = !actions.innerHTML.trim();
          bindOccurrenceButtons(page); M.decorate(page);
        };
        const loadTemplate = async () => {
          if (loading) return;
          loading = true; render();
          try { const data = await M.api('timetable'); template = {courses: data.courses || [], holidays: data.holidays || []}; }
          catch (error) { M.error(page, error); }
          finally { loading = false; if (page.isConnected) render(); }
        };
        page.querySelectorAll('[data-course-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.courseTab; render(); if (tab === 'template' && !template) loadTemplate(); }));
        render(); watchData(page, render);
      }});
  };

  function openTemplateEditor(template, onSaved) {
    if (!M.data.user?.admin || M.readonly()) return;
    let form, baseline;
    const snapshot = () => JSON.stringify({courses: form.elements.courses.value, holidays: form.elements.holidays.value});
    return M.openPage({title: '编辑公共模板', dirty: () => !!form && snapshot() !== baseline,
      body: `<p class="m-meta">修改公共课表与节假日。已有课程请保留 course_id；保存后可从公共模板重新导入个人课表。</p><form data-course-template-form>
        <label class="m-field">课程 JSON<textarea name="courses" rows="18" spellcheck="false" autocapitalize="off" autocorrect="off">${esc(JSON.stringify(template.courses, null, 2))}</textarea></label>
        <label class="m-field">节假日 JSON<textarea name="holidays" rows="10" spellcheck="false" autocapitalize="off" autocorrect="off">${esc(JSON.stringify(template.holidays, null, 2))}</textarea></label></form>`,
      actions: '<button type="button" class="primary" data-action="save-course-template">保存公共模板</button>',
      onMount(page) {
        form = page.querySelector('form'); baseline = snapshot();
        page.querySelector('[data-action="save-course-template"]').addEventListener('click', async () => {
          if (!M.data.user?.admin || M.readonly()) return;
          let courses, holidays;
          try { courses = JSON.parse(form.elements.courses.value); } catch { M.error(page, new Error('课程 JSON 格式不正确，请检查引号、逗号和括号')); return; }
          try { holidays = JSON.parse(form.elements.holidays.value); } catch { M.error(page, new Error('节假日 JSON 格式不正确，请检查引号、逗号和括号')); return; }
          if (!Array.isArray(courses) || !Array.isArray(holidays)) { M.error(page, new Error('课程和节假日 JSON 都应为数组')); return; }
          if (courses.length > 100 || holidays.length > 100) { M.error(page, new Error('课程或节假日最多各 100 条')); return; }
          if (await write(page, () => M.api('timetable', 'PUT', {courses, holidays}), '保存公共课程模板和节假日？所有账户都可读取更新后的公共模板。', '确认保存公共模板')) {
            const submitted = snapshot(); baseline = submitted;
            let saved = {courses, holidays};
            try {
              saved = await M.api('timetable');
              if (snapshot() === submitted) {
                form.elements.courses.value = JSON.stringify(saved.courses, null, 2);
                form.elements.holidays.value = JSON.stringify(saved.holidays, null, 2);
                baseline = snapshot();
              }
            }
            catch { M.toast('模板已保存，重新打开后可读取服务端课程标识'); }
            onSaved(saved); M.toast('公共模板已保存');
          }
        });
        form.addEventListener('submit', event => { event.preventDefault(); page.querySelector('[data-action="save-course-template"]').click(); });
      }});
  }
})();
