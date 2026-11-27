import './helpers/bundled-packages.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {originalKinds, pagelessKinds} from '../ui/model.js';
import {packageInfo} from '../ui/packages.js';
import {widgetSources} from '../ui/original-widgets.js';

// The view's model is a classic script (the view loads it with <script>); run it the same way.
vm.runInThisContext(readFileSync(new URL('../widgets/packages/reminders/view/model.js', import.meta.url), 'utf8'));
const M = globalThis.RemindersModel;

const now = new Date(2026, 10, 26, 10, 0);
const lists = [
  {id: 'L-HOME', title: 'Home', color: '#FF9F0A', account: 'iCloud', writable: true},
  {id: 'L-WORK', title: 'Work', color: '#0A84FF', account: 'iCloud', writable: true},
  {id: 'L-SHARED', title: 'Shared', color: '', account: 'Exchange', writable: false},
];
const item = (id, listId, extra = {}) => ({id, title: id, listId, priority: 0, completed: false, ...extra});
const snapshot = {permission: 'allowed', lists, items: [
  item('undated', 'L-HOME'),
  item('late', 'L-WORK', {due: '2026-11-24'}),
  item('today-later', 'L-WORK', {due: '2026-11-26', dueTime: '15:00'}),
  item('today-past', 'L-HOME', {due: '2026-11-26', dueTime: '08:30'}),
  item('friday', 'L-HOME', {due: '2026-11-28'}),
  item('next-year', 'L-WORK', {due: '2027-01-05'}),
  item('urgent', 'L-HOME', {priority: 1}),
  item('done', 'L-HOME', {completed: true, completedAt: '2026-11-26T09:00:00Z'}),
]};

test('Reminders is a bundled view-only widget with no connection and no page of its own', () => {
  assert.ok(originalKinds.includes('reminders'));
  assert.ok(pagelessKinds.has('reminders'));
  const info = packageInfo.get('reminders');
  assert.equal(info.collector, undefined);
  assert.deepEqual(info.permissions, ['settings', 'settings.choices', 'keyboard', 'reminders']);
  assert.deepEqual(widgetSources('reminders', '', []), [], 'no connections to open');
});

test('open reminders sort by when they are due, then priority, finished last', () => {
  const titles = [...snapshot.items].sort(M.compare).map(i => i.title);
  assert.deepEqual(titles, ['late', 'today-past', 'today-later', 'friday', 'next-year', 'urgent', 'undated', 'done']);
});

test('a reminder just checked keeps its place until the hold ends', () => {
  const rows = [item('b', 'x', {due: '2026-11-27'}), item('a', 'x', {due: '2026-11-26', completed: true, sortDone: false}), item('c', 'x')];
  assert.deepEqual(rows.sort(M.compare).map(i => i.id), ['a', 'b', 'c']);
});

test('a held reminder stays in place with finished ones hidden and in the due arrangement', () => {
  const snap = {lists, items: [item('held', 'L-HOME', {due: '2026-11-27', completed: true, sortDone: false}), item('open', 'L-HOME')]};
  const hidden = M.sections(snap, {lists: ['L-HOME'], finished: false}, now);
  assert.deepEqual(hidden[0].items.map(i => i.id), ['held', 'open'], 'not dropped under the finger');
  const due = M.sections(snap, {lists: ['*'], finished: true, group: 'due'}, now);
  assert.deepEqual(due.map(g => [g.id, g.items.map(i => i.id)]), [['week', ['held']], ['later', ['open']]], 'not moved to Finished yet');
  assert.equal(M.counts(snap, {lists: ['*']}, now).open, 1, 'the count changes at once');
});

