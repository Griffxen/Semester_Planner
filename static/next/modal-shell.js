/* One native modal; existing dialog objects retain their forms and local state. */
(function (root) {
  'use strict';
  function install(options = {}) {
    const nativeOpen = HTMLDialogElement.prototype.showModal;
    const nativeClose = HTMLDialogElement.prototype.close;
    const shell = document.createElement('dialog');
    shell.id = 'modal-shell';
    const stage = document.createElement('div');
    stage.className = 'modal-stage'; shell.append(stage); document.body.append(shell);
    const frames = [];
    let animation, generation = 0, replacement = false, serial = 0;
    const currentFrame = () => frames.at(-1);
    const currentView = () => currentFrame()?.view || null;
    const has = view => frames.some(frame => frame.view === view);
    const path = (view, node) => {
      if (!node || !view.contains(node)) return null;
      const steps = [];
      while (node && node !== view) {steps.unshift([...node.parentElement.children].indexOf(node)); node = node.parentElement;}
      return node === view ? steps : null;
    };
    const locate = (view, steps) => steps?.reduce((node, step) => node?.children[step], view);
    function remember(frame) {
      frame.focus = document.activeElement;
      frame.focusPath = path(frame.view, frame.focus);
      frame.scrolls = [frame.view, ...frame.view.querySelectorAll('*')]
        .filter(node => node.scrollTop || node.scrollLeft)
        .map(node => ({node, path:path(frame.view, node), top:node.scrollTop, left:node.scrollLeft}));
      frame.stamp = options.stamp?.(frame.view);
    }
    function restore(frame) {
      for (const saved of frame.scrolls || []) {
        const node = saved.node.isConnected ? saved.node : locate(frame.view, saved.path);
        if (node) {node.scrollTop = saved.top; node.scrollLeft = saved.left;}
      }
      const focus = frame.focus?.isConnected ? frame.focus : locate(frame.view, frame.focusPath);
      if (focus && !focus.disabled && !focus.closest('[hidden]')) focus.focus({preventScroll:true});
      else if (!frame.view.contains(document.activeElement) || document.activeElement === frame.view) {
        const target = frame.view.querySelector('[autofocus],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])');
        target?.focus({preventScroll:true});
      }
    }
    function measure(view) {
      const saved = view.getAttribute('style');
      view.classList.remove('modal-view');
      Object.assign(view.style, {position:'fixed', left:'-10000px', top:'0', right:'auto', bottom:'auto', margin:'0', visibility:'hidden', scrollbarGutter:'auto'});
      const display = getComputedStyle(view).display;
      const rect = view.getBoundingClientRect();
      if (saved === null) view.removeAttribute('style'); else view.setAttribute('style', saved);
      view.classList.add('modal-view');
      view.style.setProperty('--modal-view-display', display);
      return {width:rect.width || 600, height:rect.height || 500};
    }
    function layout(frame, resize = false) {
      if (frame !== currentFrame()) return;
      const from = shell.getBoundingClientRect();
      if (!frame.size || resize) frame.size = measure(frame.view);
      const width = Math.min(frame.size.width, Math.max(1, innerWidth - 32));
      let height = Math.min(frame.size.height, Math.max(1, innerHeight - 32));
      const target = {width:width+'px', height:height+'px', left:(innerWidth-width)/2+'px', top:(innerHeight-height)/2+'px'};
      animation?.cancel();
      Object.assign(shell.style, target);
      // Keep text at its final layout while the outer box changes size.
      const style = getComputedStyle(shell);
      const borderY = parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth);
      Object.assign(stage.style, {width:Math.max(0,width-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth))+'px', height:Math.max(0,height-borderY)+'px'});
      const overflow = frame.view.scrollHeight-frame.view.clientHeight;
      if (overflow > 1 && height < innerHeight-32 && getComputedStyle(frame.view).overflowY !== 'hidden') {
        height = Math.min(innerHeight-32, height+overflow);
        frame.size.height = height;
        target.height = height+'px'; target.top = (innerHeight-height)/2+'px';
        shell.style.height = target.height; shell.style.top = target.top;
        stage.style.height = Math.max(0,height-borderY)+'px';
      }
      if (from.width && from.height && !matchMedia('(prefers-reduced-motion: reduce)').matches &&
          (Math.abs(from.width-width)>1 || Math.abs(from.height-height)>1 || Math.abs(from.top-parseFloat(target.top))>1)) {
        animation = shell.animate([{width:from.width+'px',height:from.height+'px',left:from.left+'px',top:from.top+'px'}, target], {duration:160,easing:'ease-out'});
      }
    }
    function activate(frame, resumed = false) {
      for (const item of frames) {item.view.hidden = item !== frame; item.view.inert = item !== frame;}
      if (!frame) return;
      if (resumed && frame.stamp !== options.stamp?.(frame.view)) options.resume?.(frame.view);
      if (frame !== currentFrame()) return;
      const ticket = ++generation;
      queueMicrotask(() => {
        if (ticket !== generation || frame !== currentFrame()) return;
        const title = frame.view.querySelector('h1,h2,h3');
        if (title) {if (!title.id) title.id = 'modal-view-title-'+(++serial); shell.setAttribute('aria-labelledby', title.id);}
        else {shell.removeAttribute('aria-labelledby'); shell.setAttribute('aria-label', '窗口');}
        layout(frame, !resumed);
        restore(frame);
        // A cancelled mutation re-enables its buttons in the following microtask.
        requestAnimationFrame(() => {if (frame === currentFrame() && !frame.view.contains(document.activeElement)) restore(frame);});
      });
    }
    function open(view) {
      if (has(view)) return;
      const parent = currentFrame();
      if (parent) remember(parent);
      const frame = {view, opener:document.activeElement};
      view.classList.add('modal-view');
      view.setAttribute('role', 'presentation');
      view.setAttribute('open', '');
      stage.append(view); frames.push(frame); activate(frame);
      if (!shell.open) {
        shell.style.cssText = 'width:600px;height:500px;left:calc(50vw - 300px);top:calc(50vh - 250px)';
        document.documentElement.classList.add('modal-shell-open');
        nativeOpen.call(shell);
      }
    }
    function finishShell() {
      ++generation; animation?.cancel();
      document.documentElement.classList.remove('modal-shell-open');
      if (shell.open) nativeClose.call(shell);
    }
    function close(view, value) {
      const index = frames.findIndex(frame => frame.view === view);
      if (index < 0) return;
      const frame = frames[index], wasCurrent = frame === currentFrame();
      frames.splice(index, 1);
      view.removeAttribute('open'); view.hidden = true; view.inert = true;
      if (value !== undefined) view.returnValue = String(value);
      if (wasCurrent) {
        if (currentFrame()) activate(currentFrame(), true);
        else if (!replacement) finishShell();
      }
      view.dispatchEvent(new Event('close'));
      if (!currentFrame() && frame.opener?.isConnected && !frame.opener.disabled) frame.opener.focus({preventScroll:true});
    }
    function reset() {
      const removed = frames.splice(0);
      for (const frame of removed) {frame.view.removeAttribute('open'); frame.view.hidden=true; frame.view.inert=true;}
      finishShell();
      for (const frame of removed.reverse()) frame.view.dispatchEvent(new Event('close'));
    }
    function replace(opener) {
      replacement = true;
      try {if (currentView()) close(currentView()); opener();}
      finally {replacement = false; if (!frames.length) finishShell();}
    }
    shell.addEventListener('cancel', event => {
      event.preventDefault();
      const view = currentView(); if (!view) return;
      const cancel = new Event('cancel', {cancelable:true});
      view.dispatchEvent(cancel);
      if (!cancel.defaultPrevented && view === currentView() && options.canDismiss?.(view) !== false) close(view);
    });
    HTMLDialogElement.prototype.showModal = function () {if (this === shell) return nativeOpen.call(this); open(this);};
    HTMLDialogElement.prototype.close = function (value) {if (this === shell) reset(); else close(this, value);};
    window.addEventListener('resize', () => {if (currentFrame()) layout(currentFrame(), true);});
    return {currentView, has, reset, replace, shell};
  }
  root.ModalShell = {install};
})(window);
