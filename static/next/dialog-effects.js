/* Desktop dialog appearance is a local preference, separate from account data. */
(function (root) {
  'use strict';
  function mount(container) {
    if (!container || !document.body.classList.contains('next-ui')) return;
    const existing = container.querySelector('[data-dialog-effects]');
    if (existing) return existing;
    const row = document.createElement('label');
    row.className = 'dialog-effects';
    row.dataset.dialogEffects = '';
    row.textContent = '窗口背景';
    const select = document.createElement('select');
    select.innerHTML = '<option value="blur">模糊</option><option value="dim">仅变暗</option>';
    select.value = document.documentElement.dataset.dialogBackdrop === 'dim' ? 'dim' : 'blur';
    select.onchange = () => {
      const value = select.value === 'dim' ? 'dim' : 'blur';
      document.documentElement.dataset.dialogBackdrop = value;
      document.querySelectorAll('[data-dialog-effects] select').forEach(control => {control.value = value;});
      try {root.localStorage.setItem('semester-dialog-backdrop', value);} catch (error) {}
    };
    row.append(select);
    container.append(row);
    return row;
  }
  root.DialogEffects = {mount};
})(window);
