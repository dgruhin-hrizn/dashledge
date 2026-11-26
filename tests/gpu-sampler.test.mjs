import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNvidia, parseAmdSmi, parseRocm, parseXpu, parseIoreg, parseWindows, remoteSampler, isThisMac, sshArgs, probes}
  from '../widgets/packages/_shared/gpu-sampler.mjs';

test('each GPU tool’s output becomes load readings', () => {
  assert.equal(parseNvidia('GPU-abc, NVIDIA RTX 4090, 87, 1000, 24564, 61, 310.5\n')[0].load, 87);
  assert.deepEqual(parseAmdSmi('[{"gpu":0,"usage":{"gfx_activity":{"value":42,"unit":"%"}}}]'), [{name: 'AMD GPU 0', load: 42}]);
  assert.deepEqual(parseRocm('{"card0":{"GPU use (%)":"17"},"system":{}}'), [{name: 'AMD GPU 0', load: 17}]);
  assert.deepEqual(parseXpu('{"device_id":0,"device_level":[{"metrics_type":"XPUM_STATS_GPU_UTILIZATION","value":33}]}'), [{name: 'Intel GPU 0', load: 33}]);
  assert.deepEqual(parseIoreg('"PerformanceStatistics" = {"Device Utilization %"=37,"Renderer Utilization %"=35}'), [{name: 'Apple GPU', load: 37}]);
  assert.deepEqual(parseWindows('\r\n12.5\r\n'), [{name: 'GPU', load: 12.5}]);
  for (const [parse, junk] of [[parseNvidia, 'command not found'], [parseRocm, '{}'], [parseIoreg, 'nothing'], [parseWindows, 'error'],
    [parseAmdSmi, '[{"gpu":0,"usage":{"gfx_activity":{"value":150}}}]']])
    assert.throws(() => parse(junk));
});

test('the sampler finds the host’s tool once, then asks it first', async () => {
  const asked = [];
  const exec = async (target, key, command) => {
    asked.push(command.split(' ')[0]);
    if (command.startsWith('rocm-smi')) return '{"card0":{"GPU use (%)":"9"}}';
    throw Object.assign(Error('not found'), {stderr: 'command not found'});
  };
  const sample = remoteSampler(exec);
  assert.deepEqual(await sample('root@gpu.local'), {tool: 'rocm-smi', devices: [{name: 'AMD GPU 0', load: 9}]});
  assert.deepEqual(asked, ['nvidia-smi', 'amd-smi', 'rocm-smi']);
  asked.length = 0;
  await sample('root@gpu.local');
  assert.deepEqual(asked, ['rocm-smi']);
});

test('an unreachable host stops probing instead of trying every tool', async () => {
  let calls = 0;
  const sample = remoteSampler(async () => { calls++; throw Object.assign(Error('ssh'), {stderr: 'Permission denied (publickey)'}); });
  await assert.rejects(sample('root@gpu.local'));
  assert.equal(calls, 1);
  assert.equal(probes.length, 6);
});

test('local addresses and SSH options', () => {
  for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', 'studio', 'studio.local']) assert.ok(isThisMac(host, 'Studio.local'), host);
  assert.ok(!isThisMac('worker.local', 'studio.local'));
  const args = sshArgs('/tmp/s', 'me@gpu', '/Users/me/.ssh/id', 'nvidia-smi');
  assert.ok(args.includes('BatchMode=yes') && args.includes('StrictHostKeyChecking=yes') && args.at(-2) === 'me@gpu');
});
