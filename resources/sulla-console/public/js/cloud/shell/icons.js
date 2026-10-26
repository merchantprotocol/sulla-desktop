// Sulla Cloud app: icon set. The Desktop icons (FilesBrowser.vue +
// MyAccount.vue) as used by the approved mockup, plus a few Cloud glyphs in
// the same stroke style. CloudIcons.get(name) returns SVG markup.
(function () {
  'use strict';

  const S = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const I = {
    folderLine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 19h5a4.5 4.5 0 0 0-3-4.2"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.8l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 17l-5.2 2.8 1-5.8L3.6 9.9l5.8-.8z"/></svg>',
    agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="13.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="13.5" r="1.2" fill="currentColor" stroke="none"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4M8.2 13.2l7.6 4"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4 4 0 0 1-.5-7.96A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 7H7z"/></svg>',
    syncOnline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4 4 0 0 1-.5-7.96A5.5 5.5 0 0 1 17 9.5a3.5 3.5 0 0 1 .5 7H7z"/></svg>',
    home: S('<path d="M4 11l8-6.5L20 11"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>'),
    key: S('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2M14 9l2 2"/>'),
    workflow: S('<rect x="3" y="4" width="6" height="5" rx="1.5"/><rect x="15" y="4" width="6" height="5" rx="1.5"/><rect x="9" y="15" width="6" height="5" rx="1.5"/><path d="M6 9v1.5a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9M12 12.5V15"/>'),
    building: S('<rect x="4" y="3.5" width="11" height="17" rx="1.5"/><path d="M15 9h4a1 1 0 0 1 1 1v10.5h-5M8 7.5h3M8 11h3M8 14.5h3M9 20.5v-3h1"/>'),
    laptop: S('<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M2.5 18.5h19"/>'),
    mini: S('<rect x="4" y="9" width="16" height="7" rx="2.5"/><path d="M8 12.5h.01"/>'),
    phone: S('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'),
    message: S('<path d="M4 5h16v11H9l-5 4z"/>'),
    check: S('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    chevDown: S('<path d="M7 10l5 5 5-5"/>'),
    sun: S('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'),
    moon: S('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
    user: S('<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
    bell: S('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>'),
    arrowLeft: S('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
    help: S('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7M12 17h.01"/>'),
    apple: S('<path d="M16.7 12.8c0-2.2 1.8-3.3 1.9-3.4a4.2 4.2 0 0 0-3.3-1.8c-1.4-.1-2.7.8-3.4.8-.7 0-1.8-.8-3-.8-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2-.1 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3.9-1.3 1.2-2.6 1.2-2.7-.1 0-2.5-1-2.5-3.7zM14.4 6.1c.6-.8 1.1-1.9 1-3.1-1 .1-2.2.7-2.9 1.5-.6.7-1.1 1.8-1 2.9 1.1.1 2.2-.5 2.9-1.3z"/>'),
    shield: S('<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>'),
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="6.5" rx="2"/><rect x="4" y="13.5" width="16" height="6.5" rx="2"/><path d="M8 7.25h.01M8 16.75h.01"/></svg>',
    bolt: S('<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>'),
    globe: S('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/>'),
    card: S('<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/>'),
    note: S('<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  };
  // Use Cases subnav glyphs (mockup <symbol> set).
  I.lib = S('<path d="M5 4h3v16H5zM10 4h3v16h-3zM15.5 4.5l2.9-.8 3.6 15.4-2.9.8z"/>');
  I.up = S('<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5M5 4h14"/>');
  // Use Cases install dialog + parts glyphs.
  I.down = S('<path d="M12 5v12M6.5 12.5 12 18l5.5-5.5M5 20h14"/>');
  I.box = S('<path d="M3.5 8l8.5-4.5L20.5 8l-8.5 4.5zM3.5 8v8l8.5 4.5M20.5 8v8l-8.5 4.5m0-9v9"/>');
  I.plug = S('<path d="M9 3v5M15 3v5M6.5 8h11l-1 6a5 5 0 0 1-9 0z"/><path d="M12 17v4"/>');
  I.back = S('<path d="M15 5l-7 7 7 7"/>');
  I.screen = S('<rect x="3.5" y="5" width="17" height="12" rx="1.8"/><path d="M8 20h8M12 17v3"/>');

  window.CloudIcons = {
    get: (name) => I[name] || '',
    has: (name) => Object.prototype.hasOwnProperty.call(I, name),
  };
})();
