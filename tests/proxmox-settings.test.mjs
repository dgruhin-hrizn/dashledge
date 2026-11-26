import './helpers/bundled-packages.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {guestRows, parseGuests} from '../ui/proxmox-guests.js';
import {widgetSources} from '../ui/original-widgets.js';

test('saved GPU guests become editable rows in VM order', () => {
  assert.deepEqual(guestRows({205: {target: 'me@b.local', identityFile: '~/.ssh/b'}, 101: 'root@a.local'}), [
    {vmid: '101', target: 'root@a.local', identityFile: ''},
    {vmid: '205', target: 'me@b.local', identityFile: '~/.ssh/b'},
  ]);
  assert.deepEqual(guestRows(undefined), []);
});

test('edited rows save in the shape the collectors read', () => {
  const rows = [
    {vmid: ' 101 ', target: 'root@a.local', identityFile: ''},
    {vmid: '', target: '', identityFile: ''},
    {vmid: '205', target: 'b.local', identityFile: '/Users/me/.ssh/id'},
  ];
  assert.deepEqual(parseGuests(rows), {101: 'root@a.local', 205: {target: 'b.local', identityFile: '/Users/me/.ssh/id'}});
  assert.deepEqual(parseGuests(guestRows(parseGuests(rows))), parseGuests(rows), 'round trip');
});

test('invalid guests are refused with the row named', () => {
  assert.throws(() => parseGuests([{vmid: '42', target: 'a.local'}]), /VM ID/);
  assert.throws(() => parseGuests([{vmid: '101', target: 'a.local'}, {vmid: '101', target: 'b.local'}]), /listed twice/);
  assert.throws(() => parseGuests([{vmid: '101', target: 'root@a b'}]), /VM 101’s SSH destination/);
  assert.throws(() => parseGuests([{vmid: '101', target: '-oProxyCommand=x'}]), /SSH destination/);
  assert.throws(() => parseGuests([{vmid: '101', target: 'a.local', identityFile: 'id_rsa'}]), /full path/);
});

test('ComfyUI pairs a worker with an edited Proxmox guest', () => {
  const sources = [
    {id: 'c1', kind: 'comfy', name: '', address: 'http://worker.local:8188'},
    {id: 'p1', kind: 'proxmox', name: 'PVE', address: 'https://pve.local:8006',
      gpuGuests: parseGuests([{vmid: '120', target: 'root@worker.local', identityFile: '~/.ssh/pve'}])},
  ];
  assert.deepEqual(widgetSources('comfy', 'c1', sources)[0].gpuGuests, {worker: {target: 'root@worker.local', identityFile: '~/.ssh/pve'}});
});
