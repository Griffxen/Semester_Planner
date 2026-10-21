/* Business conflicts are explicit per-request choices, never saved task fields. */
(function (root) {
  'use strict';
  let active = false;
  const actions = {
    unfinished_milestones: {method:'PUT', flag:'force_complete', title:'完成冲突', label:'强制完成'},
    task_not_deferred: {method:'DELETE', flag:'force_delete', title:'删除冲突', label:'强制删除'}
  };
  function confirmConflict(error, action) {
    if (active) return Promise.resolve(false);
    active = true;
    const previous = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'task-conflict-dialog';
    dialog.setAttribute('aria-labelledby', 'task-conflict-title');
    dialog.setAttribute('aria-describedby', 'task-conflict-message');
    dialog.innerHTML = '<div class="task-conflict-head"><h2 id="task-conflict-title"></h2><button type="button" data-close aria-label="关闭">×</button></div><p id="task-conflict-message"></p><div class="task-conflict-actions"><button type="button" data-cancel>取消</button><button type="button" data-force></button></div>';
    dialog.querySelector('h2').textContent = action.title;
    dialog.querySelector('p').textContent = error.message;
    dialog.querySelector('[data-force]').textContent = action.label;
    document.body.append(dialog);
    return new Promise(resolve => {
      let finished = false;
      const finish = value => {
        if (finished) return;
        finished = true;
        dialog.close(); dialog.remove(); active = false;
        if (previous?.isConnected) previous.focus({preventScroll:true});
        resolve(value);
      };
      dialog.querySelector('[data-force]').onclick = () => finish(true);
      dialog.querySelector('[data-cancel]').onclick = dialog.querySelector('[data-close]').onclick = () => finish(false);
      dialog.oncancel = event => {event.preventDefault(); finish(false);};
      dialog.onclose = () => finish(false);
      dialog.showModal();
      dialog.querySelector('[data-cancel]').focus({preventScroll:true});
    });
  }
  async function request(send, path, method = 'GET', payload, confirm = confirmConflict) {
    try { return await send(path, method, payload); }
    catch (error) {
      const action = actions[error.code];
      if (error.status !== 409 || !action || method !== action.method || !/^tasks\/[^/]+$/.test(path) || payload?.[action.flag]) throw error;
      if (!await confirm(error, action)) throw Object.assign(new Error('操作已取消'), {cancelled:true});
      return send(path, method, {...payload, [action.flag]:true});
    }
  }
  root.TaskConflicts = {request};
  if (typeof module === 'object' && module.exports) module.exports = root.TaskConflicts;
})(typeof window === 'object' ? window : globalThis);
