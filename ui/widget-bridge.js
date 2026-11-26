// The original widgets use the host only for appearance, hit registration and
// the oMLX action mailbox. Workbench delivers touches to the actual DOM targets.
(() => {
  const frame = window.frameElement;
  window.parent?.__bindPageSwipe?.(document);
  const subscribers=new Set();
  function state(){
    let prefs={};
    try{prefs=JSON.parse(localStorage.getItem('edge.general.v1'))||{}}catch{}
    const theme={mode:'dark',primary:prefs.primary||'#edf0e6',accent:prefs.accent||'#f88d4f'};
    document.documentElement.style.setProperty('--text',theme.primary);
    document.documentElement.style.setProperty('--accent',theme.accent);
    return {instanceID:'omlx-dashboard@'+frame.dataset.viewer,touchMode:false,theme};
  }
  state();
  window.addEventListener('storage',e=>{
    if(e.key!=='edge.general.v1')return;
    const update=state();
    for(const callback of subscribers)callback(update);
  });
  window.Zurface = {
    subscribe(callback) {
      subscribers.add(callback);
      callback(state());
      return ()=>subscribers.delete(callback);
    },
    async command(name, args) {
      if (name !== 'storage.set' || args.key !== 'omlx.modelAction') throw Error('Unknown widget command');
      return frame.sendModelAction(JSON.parse(args.value));
    },
  };
})();