test('due labels read relative to now and flag what is overdue', () => {
  assert.equal(M.dueLabel(item('a', 'x', {due: '2026-11-24'}), now).tone, 'overdue');
  assert.equal(M.dueLabel(item('a', 'x', {due: '2026-11-26'}), now).tone, 'today');
  assert.match(M.dueLabel(item('a', 'x', {due: '2026-11-26'}), now).text, /^Today$/);
  assert.match(M.dueLabel(item('a', 'x', {due: '2026-11-27'}), now).text, /^Tomorrow$/);
  assert.match(M.dueLabel(item('a', 'x', {due: '2026-11-25'}), now).text, /^Yesterday$/);
  assert.equal(M.dueLabel(item('a', 'x', {due: '2026-11-26', dueTime: '08:30'}), now).tone, 'overdue');
  assert.equal(M.dueLabel(item('a', 'x', {due: '2026-11-26', dueTime: '15:00'}), now).tone, 'today');
  assert.match(M.dueLabel(item('a', 'x', {due: '2027-01-05'}), now).text, /2027/);
  assert.equal(M.dueLabel(item('a', 'x'), now), null);
  assert.equal(M.dueLabel(item('a', 'x', {due: '2026-11-20', completed: true}), now).tone, '', 'finished is never overdue');
});

test('a placement shows its chosen lists, grouped by list or by due date', () => {
  const byList = M.sections(snapshot, {lists: ['*'], finished: true, group: 'lists'}, now);
  assert.deepEqual(byList.map(g => [g.title, g.items.length, g.list]), [['Home', 5, 'L-HOME'], ['Work', 3, 'L-WORK'], ['Shared', 0, '']]);
  const work = M.sections(snapshot, {lists: ['L-WORK', 'gone'], finished: true}, now);
  assert.deepEqual(work.map(g => g.id), ['L-WORK'], 'a list that no longer exists is skipped');
  const byDue = M.sections(snapshot, {lists: ['*'], finished: false, group: 'due'}, now);
  assert.deepEqual(byDue.map(g => [g.title, g.items.map(i => i.title)]), [
    ['Overdue', ['late', 'today-past']], ['Today', ['today-later']], ['Next 7 days', ['friday']], ['Later', ['next-year', 'urgent', 'undated']],
  ]);
  assert.deepEqual(M.counts(snapshot, {lists: ['*']}, now), {open: 7, today: 1, overdue: 2});
  assert.deepEqual(M.counts(snapshot, {lists: ['L-HOME']}, now), {open: 4, today: 0, overdue: 1});
});

test('new reminders go to the tapped list, the one chosen list, else the default', () => {
  assert.equal(M.addTarget(lists, ['*']), '');
  assert.equal(M.addTarget(lists, ['L-WORK']), 'L-WORK');
  assert.equal(M.addTarget(lists, ['L-WORK', 'L-HOME']), '');
  assert.equal(M.addTarget(lists, ['L-SHARED']), '', 'a read-only list never receives one');
  assert.equal(M.addTarget(lists, ['*'], 'L-HOME'), 'L-HOME');
  assert.equal(M.addTarget(lists, ['*'], 'L-SHARED'), '');
});

test('list options fit the settings.choices shape', () => {
  const options = M.listOptions([...lists, {id: 'bad id!', title: 'Bad'}]);
  assert.deepEqual(options.map(o => o.value), ['L-HOME', 'L-WORK', 'L-SHARED']);
  assert.deepEqual(options[0], {value: 'L-HOME', label: 'Home', detail: 'iCloud'});
});

test('the hero dial counts today and names what is next', () => {
  assert.deepEqual(M.progress(snapshot, {lists: ['*']}, now), {done: 1, due: 3, total: 4, ratio: 0.25});
  assert.equal(M.nextUp(snapshot, {lists: ['*']}, now).id, 'late');
  assert.equal(M.nextUp({lists, items: [item('plain', 'L-HOME')]}, {}, now), null, 'nothing due or flagged, nothing next');
  assert.deepEqual(M.relative(item('a', 'x', {due: '2026-11-26', dueTime: '10:45'}), now), {text: 'in 45 min', late: false});
  assert.deepEqual(M.relative(item('a', 'x', {due: '2026-11-26', dueTime: '13:00'}), now), {text: 'in 3 h', late: false});
  assert.deepEqual(M.relative(item('a', 'x', {due: '2026-11-24'}), now), {text: '1 d overdue', late: true});
  assert.deepEqual(M.relative(item('a', 'x', {due: '2026-11-26'}), now), {text: 'today', late: false});
  assert.equal(M.relative(item('a', 'x'), now), null);
});
