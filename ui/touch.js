// The Edge sends coordinates in logical window pixels. A swipe belongs to the
// document where it started, including the original widget inside a layout tile.
(() => {
  const slop = 12;
  let gesture;

  function local(frame, x, y) {
    const rect = frame.getBoundingClientRect();
    return [(x - rect.left) * frame.offsetWidth / rect.width - frame.clientLeft,
      (y - rect.top) * frame.offsetHeight / rect.height - frame.clientTop];
  }
  function hit(x, y) {
    let doc = document, target = doc.elementFromPoint(x, y);
    while (target?.tagName === 'IFRAME' && target.contentDocument) {
      [x, y] = local(target, x, y);
      doc = target.contentDocument;
      target = doc.elementFromPoint(x, y);
    }
    // A sandboxed package frame can't be reached into: its own SDK replays the touch.
    const remote = target?.tagName === 'IFRAME' && target.dataset.packageFrame ? target : null;
    return {doc, target, x, y, remote};
  }
  // Map root coordinates into a frame, through any same-origin frames around it.
  function toFrame(frame, x, y) {
    const chain = [];
    for (let f = frame; f; f = f.ownerDocument === document ? null : f.ownerDocument.defaultView.frameElement) chain.unshift(f);
    for (const f of chain) [x, y] = local(f, x, y);
    return [x, y];
  }
  function forward(frame, message) {
    frame.contentWindow?.postMessage({dashledge: 1, type: 'touch', ...message}, '*');
  }
  function scroller(target, axis) {
    for (let node = target; node; node = node.parentElement) {
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      const vertical = axis === 'y';
      if (/(auto|scroll)/.test(vertical ? style.overflowY : style.overflowX) &&
          (vertical ? node.scrollHeight > node.clientHeight : node.scrollWidth > node.clientWidth)) return node;
    }
  }
  // Choose one owner for the entire gesture. Swiping a scrollable carousel
  // moves its content. Either bezel, or an outward drag at its end, changes page.
  function begin(point,x,y){
    const scrollX=scroller(point.target,'x');
    return {point,x,y,lastX:x,lastY:y,scrollX,scrollY:scroller(point.target,'y'),
      left:scrollX?.scrollLeft||0,max:scrollX?scrollX.scrollWidth-scrollX.clientWidth:0,
      bezel:x<=24||x>=window.innerWidth-24,
      blocked:point.target?.closest('input,textarea,select,[contenteditable=true]')||
        point.doc.querySelector?.('dialog[open]')||document.querySelector?.('dialog[open]')};
  }
  function track(g,x,y){
    const dx=x-g.x,dy=y-g.y;
    const tolerance=g.pressed?.matches?.('.sp-controls button') ? Math.min(24,g.pressed.clientWidth/3) : slop;
    if(!g.axis&&Math.hypot(dx,dy)>tolerance){
      g.axis=Math.abs(dx)>Math.abs(dy)?'x':'y';
      g.pressed?.classList.remove('edge-pressed');
      const room=dx<0?g.left<g.max-1:g.left>1;
      g.page=g.axis==='x'&&!g.blocked&&(g.bezel||!g.scrollX||!room);
    }
  }
  function direction(g,x,y){
    const dx=x-g.x;
    const threshold=Math.max(48,Math.min(96,(window.innerWidth||1280)*0.05));
    if(!g.page||Math.abs(dx)<threshold||Math.abs(dx)<Math.abs(y-g.y)*1.4)return 0;
    return dx<0?1:-1;
  }
  function turn(step){window.dispatchEvent(new CustomEvent('edgepageswipe',{detail:step}))}
  function blankEdge(point,x,y){
    if(x>14||Math.abs(y-window.innerHeight/2)>30)return false;
    // The picker has no transparent hit surface over the widget. Only unclaimed
    // page background in this small region handles a tap.
    if(point.target?.closest('button,a,label,summary,[role=button],input,textarea,select,[tabindex],[contenteditable=true]'))return false;
    if(point.doc!==document && !['BODY','HTML','MAIN'].includes(point.target?.tagName))return false;
    return !point.doc.querySelector?.('dialog[open]')&&!document.querySelector?.('dialog[open]');
  }
  function pointer(type, point) {
    const win = point.doc.defaultView;
    point.target?.dispatchEvent(new win.PointerEvent(type, {
      bubbles:true, cancelable:true, pointerId:1, pointerType:'touch', isPrimary:true,
      clientX:point.x, clientY:point.y, buttons:type === 'pointerdown' ? 1 : 0,
    }));
  }
  // Synthetic HID pointer events do not run the browser's native range drag.
  function rangeTouch(range,x,commit){
    const rect=range.getBoundingClientRect();
    const [left]=rootPoint(range.ownerDocument,rect.left,rect.top);
    const [right]=rootPoint(range.ownerDocument,rect.right,rect.top);
    if(right<=left)return;
    const fraction=Math.min(1,Math.max(0,(x-left)/(right-left)));
    const min=Number(range.min),max=Number(range.max),step=Number(range.step)||1;
    range.value=min+Math.round(fraction*(max-min)/step)*step;
    const Event=range.ownerDocument.defaultView.Event;
    range.dispatchEvent(new Event('input',{bubbles:true}));
    if(commit)range.dispatchEvent(new Event('change',{bubbles:true}));
  }
  window.__edgeTouch = (kind, x, y) => {
    const point = hit(x,y);
    window.dispatchEvent(new CustomEvent('edgetouch', {detail:{kind,x,y}}));
    if (kind === 'down' && point.remote) {
      gesture = begin(point,x,y);
      gesture.remote = point.remote;
      point.remote.__gestureVerdict = false;
      const [fx, fy] = toFrame(point.remote, x, y);
      forward(point.remote, {kind, x:fx, y:fy, bezel:gesture.bezel});
      return;
    }
    if (kind === 'down') {
      const pressed = point.target?.closest("button,a,label,summary,[role=button],input,textarea");
      pressed?.classList.add('edge-pressed');
      gesture = begin(point,x,y);gesture.pressed=pressed;
      if(pressed?.matches?.('input[type=range][data-edge-range]')&&!pressed.disabled){
        gesture.range=pressed;rangeTouch(pressed,x,false);return;
      }
      pointer('pointerdown',point);
      return;
    }
    const g = gesture;
    if (!g) return;
    if (g.remote) {
      track(g,x,y);
      // The frame reports whether a horizontal drag has content of its own to scroll.
      g.page = g.axis === 'x' && !g.blocked && (g.bezel || g.remote.__gestureVerdict === true);
      const [fx, fy] = toFrame(g.remote, x, y);
      if (kind === 'move') { forward(g.remote, {kind, x:fx, y:fy}); return; }
      gesture = null;
      const step = direction(g,x,y);
      const edge = x <= 14 && Math.abs(y - window.innerHeight/2) <= 30;
      forward(g.remote, {kind, x:fx, y:fy, turned:!!step, edge});
      if (step) turn(step);
      return;
    }
    if(g.range){
      if(g.range.isConnected&&!g.range.disabled)rangeTouch(g.range,x,kind==='up');
      if(kind==='up'){g.range.classList.remove('edge-pressed');gesture=null}
      return;
    }
    track(g,x,y);
    if (kind === 'move') {
      if (g.axis === 'x'&&!g.page) g.scrollX?.scrollBy(g.lastX-x,0);
      if (g.axis === 'y') g.scrollY?.scrollBy(0,g.lastY-y);
      g.lastX=x; g.lastY=y;
      return;
    }
    gesture=null;
    g.pressed?.classList.remove('edge-pressed');
    const step=direction(g,x,y);
    if(step){
      pointer('pointercancel',g.point);
      turn(step);
      return;
    }
    // Dispatch the release even if the finger moved outside its iframe (e.g. Emby wall).
    pointer('pointerup',point.doc === g.point.doc ? point : g.point);
    if (g.axis || !point.target?.isConnected || point.doc !== g.point.doc) return;
    const released=point.target.closest("button,a,label,summary,[role=button],input,textarea");
    if(g.pressed!==released)return;
    if(blankEdge(point,x,y)){window.dispatchEvent(new CustomEvent('edgepagepicker'));return}
    const field=point.target.closest('input,textarea,[contenteditable=true]');
    if (field) {
      const bridge=window.__TAURI__||window.parent?.__TAURI__;
      bridge?.core?.invoke('focus_window').catch(()=>{});
      field.focus();
    }
    const win=point.doc.defaultView;
    const opts={bubbles:true,cancelable:true,clientX:point.x,clientY:point.y,view:win};
    for (const type of ['mousedown','mouseup']) point.target.dispatchEvent(new win.MouseEvent(type,opts));
    if (typeof point.target.click === 'function') point.target.click();
    else point.target.dispatchEvent(new win.MouseEvent('click',opts));
  };
  // Pointer input in previews and on devices delivering browser events uses
  // the same distance, direction and scroll ownership rules as IOHID input.
  function rootPoint(doc,x,y){
    while(doc!==document){
      const f=doc.defaultView.frameElement;
      if(!f)break;
      const r=f.getBoundingClientRect();
      x=r.left+(x+f.clientLeft)*r.width/f.offsetWidth;
      y=r.top+(y+f.clientTop)*r.height/f.offsetHeight;
      doc=f.ownerDocument;
    }
    return [x,y];
  }
  let browserGesture;
  window.__bindPageSwipe=doc=>{
    let suppressClick=false;
    doc.addEventListener('pointerdown',e=>{
      if(!e.isTrusted||!e.isPrimary||e.button!==0)return;
      suppressClick=false;
      const [x,y]=rootPoint(doc,e.clientX,e.clientY);
      browserGesture=begin({target:e.target,doc},x,y);browserGesture.id=e.pointerId;
    },true);
    doc.addEventListener('pointermove',e=>{
      if(!e.isTrusted||browserGesture?.id!==e.pointerId)return;
      track(browserGesture,...rootPoint(doc,e.clientX,e.clientY));
    },true);
    doc.addEventListener('pointerup',e=>{
      const g=browserGesture;
      if(!e.isTrusted||!g||g.id!==e.pointerId)return;
      browserGesture=null;
      const [x,y]=rootPoint(doc,e.clientX,e.clientY);track(g,x,y);
      const step=direction(g,x,y);
      if(step){suppressClick=true;turn(step)}
    },true);
    doc.addEventListener('pointercancel',e=>{if(e.isTrusted)browserGesture=null},true);
    doc.addEventListener('click',e=>{
      if(!e.isTrusted)return;
      if(suppressClick){suppressClick=false;e.preventDefault();e.stopImmediatePropagation();return}
      if(e.detail>0&&blankEdge({target:e.target,doc},...rootPoint(doc,e.clientX,e.clientY))){
        e.preventDefault();e.stopImmediatePropagation();window.dispatchEvent(new CustomEvent('edgepagepicker'));
      }
    },true);
    doc.addEventListener('keydown',e=>{
      if(e.altKey&&e.code==='KeyP'){e.preventDefault();window.dispatchEvent(new CustomEvent('edgepagepicker'))}
    });
  };
  if(document.addEventListener)window.__bindPageSwipe(document);
  window.addEventListener('contextmenu', event => event.preventDefault());
})();
