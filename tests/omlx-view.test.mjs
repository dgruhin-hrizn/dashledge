import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../widgets/packages/omlx/', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const GiB = 1024 ** 3;

async function helpers() {
  const context = {URL};
  context.globalThis = context;
  vm.runInNewContext(await read('view/model.js'), context);
  return context.omlxModel;
}

test('oMLX sends model actions as the command its manifest declares', async () => {
  const manifest = JSON.parse(await read('widget.json'));
  assert.deepEqual(manifest.collector.commands, ['model']);
  const view = await read('view/widget.js');
  assert.match(view, /host\.command\("model", command\)/);
  assert.doesNotMatch(view, /Zurface|Zeon|storage\.set/);
  assert.ok(!(await readdir(new URL('view/', root))).includes('touch-map.js'));
});

test('oMLX renders natively with every px size scaled', async () => {
  const manifest = JSON.parse(await read('widget.json'));
  assert.equal(manifest.view.viewport, 'native');
  assert.equal(manifest.version, '1.4.0');
  const css = (await read('view/style.css'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/calc\(\d*\.?\d+px\*var\(--px-scale,1\)\)/g, '')
    .replace(/@(media|container)[^{]*\{/g, '');
  const fixed = css.match(/(?<![\w.#-])\d*\.?\d+px\b/g) || [];
  assert.deepEqual(fixed.filter(value => !['0px', '1px'].includes(value)), []);
  const html = await read('view/index.html');
  assert.ok(html.indexOf('model.js') < html.indexOf('widget.js'), 'helpers load before the view');
  assert.doesNotMatch(html, /\sstyle=/);
});

test('oMLX maps model types to five glyphs with a language fallback', async () => {
  const M = await helpers();
  const cases = {llm: 'language', vlm: 'vision', embedding: 'embedding', reranker: 'reranker',
    audio_tts: 'speech', audio_stt: 'speech', audio_sts: 'speech', batched: 'language', '': 'language', mystery: 'language'};
  for (const [type, glyph] of Object.entries(cases)) assert.equal(M.glyphType(type), glyph, type);
  assert.equal(M.glyphType(null), 'language');
  assert.equal(M.typeLabel('vlm'), 'Vision');
  assert.equal(M.typeLabel('audio_tts'), 'Text to speech');
  assert.equal(M.typeLabel(undefined), 'LLM');
});

test('oMLX chooses a layout from the reference-equivalent frame size', async () => {
  const M = await helpers();
  assert.equal(M.layoutFor(2560, 720, 4 / 3), 'full');
  assert.equal(M.layoutFor(1920, 540, 1), 'full');
  assert.equal(M.layoutFor(930, 540, 1), 'compact');
  assert.equal(M.layoutFor(640, 540, 1), 'narrow');
  assert.equal(M.layoutFor(960, 270, 1), 'short');
  assert.equal(M.layoutFor(1920, 270, 1), 'strip');
});

test('oMLX splits memory by resident model and attributes the rest to Other', async () => {
  const M = await helpers();
  const data = {limit: 100 * GiB, poolBytes: 30 * GiB, processBytes: 34 * GiB, models: [
    {id: 'a', name: 'A', type: 'llm', loaded: true, actualBytes: 20 * GiB},
    {id: 'b', name: 'B', type: 'llm', loaded: true, actualBytes: null, estimatedBytes: 4 * GiB},
    {id: 'c', name: 'C', type: 'vlm', loaded: false, estimatedBytes: 50 * GiB},
    {id: 'd', name: 'D', type: 'vlm', loading: true, estimatedBytes: 8 * GiB},
  ]};
  const memory = M.memorySegments(data);
  assert.equal(memory.used, 34 * GiB, 'the larger of pool and process, as the collector uses for headroom');
  assert.equal(memory.free, 66 * GiB);
  assert.deepEqual(memory.segments.map(s => [s.id, s.portion, s.estimated, s.shade]), [['a', .2, false, 0], ['b', .04, true, 1]]);
  assert.equal(memory.other.bytes, 10 * GiB);
  // Estimates larger than the measured total never draw past the track or go negative.
  const over = M.memorySegments({limit: 10 * GiB, poolBytes: 4 * GiB, models: [
    {id: 'x', loaded: true, actualBytes: 8 * GiB}, {id: 'y', loaded: true, actualBytes: 6 * GiB}]});
  assert.equal(over.other, null);
  assert.ok(Math.abs(over.segments.reduce((sum, s) => sum + s.portion, 0) - 1) < 1e-9);
  assert.equal(M.memorySegments(null).used, null);
});

test('oMLX previews what loading a model adds against the same basis as fit', async () => {
  const M = await helpers();
  const data = {limit: 100 * GiB, poolBytes: 40 * GiB, processBytes: 30 * GiB};
  const fits = M.loadPreview(data, {estimatedBytes: 20 * GiB, loadFit: true});
  assert.deepEqual([fits.usedPortion, fits.addPortion, fits.fits, fits.overflow], [.4, .2, true, false]);
  const tooBig = M.loadPreview(data, {estimatedBytes: 80 * GiB, loadFit: false});
  assert.deepEqual([tooBig.addPortion, tooBig.fits, tooBig.overflow], [.6, false, true]);
  assert.equal(M.loadPreview({}, {estimatedBytes: GiB}).usedPortion, null);
});

test('oMLX counts down an idle model from its TTL and skips pinned or busy ones', async () => {
  const M = await helpers();
  assert.deepEqual({...M.countdown({loaded: true, idleTtl: 150, idleSeconds: 150})},
    {remaining: 150, total: 300, fraction: .5, expiring: false});
  assert.equal(M.countdown({loaded: true, pinned: true, idleTtl: 0, idleSeconds: 900}), null);
  assert.equal(M.countdown({loaded: true, idleTtl: 300, idleSeconds: 0, active: 1}), null);
  assert.equal(M.countdown({loaded: true, idleTtl: null}), null);
  assert.equal(M.countdown({loaded: true, idleTtl: 0, idleSeconds: 400}).expiring, true);
  assert.equal(M.countdown({loaded: true, idleTtl: 40}).fraction, null, 'no total without idle seconds');
});

test('oMLX levels the weekly heatmap and marks today in server time', async () => {
  const M = await helpers();
  assert.equal(M.heatLevel(0, 100), 0);
  assert.equal(M.heatLevel(100, 100), 4);
  assert.equal(M.heatLevel(1, 100), 1);
  assert.equal(M.heatLevel(30, 100), 3);
  assert.equal(M.heatLevel(null, 100), null);
  const hours = (hot) => Array.from({length: 24}, (_, hour) => hour === hot ? 400 : 0);
  const week = {offsetMinutes: -300, days: [{date: '2026-11-25', tokens: hours(3)}, {date: '2026-11-26', tokens: hours(9)}]};
  // 15:30 UTC is 10:30 at UTC−5.
  const grid = M.heatGrid(week, Date.UTC(2026, 10, 26, 15, 30));
  assert.equal(grid.todayKnown, true);
  const [yesterday, today] = grid.days;
  assert.equal(yesterday.today, false);
  assert.equal(yesterday.cells[23].future, false);
  assert.deepEqual([today.cells[9].level, today.cells[10].current, today.cells[11].future, today.cells[11].level], [4, true, true, null]);
  // A server whose last day is not its today gets no highlight.
  const stale = M.heatGrid(week, Date.UTC(2026, 10, 28, 15, 30));
  assert.equal(stale.days.some(day => day.today), false);
});

test('oMLX tracks bursts and request starts across samples', async () => {
  const M = await helpers();
  const row = (elapsed, tokens) => ({model: 'zeta', name: 'zeta-2.1', id: 'r1', elapsed, tokens});
  let memory = M.trackActivity(null, {at: 10_000, rate: 0, generations: []}, 120_000);
  assert.equal(memory.current, null);
  memory = M.trackActivity(memory, {at: 11_000, rate: 90, generations: [row(1, 90)]}, 120_000);
  memory = M.trackActivity(memory, {at: 12_000, rate: 110, generations: [row(2, 200)]}, 120_000);
  assert.equal(memory.markers.length, 1, 'one request keeps one marker');
  assert.equal(memory.markers[0].start, 10_000);
  assert.equal(memory.markers[0].tokens, 200);
  memory = M.trackActivity(memory, {at: 13_000, rate: 0, generations: []}, 120_000);
  assert.equal(memory.current, null);
  assert.deepEqual([memory.last.model, memory.last.rate, memory.last.peak, memory.last.end], ['zeta-2.1', 100, 110, 12_000]);
  // The last burst outlives the chart window; markers do not.
  memory = M.trackActivity(memory, {at: 400_000, rate: 0, generations: []}, 120_000);
  assert.equal(memory.last.end, 12_000);
  assert.equal(memory.markers.length, 0);
});

test('oMLX tells idle apart from zero-rate work and missing activity', async () => {
  const M = await helpers();
  const idle = {liveDecode: 0, active: 0, queued: 0, models: [{loaded: true, generating: 0, prefilling: []}]};
  assert.equal(M.activityState(idle), 'idle');
  assert.equal(M.activityState({...idle, active: 1, models: [{loaded: true, generating: 0,
    prefilling: [{done: 84, total: 6753, rate: 0}]}]}), 'prefill');
  assert.equal(M.activityState({...idle, models: [{generating: 1, generations: [{tokens: 4}]}]}), 'generating');
  assert.equal(M.activityState({...idle, liveDecode: null}), 'unavailable');
  assert.equal(M.activityState(null), 'unavailable');
  assert.equal(M.activityState({...idle, queued: 2}), 'queued');
});

test('oMLX formats clocks, durations and sparklines without locale data', async () => {
  const M = await helpers();
  assert.equal(M.clock(150), '2:30');
  assert.equal(M.clock(3725), '1:02:05');
  assert.equal(M.duration(95), '1m');
  assert.equal(M.ago(180_000), '3 min ago');
  assert.equal(M.sparkPath([1], 72, 26), '');
  assert.equal(M.sparkPath([1, 3], 72, 26), 'M2.0 24.0 L70.0 2.0');
  assert.equal(M.chartCeiling(112.4), 150);
  assert.equal(M.isLoopback('http://127.0.0.1:8000'), true);
  assert.equal(M.isLoopback('http://studio.local:8000'), false);
});

test('oMLX infers completed prefill speed only from tight, consistent samples', async () => {
  const M = await helpers();
  const before = {at: 1000, requests: 1, uptime: 10, input: 1000, cached: 0, avgPrefill: 1000};
  const after = {at: 2000, requests: 2, uptime: 11, input: 3000, cached: 0, avgPrefill: 1000};
  assert.equal(M.completedPrefillRate(before, after), 1000);
  assert.equal(M.completedPrefillRate(before, {...after, at: 9000}), null);
  assert.equal(M.completedPrefillRate(before, {...after, requests: 1}), null);
  assert.equal(M.completedPrefillRate(null, after), null);
});
