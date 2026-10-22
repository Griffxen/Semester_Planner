/* Independent work areas share the existing account, dialogs and course APIs. */
(() => {
  'use strict';
  const main = document.querySelector('#app > main'), sidebar = document.querySelector('.next-sidebar');
  const home = document.createElement('section'); home.id = 'home-workspace'; home.setAttribute('aria-label', '首页');
  const deferred = $('#deferred-workspace'), banner = $('#share-banner');
  for (const child of [...main.children]) if (child !== deferred && child !== banner) home.append(child);
  main.append(home);
  const design = document.createElement('section'); design.id = 'course-design-workspace'; design.hidden = true; design.setAttribute('aria-label', '课表设计'); main.append(design);
  const courseEntry = $('#timetable-button'); courseEntry.type = 'button';
  document.querySelector('.nav-tools').prepend(courseEntry);
  const homeEntry = document.createElement('button'); homeEntry.id = 'workspace-home'; homeEntry.type = 'button'; homeEntry.dataset.icon = 'grid'; homeEntry.textContent = '首页';
  const designEntry = document.createElement('button'); designEntry.id = 'workspace-courses'; designEntry.type = 'button'; designEntry.dataset.icon = 'calendar'; designEntry.textContent = '课表设计';
  $('#sharing-button').before(homeEntry, designEntry);
  const records = {home:{top:0, category:'', query:'', folds:new Map()}, courses:{top:0}, deferred:{top:0, category:'', query:''}};
  let displayed = 'home', controller = null, mounting = null, generation = 0, navigation = 0, designerOpened = false, owner = '', previewReturn = null, restoring = false;
  const principal = () => String(state?.user?.id ?? state?.user?.name ?? '');
  function remember(page) {
    records[page].top = window.scrollY;
    if (page === 'home' || page === 'deferred') {records[page].category = filter; records[page].query = $('#search').value;}
    if (page === 'home') records.home.folds = new Map([...$('#calendar').querySelectorAll('details[id]')].map(node => [node.id, node.open]));
  }
  function restoreFilters(page) {
    if (page === 'courses') return;
    filter = records[page].category || ''; $('#search').value = records[page].query || '';
  }
  function restoreFolds() {
    $('#calendar').querySelectorAll('details[id]').forEach(node => {if (records.home.folds.has(node.id)) node.open = records.home.folds.get(node.id);});
  }
  let homeLayoutFrame = 0;
  function scheduleHomeLayout() {
    cancelAnimationFrame(homeLayoutFrame);
    if (workspacePage !== 'home' || home.hidden) return;
    homeLayoutFrame = requestAnimationFrame(() => {
      homeLayoutFrame = 0;
      if (workspacePage !== 'home' || home.hidden) return;
      setToolbarHeight(); layoutRanges();
    });
  }
  $('#calendar').addEventListener('toggle', event => {
    if (event.target.matches('details.semester-week') && event.target.open) scheduleHomeLayout();
  }, true);
  function panels() {
    home.hidden = workspacePage !== 'home'; design.hidden = workspacePage !== 'courses'; deferred.hidden = workspacePage !== 'deferred';
    designEntry.hidden = !!state?.readonly;
    if (workspacePage === 'courses') $('#category-section').hidden = true;
    for (const [page, button] of [['home',homeEntry],['courses',designEntry],['deferred',$('#deferred-button')]]) {
      const active = workspacePage === page; button.classList.toggle('selected', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    sidebar.dataset.workspace = workspacePage;
  }
  function resetDesigner() {
    ++generation; ++navigation; controller?.destroy(); controller = null; mounting = null; designerOpened = false; design.replaceChildren();
  }
  async function designer() {
    if (state?.readonly || !state) return null;
    if (controller) return controller;
    if (!mounting) {
      const ticket = generation;
      design.innerHTML = '<p class="workspace-loading" role="status">正在读取课表设计器…</p>';
      const host = document.createElement('div'); design.append(host);
      mounting = CourseDesigner.mount(host, {session:state,
        onSaved:async () => {if (state && !state.readonly) await refresh();},
        onNavigate:async target => {
          if (target.tab === 'changes') {
            if (!await show('home')) return;
            await courseEntry.onclick(); courseTab = 'changes'; nextCoursePreview();
          } else await show('home');
        }
      }).then(instance => {
        if (ticket !== generation) {instance.destroy(); return null;}
        controller = instance; design.querySelector(':scope > .workspace-loading')?.remove(); return instance;
      }).catch(error => {if (ticket === generation) {design.innerHTML = '<p class="workspace-loading" role="alert"></p>';design.querySelector('p').textContent = error.message;} throw error;})
        .finally(() => {if (ticket === generation) mounting = null;});
    }
    return mounting;
  }
  function updateUrl(page, selection, replace) {
    const url = new URL(location.href); url.searchParams.set('page', page); url.searchParams.delete('courses');
    if (page !== 'courses') {url.searchParams.delete('personal');url.searchParams.delete('template');}
    else if (selection) {
      url.searchParams.delete('personal');url.searchParams.delete('template');
      if (selection.personal) url.searchParams.set('personal','1');
      else if (selection.templateId) url.searchParams.set('template',selection.templateId);
    }
    if (url.href !== location.href) history[replace ? 'replaceState' : 'pushState'](null,'',url);
  }
  async function show(page, options = {}) {
    if (!state) return false;
    if (!['home','courses','deferred'].includes(page) || state.readonly) page = 'home';
    if (busy || courseSaving || shareBusy || confirmationPending || controller?.isBusy()) {toast('正在保存，请稍候');return false;}
    const ticket = ++navigation;
    const changed = workspacePage !== page;
    if (changed) {remember(workspacePage); workspacePage = page; restoreFilters(page);}
    if (options.view) {nextView = options.view;nextWeek = options.date || today();}
    restoring = true; render(); restoring = false; displayed = page;
    if (options.history !== false) updateUrl(page,options.design,options.replace);
    if (changed) requestAnimationFrame(() => window.scrollTo(0,records[page].top));
    if (page === 'courses') {
      try {
        const instance = await designer();
        if (!instance || ticket !== navigation) return false;
        if (options.design || !designerOpened) {await instance.open(options.design || {personal:true});designerOpened = true;}
      } catch (error) {toast(error.message);return false;}
    }
    return true;
  }
  window.PlannerWorkspace = {show};
  homeEntry.onclick = () => show('home'); designEntry.onclick = () => show('courses');
  $('#deferred-button').onclick = () => show('deferred');
  $('#import-courses').onclick = $('#save-courses').onclick = () => {DesktopModal.reset();show('courses',{design:{personal:false}});};
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || link.target === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href,location.href);
    if (url.origin !== location.origin || !['/timetables','/timetables/'].includes(url.pathname)) return;
    event.preventDefault(); if (!state || state.readonly) return;
    DesktopModal.reset();show('courses',{design:{personal:url.searchParams.get('personal') === '1',templateId:url.searchParams.get('template') || undefined}});
  });
  const previousRender = render;
  render = function (...args) {
    if (!state) return;
    if (!state.readonly && owner !== principal()) {
      if (owner) {resetDesigner(); workspacePage = 'home';records.home.category = records.home.query = records.deferred.category = records.deferred.query = '';filter = '';$('#search').value = '';}
      owner = principal();
    }
    if (state.readonly && workspacePage !== 'home') {
      remember(workspacePage);if (state.preview) previewReturn = workspacePage;
      workspacePage = 'home';restoreFilters('home');updateUrl('home',null,true);
    } else if (!state.readonly && previewReturn) {workspacePage = previewReturn;previewReturn = null;restoreFilters(workspacePage);updateUrl(workspacePage,null,true);}
    if (!restoring && displayed === 'home' && workspacePage === 'home') records.home.folds = new Map([...$('#calendar').querySelectorAll('details[id]')].map(node => [node.id,node.open]));
    previousRender(...args);restoreFolds();panels();displayed = workspacePage;scheduleHomeLayout();
  };
  const oldConfirm = askConfirm;
  askConfirm = function (message,...args) {
    if (message === '确定退出登录吗？' && controller?.isDirty()) message = '课表还有未保存的修改，草稿会保留在此浏览器。确定退出登录吗？';
    return oldConfirm(message,...args);
  };
  const oldLogout = $('#logout-button').onclick;
  $('#logout-button').onclick = async () => {
    if (controller?.isBusy()) {toast('课表正在保存，请稍候');return;}
    await oldLogout();
    if (!state) {resetDesigner();owner = '';workspacePage = 'home';displayed = 'home';updateUrl('home',null,true);}
  };
  function route(replace = false) {
    const query = new URLSearchParams(location.search), page = query.get('courses') === 'adjustments' ? 'home' : query.get('page') || 'home';
    const designTarget = query.get('personal') === '1' ? {personal:true} : query.get('template') ? {personal:false,templateId:query.get('template')} : undefined;
    return show(page,{history:replace,replace,design:page === 'courses' ? designTarget : undefined});
  }
  window.addEventListener('popstate', () => route());
  let initialRoute = true;
  const renderWithPages = render;
  render = function (...args) {
    renderWithPages(...args);
    if (state && initialRoute) {initialRoute = false;queueMicrotask(() => route(true));}
  };
  decorateIcons();if (state) render();else panels();
})();
