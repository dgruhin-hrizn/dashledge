// Live video from a go2rtc MSE stream (Frigate's live view) in a Dashledge view.
//
// Manifest:
//   "permissions": ["stream"],
//   "streams": [{"id": "live", "path": "live/mse/api/ws?src={camera}"}]
// (go2rtc on its own port uses "api/ws?src={camera}".)
//
// View:
//   <video id="camera" muted playsinline></video>
//   <script src="mse-player.js"></script>
//   const player = playLive(document.getElementById('camera'), 'live', {camera: 'front_door'},
//     {onState: state => status.textContent = state});
//   player.stop();
//
// The view runs in a sandboxed frame with an opaque origin, where a blob: media URL
// doesn't play. The MediaSource is attached with `video.srcObject` instead.
(() => {
  const Source = window.ManagedMediaSource || window.MediaSource;
  // What go2rtc may send, best first. It picks the first one the stream can use.
  const CANDIDATES = ['avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0', 'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus'];
  const supported = () => CANDIDATES.filter(codec => Source?.isTypeSupported(`video/mp4; codecs="${codec}"`)).join(',');

  window.playLive = function playLive(video, streamId, params = {}, {onState = () => {}, maxBuffer = 10} = {}) {
    let stream = null, source = null, buffer = null, queue = [], stopped = false, paused = false, retry = 1000, timer = 0;
    video.muted = true;
    video.playsInline = true;
    video.disableRemotePlayback = true; // ManagedMediaSource needs this before attaching.

    const reset = () => {
      queue = [];
      buffer = null;
      if (source && video.srcObject === source) video.srcObject = null;
      source = null;
    };
    // Append queued segments one at a time; trim old video and stay near the live edge.
    const pump = () => {
      if (!buffer || buffer.updating) return;
      const ranges = buffer.buffered;
      if (ranges.length) {
        const start = ranges.start(0), end = ranges.end(ranges.length - 1);
        if (end - start > maxBuffer * 1.5) { buffer.remove(start, end - maxBuffer); return; }
        if (end - video.currentTime > 2) video.currentTime = end - 0.5;
      }
      const next = queue.shift();
      if (next) {
        try { buffer.appendBuffer(next); } catch (error) { onState('error'); restart(); }
      }
    };
    const attach = mime => {
      source = new Source();
      video.srcObject = source;
      source.addEventListener('sourceopen', () => {
        try {
          buffer = source.addSourceBuffer(mime);
          buffer.mode = 'segments';
          buffer.addEventListener('updateend', pump);
          pump();
          video.play().catch(() => {});
        } catch (error) {
          onState('unsupported');
        }
      }, {once: true});
    };
    // Forget the current stream first, so its own close event doesn't restart it again.
    const drop = () => {
      const current = stream;
      stream = null;
      current?.close();
      reset();
    };
    const restart = () => {
      if (stopped) return;
      drop();
      clearTimeout(timer);
      timer = setTimeout(start, retry);
      retry = Math.min(retry * 2, 10000);
    };
    async function start() {
      if (stopped || paused || stream) return;
      if (!Source) return onState('unsupported');
      onState('connecting');
      let current;
      try {
        current = await Dashledge.stream.open(streamId, params);
      } catch (error) {
        onState('unavailable');
        return restart();
      }
      if (stopped || paused) return current.close();
      stream = current;
      current.onopen = () => current.send(JSON.stringify({type: 'mse', value: supported()}));
      current.onmessage = ({data}) => {
        if (stream !== current) return;
        if (typeof data !== 'string') {
          queue.push(data);
          if (queue.length > 120) queue.splice(0, queue.length - 60); // fell behind: drop the oldest
          return pump();
        }
        const message = JSON.parse(data);
        if (message.type === 'mse') { retry = 1000; onState('live'); attach(message.value); }
        else if (message.type === 'error') { onState('error'); restart(); }
      };
      current.onclose = () => {
        if (stream !== current) return;
        stream = null;
        if (!stopped && !paused) { onState('reconnecting'); restart(); }
      };
    }
    // Hidden pages don't need video; resume when the page shows again.
    const visibility = () => {
      paused = document.hidden;
      if (paused) { clearTimeout(timer); drop(); onState('paused'); } else start();
    };
    document.addEventListener('visibilitychange', visibility);
    start();
    return {
      stop() {
        stopped = true;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', visibility);
        drop();
      },
    };
  };
})();
