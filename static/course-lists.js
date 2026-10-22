/* Shared presentation for desktop and mobile course management. */
(function (root) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch]));
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const order = (a, b) => (a.date + a.time).localeCompare(b.date + b.time) || itemKey(a).localeCompare(itemKey(b));
  const itemKey = row => row.occurrence_id || `${row.course_key}:${row.original_date}`;
  const empty = text => `<p class="course-list-empty">${esc(text)}</p>`;

  function dateParts(date, today) {
    const [year, month, day] = date.split('-');
    return {date: `${year !== today.slice(0, 4) ? year + '年' : ''}${Number(month)}月${Number(day)}日`,
      weekday: `周${weekdays[new Date(date + 'T12:00:00+08:00').getUTCDay()]}${date === today ? ' · 今天' : ''}`};
  }
  function badge(text, kind = '') { return `<span class="course-list-badge ${kind}">${esc(text)}</span>`; }
  function badges(row) {
    let result = '';
    if (row.cancelled) result += badge(row.kind === 'makeup' ? '补课已取消' : row.kind === 'extra' ? '加课已取消' : row.holiday ? '停课' : '已取消', 'is-cancelled');
    else if (row.kind === 'makeup') result += badge('补课', 'is-change');
    else if (row.kind === 'extra') result += badge('加课', 'is-change');
    else if (row.adjusted) result += badge('调课', 'is-change');
    if (row.archived) result += badge('保留记录');
    if (row.homework_required) result += badge(row.homework_done ? '作业已完成' : '待交作业', row.homework_done ? 'is-done' : 'is-pending');
    return result;
  }
  function occurrences(rows, {today, showName = false}) {
    return `<div class="course-list">${rows.map(row => {
      const date = dateParts(row.date, today);
      const original = row.adjusted && (row.date !== row.original_date || row.time !== row.original_time)
        ? `原定 ${dateParts(row.original_date, today).date} ${row.original_time || ''}` : '';
      return `<button type="button" class="course-list-row${row.date === today ? ' is-today' : ''}${row.cancelled ? ' is-cancelled' : ''}" data-course-item="${esc(itemKey(row))}" data-course-key="${esc(row.course_key)}" data-course-date="${esc(row.original_date)}">
        <span class="course-list-date"><time datetime="${esc(row.date)}">${esc(date.date)}</time><span>${esc(date.weekday)}</span></span>
        <span class="course-list-content">${showName ? `<strong class="course-list-name">${esc(row.name)}</strong>` : ''}<span class="course-list-schedule"><strong>${esc(row.time)}</strong>${row.room ? `<span>${esc(row.room)}</span>` : ''}</span>${original ? `<span class="course-list-original">${esc(original)}</span>` : ''}${row.cancelled && row.kind === 'makeup' ? '<span class="course-list-original">原课仍停课</span>' : ''}</span>
        <span class="course-list-badges">${badges(row)}</span></button>`;
    }).join('')}</div>`;
  }
  function section(key, label, rows, options, collapsed = false, hint = '') {
    const heading = `<span>${label}</span><span class="course-list-count">${rows.length}</span>`;
    const body = rows.length ? occurrences(rows, options) : empty(hint);
    return collapsed
      ? `<details class="course-list-section" data-course-group="${key}"><summary data-course-item="group:${key}">${heading}</summary>${body}</details>`
      : `<section class="course-list-section"><h3>${heading}</h3>${body}</section>`;
  }
  function grouped(rows, options) {
    const sorted = [...rows].sort(order), {today, changes = false} = options;
    if (changes) {
      if (!sorted.length) return empty('暂无临时调整与停课记录。');
      return section('upcoming', '接下来的调整', sorted.filter(row => row.date >= today), {...options, showName: true}, false, '暂无后续调整。')
        + section('past', '过去记录', sorted.filter(row => row.date < today).reverse(), {...options, showName: true}, true, '暂无过去记录。');
    }
    return section('upcoming', '接下来的课次', sorted.filter(row => !row.cancelled && row.date >= today), options, false, '本学期暂无后续课次。')
      + section('past', '过去课次', sorted.filter(row => !row.cancelled && row.date < today).reverse(), options, true, '暂无过去课次。')
      + section('cancelled', '停课与取消记录', sorted.filter(row => row.cancelled).reverse(), options, true, '暂无停课与取消记录。');
  }
  function rules(slots) {
    return `<span class="course-list-rules">${slots.length ? slots.map(slot => `<span class="course-list-rule"><span>周${esc(weekdays[Number(slot.day) % 7] || slot.day)}</span><strong>${esc(slot.time)}</strong><span>${slot.weeks === 'odd' ? '单周' : slot.weeks === 'even' ? '双周' : '每周'} · ${esc(slot.start || 1)}–${esc(slot.end || 18)}周</span><span>${esc(slot.room || '')}</span></span>`).join('') : '<span class="course-list-original">无固定时段</span>'}</span>`;
  }
  function courses(groups, slotCount) {
    return `<div class="course-list-toolbar"><span>${groups.length} 门课程 · ${slotCount} 个时段</span><a href="/timetables/?personal=1">设计课程与时段 ↗</a></div><div class="course-list">${groups.map(group => `<button type="button" class="course-list-course" data-course-item="course:${esc(group.course_id)}" data-course-series="${esc(group.course_id)}"><strong class="course-list-name">${esc(group.name)}</strong>${rules(group.slots || [])}</button>`).join('')}</div>${groups.length ? '' : empty('尚未添加课程，可从模板导入。')}`;
  }
  // Replacing a list after a save must keep disclosures, scroll and keyboard focus.
  function remember(container, scrollHost = container) {
    return {open: new Map([...container.querySelectorAll('[data-course-group]')].map(node => [node.dataset.courseGroup, node.open])),
      top: scrollHost.scrollTop, focus: container.contains(document.activeElement) ? document.activeElement.closest('[data-course-item]')?.dataset.courseItem : null};
  }
  function restore(container, saved, scrollHost = container) {
    if (!saved) return;
    container.querySelectorAll('[data-course-group]').forEach(node => {node.open = saved.open.get(node.dataset.courseGroup) || false;});
    scrollHost.scrollTop = saved.top;
    if (saved.focus && !container.closest('[hidden]')) [...container.querySelectorAll('[data-course-item]')].find(node => node.dataset.courseItem === saved.focus)?.focus({preventScroll: true});
  }
  root.CourseLists = {courses, rules, occurrences, grouped, remember, restore};
})(typeof window === 'undefined' ? globalThis : window);
