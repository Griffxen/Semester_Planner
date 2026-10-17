/* Mobile management pages. State and navigation are owned by mobile/core.js. */
(() => {
  'use strict';
  const M = window.Mobile;
  const {esc, today, add} = M.utils;
  let serial = 0;
  const $ = (page, selector) => page.querySelector(selector);
  const catOptions = (selected, excluded = '') => (M.data.categories || []).filter(c => c.name !== excluded)
    .map(c => `<option value="${esc(c.name)}"${c.name === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  const option = (value, label, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
  const field = (label, input, hint = '') => `<label class="m-field"><span>${esc(label)}</span>${input}${hint ? `<small class="m-muted">${esc(hint)}</small>` : ''}</label>`;
  const input = (name, value = '', attrs = '') => `<input class="m-input" name="${name}" value="${esc(String(value))}" ${attrs}>`;
  const check = (name, label, checked = false, value = '') => `<label class="m-check"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}${value ? ` value="${esc(value)}"` : ''}><span>${esc(label)}</span></label>`;
  const button = (label, attrs = '', style = '') => `<button type="button" class="m-button ${style}" ${attrs}>${esc(label)}</button>`;
  const snapshot = f => JSON.stringify(Array.from(new FormData(f).entries()));
  const values = f => Object.fromEntries(new FormData(f));
  function deny() {
    if (!M.readonly()) return false;
    M.toast('当前是只读日程，不能修改管理设置');
    return true;
  }
  async function save(page, fn, message, label = '保存') {
    const ok = await M.write(fn, message, label);
    if (ok) { M.back({force: true}); M.toast('已保存'); }
    return ok;
  }
  function forgetSecretsOnLeave(page) {
    const clear = () => page.querySelectorAll('input[type="password"], [data-token-value]').forEach(field => { field.value = ''; });
    const observer = new MutationObserver(() => { if (page.hidden) clear(); });
    observer.observe(page, {attributes: true, attributeFilter: ['hidden']});
    page.addEventListener('mobile:dispose', () => { clear(); observer.disconnect(); }, {once: true});
  }
  function formPage({title, body, label = '保存', danger = false, onSubmit, onMount}) {
    const id = `mobile-manage-${++serial}`;
    let form, initial = '';
    const page = M.openPage({
      title, body: `<form id="${id}" class="m-stack">${body}</form>`,
      actions: `<button class="m-button ${danger ? 'm-danger danger' : 'm-primary primary'}" type="submit" form="${id}">${esc(label)}</button>`,
      dirty: () => !!form && snapshot(form) !== initial,
      onMount(node) {
        form = $(node, 'form');
        if (form.querySelector('input[type="password"]')) forgetSecretsOnLeave(node);
        if (onMount) onMount(node, form);
        initial = snapshot(form);
        form.addEventListener('submit', async e => {
          e.preventDefault();
          if (!form.reportValidity()) return;
          try { await onSubmit(node, form); } catch (error) { M.error(node, error); }
        });
      }
    });
    return page;
  }
  function loadPage(title, loader) {
    const page = M.openPage({title, body: '<p class="m-muted">正在加载…</p>', onMount(node) {
      loader(node).catch(error => M.error(node, error));
      node.addEventListener('mobile:resume', () => loader(node).catch(error => M.error(node, error)));
    }});
    return page;
  }
  function bodyOf(page) { return $(page, '.m-page-body') || page; }

  M.openCategories = () => {
    if (deny()) return;
    const render = page => {
      bodyOf(page).innerHTML = `<div class="m-stack">${(M.data.categories || []).map(c => `<button class="m-card m-button" data-category="${esc(c.name)}"><strong><span class="m-dot"></span>${esc(c.name)}</strong><span class="m-muted">${(M.data.tasks || []).filter(t => t.category === c.name).length} 项任务 · 黄色 ${c.warn_days} 天／红色 ${c.urgent_days} 天</span></button>`).join('')}</div><p>${button('新增分类', 'data-new-category', 'm-primary')}</p><p class="m-error" data-error role="alert"></p>`;
      page.querySelectorAll('[data-category]').forEach(b => b.onclick = () => editCategory(M.data.categories.find(c => c.name === b.dataset.category)));
      $(page, '[data-new-category]').onclick = () => editCategory(null);
      M.decorate(page);
    };
    M.openPage({title: '分类管理', body: '', onMount(page) { render(page); page.addEventListener('mobile:resume', () => render(page)); }});
  };
  function editCategory(category) {
    const c = category || {name: '', color: '#408f80', warn_days: 7, urgent_days: 2};
    formPage({title: category ? '编辑分类' : '新增分类', body:
      field('分类名称', input('name', c.name, 'required maxlength="20" autocomplete="off"')) +
      field('颜色', input('color', c.color, 'type="color" required')) +
      field('黄色提醒（天）', input('warn_days', c.warn_days, 'type="number" min="0" max="3650" required inputmode="numeric"')) +
      field('红色提醒（天）', input('urgent_days', c.urgent_days, 'type="number" min="0" max="3650" required inputmode="numeric"'), '红色天数不能超过黄色天数。设置 0 表示到达截止时才进入相应提醒。') +
      (category ? '<p class="m-muted">重命名会同步更新任务，并撤销展示账户对此旧分类的授权；请重新检查分享设置。</p>' + button('删除此分类', 'data-delete-category', 'm-danger') : ''),
      onMount(page) { if (category) $(page, '[data-delete-category]').onclick = () => deleteCategory(category, page); },
      async onSubmit(page, form) {
        const d = values(form); d.warn_days = Number(d.warn_days); d.urgent_days = Number(d.urgent_days);
        if (d.urgent_days > d.warn_days) throw Error('红色提醒天数不能超过黄色提醒天数');
        d.action = category ? 'edit' : 'create'; if (category) d.old = category.name;
        await save(page, () => M.api('/api/categories', 'POST', d), `${category ? '保存' : '创建'}分类「${d.name}」？`, category ? '保存分类' : '创建分类');
      }
    });
  }
  function deleteCategory(category, editorPage) {
    const choices = (M.data.categories || []).filter(c => c.name !== category.name);
    if (!choices.length) { M.toast('请先新增另一个分类以接收任务'); return; }
    formPage({title: '删除分类', label: '删除并迁移', danger: true,
      body: `<p>删除「${esc(category.name)}」后，其任务将迁移到下面的分类，原分享授权会撤销。</p>` + field('接收任务的分类', `<select name="target" class="m-input" required>${catOptions('', category.name)}</select>`),
      async onSubmit(page, form) {
        const target = form.elements.target.value;
        if (await M.write(() => M.api('/api/categories', 'POST', {action: 'delete', name: category.name, target}), `删除「${category.name}」，并把任务迁移到「${target}」？`, '删除并迁移')) {
          // History traversal is asynchronous; close the obsolete editor after it resumes.
          editorPage.addEventListener('mobile:resume', () => M.back({force: true}), {once: true});
          M.back({force: true}); M.toast('分类已删除，任务已迁移');
        }
      }
    });
  }

  M.openSettings = () => {
    if (deny()) return;
    formPage({title: '学期设置', body:
      field('学期名称', input('name', M.data.settings.name, 'required maxlength="80"')) +
      field('学期开始日期', input('start', M.data.settings.start, 'type="date" required'), '以周一开始，共 18 周。更改后将重新按学期起始日展开课程，不会平移已有任务、节点或截止。'),
      async onSubmit(page, form) {
        const d = values(form);
        if (new Date(`${d.start}T12:00:00Z`).getUTCDay() !== 1) throw Error('请选择周一作为学期起始日');
        await save(page, () => M.api('/api/settings', 'PUT', d), `保存学期「${d.name}」，开始日期 ${d.start}？`, '保存学期');
      }
    });
  };

  M.openAccount = () => {
    if (M.data.preview) { M.toast('请先退出分享预览'); return; }
    const viewer = !!M.data.user.viewer;
    M.openPage({title: '个人账户', body: `<section class="m-card"><h2>${esc(M.data.user.remark || M.data.user.name)}</h2><p class="m-muted">@${esc(M.data.user.name)} · ${viewer ? '展示账户' : M.data.user.admin ? '管理员' : '普通账户'}</p>${viewer ? '<p class="m-muted">展示账户可修改自己的用户名和密码。</p>' : button('编辑个人备注', 'data-profile') }</section><div class="m-stack">${button('修改用户名', 'data-rename')}${button('修改密码', 'data-password')}</div>`,
      onMount(page) {
        if (!viewer) $(page, '[data-profile]').onclick = editProfile;
        $(page, '[data-rename]').onclick = () => editCredentials('rename');
        $(page, '[data-password]').onclick = () => editCredentials('self');
        page.addEventListener('mobile:resume', () => {
          const heading = $(page, 'h2'); if (heading) heading.textContent = M.data.user.remark || M.data.user.name;
          const info = $(page, 'section .m-muted'); if (info) info.textContent = `@${M.data.user.name} · ${viewer ? '展示账户' : M.data.user.admin ? '管理员' : '普通账户'}`;
        });
      }
    });
  };
  function editProfile() {
    formPage({title: '个人备注', body: field('显示备注', input('remark', M.data.user.remark || '', 'maxlength="60"'), '显示在账户和分享者名称中，留空使用用户名。'),
      onSubmit(page, form) { return save(page, () => M.api('/api/profile', 'PUT', values(form)), '保存个人显示备注？', '保存备注'); }
    });
  }
  function editCredentials(action, account) {
    const rename = action === 'rename';
    const self = action === 'self';
    const title = rename ? '修改用户名' : self ? '修改密码' : action === 'create' ? '创建普通账户' : `重置 ${account?.name || ''} 的密码`;
    const minimum = self ? (M.data.user.admin ? 12 : 4) : account?.admin ? 12 : 4;
    formPage({title, label: rename ? '修改用户名' : self ? '修改密码' : action === 'create' ? '创建账户' : '重置密码', body:
      (!self ? field(rename ? '新用户名' : '用户名', input('name', account?.name || '', `required maxlength="64" autocomplete="off"${account ? ' readonly' : ''}`), '1–64 位，不能含空白或控制字符。') : '') +
      field(self || rename ? '你的当前密码' : '管理员自己的密码', input('current_password', '', 'type="password" required maxlength="1024" autocomplete="current-password"')) +
      (!rename ? field('新密码', input('password', '', `type="password" required minlength="${minimum}" maxlength="256" autocomplete="new-password"`), `至少 ${minimum} 位。修改密码后，此账户的全部会话都会退出。`) +
      field('再次输入新密码', input('confirm_password', '', 'type="password" required maxlength="256" autocomplete="new-password"')) : ''),
      async onSubmit(page, form) {
        const d = values(form);
        if (!self && (!d.name || /\s|[\u0000-\u001f\u007f]/.test(d.name))) throw Error('用户名不能含空白或控制字符');
        if (!rename && d.password !== d.confirm_password) throw Error('两次输入的新密码不一致');
        delete d.confirm_password; d.action = action;
        await save(page, async () => {
          const result = await M.api(rename ? '/api/username' : self ? '/api/password' : '/api/users', 'POST', d);
          form.querySelectorAll('input[type="password"]').forEach(i => { i.value = ''; });
          return result;
        }, `${title}${action === 'reset' ? '并退出其全部会话' : ''}？`, rename ? '修改用户名' : self ? '修改密码' : action === 'create' ? '创建账户' : '重置密码');
      }
    });
  }

  M.openAccounts = () => {
    if (deny() || !M.data.user.admin) return;
    return loadPage('账户管理', async page => {
      const rows = (await M.api('/api/users')).accounts;
      const roles = {admin: '管理员', user: '普通账户', viewer: '展示账户'};
      bodyOf(page).innerHTML = `<p class="m-muted">共 ${rows.length} 个账户。重置密码会退出目标账户的全部会话。</p>${button('创建普通账户', 'data-create-user', 'm-primary')}<div class="m-stack">${rows.map(u => `<section class="m-card"><strong>${esc(u.remark || u.name)}</strong><p class="m-muted">@${esc(u.name)} · ${roles[u.role] || '普通账户'}${u.role === 'viewer' ? ` · 所有者 ${esc(u.owner_name || '')} · ${u.active ? u.sharing_enabled ? '分享中' : '未开启' : '已停用'}` : ''}</p>${button('重置密码', `data-reset-user="${u.id}"`)}</section>`).join('')}</div>${button('展示账户的创建与绑定', 'data-viewer-admin')}<p class="m-error" data-error role="alert"></p>`;
      $(page, '[data-create-user]').onclick = () => editCredentials('create');
      page.querySelectorAll('[data-reset-user]').forEach(b => b.onclick = () => editCredentials('reset', rows.find(u => String(u.id) === b.dataset.resetUser)));
      $(page, '[data-viewer-admin]').onclick = async () => { try { openShareAdmin(await M.api('/api/shares')); } catch (error) { M.error(page, error); } };
    });
  };

  M.openSharing = () => {
    if (deny()) return;
    return loadPage('分享管理', async page => {
      const data = await M.api('/api/shares');
      bodyOf(page).innerHTML = `<p class="m-muted">每个展示账户有独立的分享范围和导出权限。更改分类名称后，请重新检查授权。</p><div class="m-stack">${data.shares.map(s => `<section class="m-card"><strong>${esc(s.name)}</strong><p class="m-muted">${!s.active ? '管理员已停用' : s.policy.enabled ? '分享中' : '未开启／已暂停'}</p><div class="m-actions">${button('设置', `data-share="${s.id}"`)}${button('预览', `data-preview="${s.id}"`)}</div></section>`).join('') || '<p class="m-muted">暂无展示账户，请管理员创建并绑定给你。</p>'}</div>${M.data.user.admin ? button('创建／绑定／停用展示账户', 'data-share-admin') : ''}<p class="m-error" data-error role="alert"></p>`;
      page.querySelectorAll('[data-share]').forEach(b => b.onclick = () => editPolicy(data.shares.find(s => String(s.id) === b.dataset.share)));
      page.querySelectorAll('[data-preview]').forEach(b => b.onclick = async () => {
        try {
          const result = await M.api(`/api/share-preview/${b.dataset.preview}`);
          M.previewId = Number(b.dataset.preview);
          M.goHome(); M.setData(result); M.toast('已进入只读分享预览');
        } catch (error) { M.error(page, error); }
      });
      const admin = $(page, '[data-share-admin]'); if (admin) admin.onclick = () => openShareAdmin(data);
    });
  };
  function editPolicy(share) {
    const p = share.policy;
    const dates = [...new Set([...(M.data.journal || []).filter(j => j.body).map(j => j.date), ...(p.journal_dates || [])])].sort();
    const boolFields = [['enabled', '开启分享'], ['done', '包含已完成任务'], ['notes', '显示任务备注'], ['timetable', '显示课程'], ['export', '允许导出图片'], ['busy_only', '仅显示忙闲，隐藏原始内容']];
    formPage({title: `${share.name} · 分享设置`, body:
      (!share.active ? '<p class="m-muted">此账户已由管理员停用，保存设置不会重新启用账户。</p>' : '') +
      boolFields.map(([name, label]) => check(name, label, !!p[name])).join('') +
      field('分享日期范围', `<select class="m-input" name="range">${[['week','本周'],['two','本周及下周'],['semester','整个学期'],['custom','指定日期']].map(([v,l]) => option(v,l,p.range)).join('')}</select>`) +
      `<section data-custom-range>${field('开始日期', input('start', p.start || '', 'type="date"'))}${field('结束日期', input('end', p.end || '', 'type="date"'))}</section>` +
      '<fieldset class="m-card"><legend>授权分类</legend>' + (M.data.categories || []).map(c => check('categories', c.name, p.categories.includes(c.name), c.name)).join('') + '</fieldset>' +
      field('手记分享', `<select class="m-input" name="journal">${[['none','不分享'],['all','范围内全部手记'],['selected','仅指定日期']].map(([v,l]) => option(v,l,p.journal)).join('')}</select>`) +
      `<fieldset class="m-card" data-journal-dates><legend>分享这些日期的手记</legend>${dates.map(d => check('journal_dates', d, (p.journal_dates || []).includes(d), d)).join('') || '<p class="m-muted">目前没有手记。</p>'}</fieldset>` +
      '<p class="m-muted">仅忙闲模式会隐藏标题、分类、节点、状态、备注及手记；时间范围仍按此处已保存设置执行。</p>' +
      button('Dashboard 只读 Token', 'data-token'),
      onMount(page, form) {
        const visibility = () => {
          const custom = form.elements.range.value === 'custom';
          $(form, '[data-custom-range]').hidden = !custom;
          form.elements.start.required = form.elements.end.required = custom;
          $(form, '[data-journal-dates]').hidden = form.elements.journal.value !== 'selected';
        };
        form.elements.range.onchange = visibility; form.elements.journal.onchange = visibility; visibility();
        const initial = snapshot(form);
        $(page, '[data-token]').onclick = () => {
          if (snapshot(form) !== initial) { M.error(page, Error('请先保存分享设置，再管理 Token')); return; }
          openToken(share);
        };
      },
      async onSubmit(page, form) {
        const f = values(form);
        if (f.range === 'custom' && f.start > f.end) throw Error('分享结束日期不能早于开始日期');
        const policy = {range: f.range, start: f.start || '', end: f.end || '', journal: f.journal,
          categories: new FormData(form).getAll('categories'), journal_dates: new FormData(form).getAll('journal_dates')};
        boolFields.forEach(([k]) => { policy[k] = form.elements[k].checked; });
        await save(page, () => M.api('/api/shares', 'PUT', {id: share.id, version: share.version, policy}), `保存「${share.name}」的分享范围？`, '保存分享');
      }
    });
  }
  function openToken(share) {
    let form;
    const page = M.openPage({title: `${share.name} · Dashboard Token`, body:
      `<p class="m-muted" data-token-status>${share.dashboard_token_enabled ? '已生成 Token；重新生成会立即撤销旧 Token。' : '尚未生成 Token。'}</p><p>Token 绑定此展示账户，遵守已保存的分享设置。只显示一次，请放在 Dashboard 服务端。</p><form autocomplete="off">${field('你的当前密码', input('current_password', '', 'type="password" required maxlength="1024" autocomplete="current-password"'))}</form><div class="m-stack">${button('生成／轮换 Token', 'data-rotate', 'm-primary')}${button('撤销 Token', 'data-revoke', 'm-danger')}</div><section data-token-result hidden>${field('新 Token（请立即复制）', '<textarea class="m-input" rows="4" readonly data-token-value autocomplete="off" spellcheck="false"></textarea>')}${button('复制 Token', 'data-copy')}</section>`,
      dirty: () => !!form?.elements.current_password.value,
      onMount(node) {
        forgetSecretsOnLeave(node);
        form = $(node, 'form'); form.onsubmit = e => e.preventDefault();
        const change = async action => {
          if (!form.reportValidity()) return;
          const password = form.elements.current_password.value;
          let result;
          const ok = await M.write(async () => { result = await M.api('/api/dashboard-token', 'POST', {id: share.id, action, current_password: password}); }, action === 'rotate' ? `生成「${share.name}」的新 Token，并立即撤销旧 Token？` : `立即撤销「${share.name}」的 Token？`, action === 'rotate' ? '生成 Token' : '撤销 Token');
          if (!ok) return;
          form.elements.current_password.value = '';
          share.dashboard_token_enabled = !!result.token;
          $(node, '[data-token-status]').textContent = result.token ? '新 Token 已生成，仅此处显示一次。' : 'Token 已撤销。';
          $(node, '[data-token-value]').value = result.token || '';
          $(node, '[data-token-result]').hidden = !result.token;
          M.toast('Token 设置已更新');
        };
        $(node, '[data-rotate]').onclick = () => change('rotate').catch(error => M.error(node, error));
        $(node, '[data-revoke]').onclick = () => change('revoke').catch(error => M.error(node, error));
        $(node, '[data-copy]').onclick = async () => {
          try { await navigator.clipboard.writeText($(node, '[data-token-value]').value); M.toast('Token 已复制'); }
          catch (_) { $(node, '[data-token-value]').select(); M.toast('请长按选中的 Token 复制'); }
        };
      }
    });
    return page;
  }
  function openShareAdmin(data) {
    if (!M.data.user.admin || M.readonly()) return;
    const owners = data.owners || [], accounts = data.accounts || [];
    formPage({title: '展示账户管理', label: '执行操作', body:
      field('操作', `<select class="m-input" name="action">${option('create','创建展示账户','create')}${option('rebind','重新绑定所有者','create')}${option('active','启用／停用账户','create')}</select>`) +
      `<section data-create>${field('用户名', input('name', '', 'maxlength="64" autocomplete="off"'))}${field('账户初始密码', input('password', '', 'type="password" minlength="4" maxlength="256" autocomplete="new-password"'))}${field('再次输入初始密码', input('confirm', '', 'type="password" maxlength="256" autocomplete="new-password"'))}</section>` +
      `<section data-target>${field('展示账户', `<select class="m-input" name="id">${accounts.map(a => option(String(a.id), `${a.name} → ${owners.find(o => o.id === a.owner_id)?.name || ''}${a.active ? '' : '（停用）'}`, '')).join('')}</select>`)}</section>` +
      `<section data-owner>${field('日程所有者', `<select class="m-input" name="owner_id">${owners.map(o => option(String(o.id),o.name,'')).join('')}</select>`)}</section>` +
      `<section data-active>${check('active','启用此展示账户',true)}</section>` +
      field('管理员自己的密码', input('current_password', '', 'type="password" required maxlength="1024" autocomplete="current-password"')) +
      '<p class="m-muted">新建或重新绑定后，须由日程所有者开启分享。重新绑定会清空旧授权和 Token，并退出全部旧会话。</p>',
      onMount(page, form) {
        const visibility = () => {
          const action = form.elements.action.value;
          $(page, '[data-create]').hidden = action !== 'create';
          $(page, '[data-target]').hidden = action === 'create';
          $(page, '[data-owner]').hidden = action === 'active';
          $(page, '[data-active]').hidden = action !== 'active';
          ['name','password','confirm'].forEach(k => { form.elements[k].required = action === 'create'; form.elements[k].disabled = action !== 'create'; });
          form.elements.id.required = action !== 'create'; form.elements.id.disabled = action === 'create';
          form.elements.owner_id.required = action !== 'active'; form.elements.owner_id.disabled = action === 'active';
          if (action === 'active') form.elements.active.checked = !!accounts.find(a => String(a.id) === form.elements.id.value)?.active;
        };
        form.elements.action.onchange = visibility; form.elements.id.onchange = visibility; visibility();
      },
      async onSubmit(page, form) {
        const d = values(form); d.id = Number(d.id); d.owner_id = Number(d.owner_id); d.active = form.elements.active.checked;
        if (d.action === 'create' && d.password !== d.confirm) throw Error('两次输入的初始密码不一致');
        delete d.confirm;
        await save(page, () => M.api('/api/shares', 'POST', d), d.action === 'rebind' ? '重新绑定会清空旧授权和 Token，并退出全部旧会话，确认重新绑定？' : d.action === 'active' ? `${d.active ? '启用' : '停用'}选中的展示账户并退出其当前会话？` : `创建展示账户「${d.name}」？`, d.action === 'rebind' ? '重新绑定' : d.action === 'active' ? d.active ? '启用账户' : '停用账户' : '创建账户');
      }
    });
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; a.hidden = true; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  M.exportData = () => {
    if (deny()) return;
    const d = M.data;
    const result = {format: 1, exportedAt: new Date().toISOString(), settings: d.settings, tasks: d.tasks,
      journal: d.journal, timetable: d.timetable, course_exceptions: d.course_exceptions, holidays: d.holidays};
    download(new Blob([JSON.stringify(result,null,2)], {type: 'application/json'}), `semester-${today()}.json`);
    M.toast('JSON 备份已导出');
  };

  let exporting = false;
  M.exportImage = async () => {
    if (exporting) return;
    exporting = true;
    try {
      let d = M.data;
      if (M.readonly()) {
        if (!d.share?.export) throw Error('日程所有者未开放图片导出');
        // Always recheck server projection and export permission before producing an image.
        d = d.preview ? await M.api(`/api/share-preview/${M.previewId || M.state?.previewId || ''}`) : await M.api('/api/view-export');
        if (!d.share?.export) throw Error('日程所有者未开放图片导出');
      }
      if (document.fonts?.ready) await document.fonts.ready;
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      if (!ctx) throw Error('此浏览器不支持图片导出');
      const width = 1600, margin = 34, label = 70, col = 208, start = d.settings.start;
      const tasks = (typeof M.filteredTasks === 'function' ? M.filteredTasks(d) : d.tasks || []).slice();
      const courses = typeof M.filteredCourses === 'function' ? M.filteredCourses(d) : d.course_dates || [];
      const exportOptions = typeof M.exportOptions === 'function' ? M.exportOptions() : {label: M.exportFilterLabel?.() || ''};
      const allowed = date => !d.readonly || (!!d.share?.enabled && date >= d.share.start && date <= d.share.end);
      const colors = new Map((d.categories || []).map(c => [c.name,c.color]));
      const wrap = (value, max, font = '15px sans-serif') => {
        ctx.font = font; const out = []; let line = '';
        for (const ch of String(value || '')) { if (line && ctx.measureText(line + ch).width > max) { out.push(line); line = ''; } line += ch; }
        out.push(line); return out;
      };
      const timeText = t => t.start_time ? `${t.start_time}—${t.end_time || ''}` : '日期安排';
      const taskLines = (t, w, lo, hi, range) => [
        ...wrap(`${t.done ? '✓ ' : ''}${range && t.date < lo ? '← ' : ''}${t.title}${range && t.end_date > hi ? ' →' : ''}`,w),
        ...wrap(range ? `${t.date} 至 ${t.end_date}${t.start_time ? ' · ' + timeText(t) : ''}` : `${timeText(t)} · ${t.category}`,w,'12px sans-serif'),
        ...(t.due ? wrap(`截止 ${t.due.replace('T',' ')}`,w,'12px sans-serif') : [])
      ];
      const weeks = [];
      for (let w = 0; w < 18; w++) {
        const ws = add(start,w*7), we = add(ws,6);
        if (d.readonly && (!d.share.enabled || ws > d.share.end || we < d.share.start)) continue;
        const days = Array.from({length: 7}, (_,i) => {
          const date = add(ws,i), entries = [];
          if (allowed(date)) {
            tasks.filter(t => t.date === date && t.end_date === date).forEach(t => entries.push({lines: taskLines(t,col-24,date,date,false),color: colors.get(t.category) || '#7185bd',done: t.done}));
            // Nodes and deadlines keep their own dates even outside their parent's planned interval.
            tasks.forEach(t => {
              (t.milestones || []).filter(m => m.stop_at.slice(0,10) === date && (!exportOptions.hideDone || !m.done)).forEach(m => entries.push({lines: [
                ...wrap(`${m.done ? '✓' : '◆'} ${m.label || '关键节点'}`,col-24), ...wrap(t.title,col-24,'12px sans-serif'),
                ...wrap(`节点 ${m.stop_at.slice(11,16)}`,col-24,'12px sans-serif')
              ],color:colors.get(t.category)||'#7185bd',done:m.done}));
              if (!t.done && t.due?.slice(0,10) === date && (t.date !== date || t.end_date !== date)) entries.push({lines:[
                ...wrap(`截止 · ${t.title}`,col-24), ...wrap(t.due.slice(11,16),col-24,'12px sans-serif')
              ],color:colors.get(t.category)||'#7185bd'});
            });
            courses.filter(c => c.date === date && !c.cancelled).forEach(c => entries.push({lines: [
              ...wrap(`${c.cancelled ? '[已取消] ' : ''}${c.name}`,col-24), ...wrap(`${c.time}${c.room ? ' · ' + c.room : ''}`,col-24,'12px sans-serif'),
              ...(c.homework_required ? wrap(`作业${c.homework_done ? '已完成' : '待完成'}${c.homework_notes ? ' · ' + c.homework_notes : ''}`,col-24,'12px sans-serif') : []),
            ],color:'#7185bd',done:c.cancelled}));
            const count = (d.date_counts || []).find(x => x.date === date)?.count || 0;
            if (count) entries.push({lines:[`另有 ${count} 项安排`],color:'#81918b'});
            if ((d.journal || []).some(j => j.date === date && j.body)) entries.push({lines:['✎ 当日有手记'],color:'#81918b'});
          }
          return {date,entries,height:40 + entries.reduce((n,e) => n + e.lines.length*21+18,0)};
        });
        const ranges = tasks.filter(t => t.end_date > t.date && t.date <= we && t.end_date >= ws).map(t => {
          const left = Math.max(0,Math.round((new Date(t.date)-new Date(ws))/86400000)), right = Math.min(6,Math.round((new Date(t.end_date)-new Date(ws))/86400000));
          const lines = taskLines(t,(right-left+1)*col-24,ws,we,true);
          return {left,right,lines,color:colors.get(t.category)||'#7185bd',done:t.done,height:lines.length*21+18};
        });
        const dayHeight = Math.max(95,...days.map(x => x.height));
        weeks.push({w,ws,days,ranges,dayHeight,height:dayHeight+ranges.reduce((n,r) => n+r.height+6,0)+12});
      }
      const height = 220 + weeks.reduce((n,w) => n+w.height,0);
      if (height > 28000) throw Error('内容过多，请先筛选分类后再导出图片');
      canvas.width = width; canvas.height = height;
      ctx.fillStyle = '#f6f7f2'; ctx.fillRect(0,0,width,height);
      const text = (s,x,y,size = 15,color = '#253b36') => { ctx.fillStyle=color; ctx.font=`${size}px sans-serif`; ctx.fillText(s,x,y); };
      text(d.settings.name,margin,52,28);
      text(`${d.readonly ? d.share.start : start} — ${d.readonly ? d.share.end : add(start,125)} · 学期快照${exportOptions.label ? ' · ' + exportOptions.label : ''}`,margin,83,15);
      text('包含课程、任务、截止和关键节点；持续任务按周展示。',margin,110,13,'#657a71');
      ['教学周','周一','周二','周三','周四','周五','周六','周日'].forEach((s,i) => text(s,i ? margin+label+(i-1)*col+9 : margin,147,14));
      const tile = (entry,x,y,w) => {
        const h = entry.lines.length*21+12;
        ctx.fillStyle=entry.color; ctx.globalAlpha=entry.done ? .07 : .11; ctx.fillRect(x,y,w,h); ctx.globalAlpha=1;
        ctx.fillStyle=entry.color; ctx.fillRect(x,y,3,h);
        entry.lines.forEach((s,i) => text(s,x+9,y+19+i*21,i ? 12 : 15,entry.done ? '#7c8a83' : '#253b36'));
      };
      let y = 166;
      weeks.forEach(w => {
        ctx.fillStyle='#fff'; ctx.fillRect(margin,y,label+7*col,w.height);
        text(`W${String(w.w+1).padStart(2,'0')}`,margin+5,y+27,17); text(w.w>=16 ? '考试周' : '教学周',margin+5,y+49,11);
        w.days.forEach((day,i) => {
          const x=margin+label+i*col;
          if (!allowed(day.date)) { ctx.fillStyle='#f1f2ee'; ctx.fillRect(x,y,col,w.height); return; }
          if (day.date === today()) { ctx.fillStyle='#f1f8ef'; ctx.fillRect(x,y,col,w.dayHeight); }
          ctx.strokeStyle='#e3e9e2'; ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x,y+w.height); ctx.stroke();
          text(day.date.slice(5)+(day.date===today() ? ' 今天' : ''),x+8,y+24,14);
          let yy=y+35; day.entries.forEach(e => { tile(e,x+5,yy,col-10); yy+=e.lines.length*21+18; });
        });
        let ry=y+w.dayHeight;
        w.ranges.forEach(r => { tile(r,margin+label+r.left*col+5,ry,(r.right-r.left+1)*col-10); ry+=r.height+6; });
        y+=w.height; ctx.strokeStyle='#dce2da'; ctx.beginPath(); ctx.moveTo(margin,y); ctx.lineTo(width-margin,y); ctx.stroke();
      });
      if (!weeks.length) text('当前没有获准展示的日期。',margin,y+30,18);
      text(`学期手记 · 导出于 ${today()}${d.readonly ? ' · 仅含当前获准分享内容' : ' · 学期范围外任务请查阅 JSON 备份'}`,margin,height-25,12,'#7b8983');
      const blob=await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
      if (!blob) throw Error('图片生成失败，请缩小筛选范围');
      download(blob,`学期看板-${today()}.png`); M.toast('学期快照 PNG 已导出');
    } catch (error) { M.toast(error.message); }
    finally { exporting=false; }
  };
})();
