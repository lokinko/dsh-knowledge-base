// Isolated DSH host adapter for browser verification. Never loaded in the plugin bundle.
import React from 'react';
import {createRoot} from 'react-dom/client';

const h = React.createElement;
const root = createRoot(document.getElementById('root'));
const slots = new Map(), catalogs = new Map(), disposers = [];
const language = new URL(location.href).searchParams.get('lang') || 'zh';
const snapshot = {active: language};
const selected = {sessionId: 'fixture-session', ready: Promise.resolve(), release() {}};
const slotProps = {
  SessionProvider: ({children}) => h(React.Fragment, null, children),
  renderSlot(name, props) {
    const render = slots.get(name);
    return render ? h(render, {
      ...props,
      useSession: selector => selector({running: false}),
      renderFactorySlot: () => h('div', {className: 'native-fixture', 'data-testid': 'native-conversation'},
        h('p', null, language === 'zh' ? '一起整理这篇笔记。' : 'Let’s work on this note together.'),
        h('textarea', {'aria-label': 'Native conversation input', placeholder: language === 'zh' ? '继续对话…' : 'Continue the conversation…'}),
        h('button', {className: 'btn', type: 'button'}, language === 'zh' ? '发送' : 'Send')),
    }) : null;
  },
};
const ctx = {
  effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  locale: {
    register(namespace, lang, dict) { catalogs.set(lang, dict); return () => catalogs.delete(lang); },
    bind: () => key => catalogs.get(language)?.[key] || key,
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  },
  slots: {
    inject(name, fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    register(slot, render) { slots.set(slot.name, render); return () => slots.delete(slot.name); },
  },
  layout: {selectPanel() { window.__fixtureBack = true; }},
  sessions: {async refresh() {}, retain: sessionId => ({...selected, sessionId})},
};
window.__ModuleLoader__ = {
  load(definition) {
    definition.factory(name => {
      if (name !== 'react') throw new Error('Unexpected host module: ' + name);
      return React;
    }).apply(ctx);
    const Page = slots.get('main');
    if (!Page) throw new Error('Plugin did not register a main page');
    root.render(h(Page, slotProps));
  },
};
window.__disposeFixture = () => {
  root.unmount();
  for (const dispose of disposers.reverse()) dispose();
};
