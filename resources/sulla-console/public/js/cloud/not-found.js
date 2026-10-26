// Sulla Server app: 404 screen. Registers itself with CloudShell like any
// other screen; the shell already handled sign-in before this mounts.
(function () {
  'use strict';

  const shell = window.CloudShell;
  const states = window.CloudStates;

  function mount(ctx) {
    ctx.view.innerHTML = '<div class="content"><div class="card" data-notfound></div></div>';
    const box = ctx.view.querySelector('[data-notfound]');
    states.empty(box, {
      icon: 'search',
      title: 'Page not found',
      body: "The page you're looking for doesn't exist, or it moved.",
      actions: [{ label: 'Go to Cloud Home', href: 'index.html', primary: true }],
    });
  }

  shell.screen({ mount, reload: mount });
})();
