// Landing page behaviour: scroll reveal, the ruler strip, the how-it-works stepper, and the real session demo (a recorded
// real session replayed in the real session component).
import { el, icon, tidy } from './dom.js';
import { memoryView, mountSession, usageView } from './session-ui.js';
import { replay } from './transports.js';

// scroll reveal: content is only hidden when this script is running (see .js .rv), so nothing is lost without it
const reveal = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); reveal.unobserve(e.target); } }), { threshold: 0.12 });
document.querySelectorAll('.rv').forEach((n) => reveal.observe(n));

// the ruler strip loops by repeating its content once
const ruler = document.getElementById('ruler');
ruler.append(...[...ruler.children].map((n) => n.cloneNode(true)));

// the stepper: the step nearest the middle of the screen is current, and its picture is shown
const steps = [...document.querySelectorAll('.step')];
const panels = [...document.querySelectorAll('.panel-step')];
function setStep(n) {
  steps.forEach((s) => (s.dataset.step === String(n) ? s.setAttribute('aria-current', 'step') : s.removeAttribute('aria-current')));
  panels.forEach((p) => p.classList.toggle('on', p.dataset.step === String(n)));
}
setStep(1);
const stepper = new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) setStep(e.target.dataset.step); }), { rootMargin: '-40% 0px -50% 0px' });
steps.forEach((s) => stepper.observe(s));

// the demo and the pictures beside the features all come from one recorded real session
const data = await (await fetch('/data/demo-session.json')).json();
const ui = mountSession(document.getElementById('hero-session'), { layout: 'compact', readOnlyNote: 'Recorded session' });
ui.setConn('live');
replay(data, { onMessage: ui.handle, onStart: ui.reset });

const last = (type) => data.events.map((e) => e.msg).filter((m) => m.type === type).at(-1);
const prompts = data.events.map((e) => e.msg).filter((m) => m.user && m.user !== 'agent' && m.user !== 'system');

const orders = document.getElementById('vis-orders');
const ticket = (m, n, cls = '') => el('div', { class: `ticket ${cls}`.trim() }, el('div', { class: 'head' }, el('span', { class: 'who', text: m.user }), el('span', { class: 'meta', text: `Order ${n}` })), el('p', { class: 'sx-order', text: m.text }));
orders.append(
  el('div', { class: 'sx-now sx-now--busy' }, icon('busy'), el('span', { class: 'sx-now-text' }, el('b', { text: `The kitchen is on ${prompts[1].user}'s order` }), el('span', { class: 'muted', text: ` “${tidy(prompts[1].text, 40)}”` })), el('span', { class: 'meta', text: '0:08 · 1 tool call' })),
  ticket(prompts[0], 1),
  ticket(prompts[1], 2, 'ticket--now'),
  el('div', { class: 'ticket ticket--queued' }, el('div', { class: 'head' }, el('span', { class: 'who', text: 'You, just now' }), el('span', { class: 'meta', text: 'Queued' })), el('p', { class: 'muted', text: 'The agent is working on Jon\'s request. Your message is queued behind it and will be sent when it finishes.' })));

document.getElementById('vis-memory').append(el('div', { class: 'head-row' }, icon('memory'), el('span', { class: 'label', text: 'Project memory' })), ...memoryView(last('memory')));
document.getElementById('vis-usage').append(el('div', { class: 'head-row' }, icon('usage'), el('span', { class: 'label', text: 'Usage' })), ...usageView({ ...last('usage'), budget: 5, spent: last('usage').rows.reduce((a, r) => a + (r.costUsd ?? 0), 0), me: { cap: 200000, usedToday: 21000 } }), el('p', { class: 'muted sx-fine', text: 'The turns are real. The budget and cap are examples of what an owner can set.' }));
