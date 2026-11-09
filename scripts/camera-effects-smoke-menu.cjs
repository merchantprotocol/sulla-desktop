// SPDX-License-Identifier: GPL-2.0-or-later
const assert = require('node:assert/strict');
const { createApp, ref, nextTick } = require('vue');
const MenuHarness = require('./MenuHarness').default;

/** risk: production reachability, recording lock, honest status and option accuracy. */
class ContextMenuSmoke {
  async mount(mediaSources) {
    this.media = mediaSources;
    this.state = { mediaSources, recording: ref(false), statusMessage: ref('') };
    this.element = document.createElement('div');
    document.body.appendChild(this.element);
    this.app = createApp(MenuHarness, { state: this.state });
    this.vm = this.app.mount(this.element);
    await this.open();
    assert.ok(this.element.querySelector('[data-menu-id="effect-framing"]'), 'MENU_REACHABILITY_SENTINEL: missing production effects entry');
    // The visual slot name is not its source type after swapping assignments.
    this.element.querySelector('.sbs-camera').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await this.settle();
    assert.equal(this.vm.ctxMenu.title, 'Screen');
    assert.ok(!this.vm.cameraContextItems.some(item => item.id === 'effect-framing'), 'MENU_CAMERA_ONLY_SENTINEL');
    for (const selector of ['.screen-preview', '.cam-bubble']) {
      this.element.querySelector(selector).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      await this.settle();
      assert.equal(this.vm.ctxMenu.title, 'Camera', 'MENU_SLOT_REACHABILITY_SENTINEL');
      assert.ok(this.element.querySelector('[data-menu-id="effect-framing"]'));
    }
    assert.deepEqual(mediaSources.camera.effectOptions, { autoFrame: false, soften: 0, backgroundBlur: 0 });
    for (const id of ['effect-framing', 'effect-soften', 'effect-backgroundBlur']) {
      assert.equal(this.vm.cameraContextItems.find(item => item.id === id).active, false, 'MENU_DEFAULT_OFF_SENTINEL');
    }
  }

  async settle() { await nextTick(); await nextTick(); await new Promise(resolve => setTimeout(resolve, 20)); }
  async until(predicate) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Menu option update did not settle');
      await this.settle();
    }
    await this.settle();
  }
  async open() {
    this.element.querySelector('.fullscreen-camera').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
    await this.until(() => this.vm.ctxMenu.visible);
    assert.equal(this.vm.ctxMenu.title, 'Camera', 'MENU_REACHABILITY_SENTINEL');
  }
  async framing() {
    await this.open();
    this.element.querySelector('[data-menu-id="effect-framing"]').click();
    await this.until(() => this.media.camera.effectOptions.autoFrame && this.media.cameraStream.value !== this.media.camera.rawStream);
  }
  async lock() {
    this.state.recording.value = true;
    await this.open();
    const previous = this.media.cameraStream.value;
    const button = this.element.querySelector('[data-menu-id="effect-framing"]');
    assert.equal(button.disabled, true, 'MENU_LOCK_SENTINEL');
    button.click();
    // Reject a stale menu action too, even before the recording ref updates.
    this.vm.cameraContextItems.find(item => item.id === 'effect-framing').action();
    await this.settle();
    assert.equal(this.media.cameraStream.value, previous);
    assert.equal(this.media.camera.effectOptions.autoFrame, true);
    this.vm.ctxMenu.visible = false;
  }
  async strengths() {
    this.state.recording.value = false;
    for (const [key, value] of [['soften', 0.2], ['backgroundBlur', 0.15], ['soften', 0.5], ['backgroundBlur', 0.35], ['soften', 0], ['backgroundBlur', 0]]) {
      await this.open();
      const parent = [...this.element.querySelectorAll('.ctx-menu-sub-parent')].find(element => element.textContent.includes(key === 'soften' ? 'Appearance softening' : 'Light background blur'));
      parent.dispatchEvent(new MouseEvent('mouseenter'));
      await this.settle();
      const button = this.element.querySelector('[data-menu-id="' + key + '-' + value + '"]');
      assert.ok(button, 'MENU_STRENGTH_REACHABILITY_SENTINEL');
      button.click();
      await this.until(() => this.media.camera.effectOptions[key] === value && this.vm.cameraContextItems.find(item => item.id === 'effect-framing').disabled === false);
    }
  }
  async failure(trigger, initialization = false) {
    const before = this.media.cameraStream.value;
    trigger();
    if (initialization) {
      await this.open();
      this.element.querySelector('[data-menu-id="effect-framing"]').click();
    }
    await this.until(() => !this.media.camera.effectOptions.autoFrame && this.vm.cameraContextItems.find(item => item.id === 'effect-framing').disabled === false);
    assert.match(this.media.cameraEffectError.value, /Original camera video/);
    for (const id of ['effect-framing', 'effect-soften', 'effect-backgroundBlur']) {
      assert.equal(this.vm.cameraContextItems.find(item => item.id === id).active, false, 'MENU_FAILURE_STATUS_SENTINEL');
    }
    if (!initialization) assert.equal(this.media.cameraStream.value, before, 'Inference failure replaced shared track');
    else assert.equal(this.media.cameraStream.value, this.media.camera.rawStream, 'Initialization failure did not use original camera');
  }
  close() { this.app?.unmount(); this.app = undefined; this.element?.remove(); }
}
module.exports = { ContextMenuSmoke };
