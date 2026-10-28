// SPDX-License-Identifier: GPL-2.0-or-later
export default {
  name: 'directives',
  install(app) {
    app.directive('focus', {
      mounted(_el, _binding, vnode) {
        const { components, refs } = vnode.ctx;

        if ('LabeledTooltip' in components) {
          refs.value?.focus();
        } else {
          _el.focus();
        }
      },
    });
  },
};
