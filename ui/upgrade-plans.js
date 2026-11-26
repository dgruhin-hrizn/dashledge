// One-time upgrade of saved layouts from before AI Plan Monitor became the bundled
// `plans` package. state() runs it on every load; it changes nothing once applied.
//
// Those layouts kept its choices on the slot as
// `planDisplay: {mode, ids, pin, aliases}`, and Widget Studio's defaults for placements
// without their own as `config.planDefaults`. The package keeps them in the placement's
// `packageSettings: {accounts, names}`: `accounts: ["*"]` is every account, including
// ones found later, and one chosen account is shown full size. Returns whether it changed.
const PLAN_ACCOUNT=/^[A-Za-z0-9._:@/-]{1,128}$/;
export function planSettings(old){
  const ids=old?.mode==='account'?(old.pin?[old.pin]:null):Array.isArray(old?.ids)?old.ids:null;
  const accounts=ids?[...new Set(ids.filter(id=>typeof id==='string'&&PLAN_ACCOUNT.test(id)))].slice(0,64):['*'];
  const names={};
  for(const [id,name] of Object.entries(old?.aliases||{})){
    const text=typeof name==='string'?name.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,48):'';
    if(PLAN_ACCOUNT.test(id)&&text&&Object.keys(names).length<64)names[id]=text;
  }
  return {accounts,names};
}
export function migratePlanSettings(config){
  let changed=false;
  const defaults=config.planDefaults&&typeof config.planDefaults==='object'?config.planDefaults:null;
  for(const page of config.pages||[])for(const slot of page.slots||[]){
    const own=slot.planDisplay&&typeof slot.planDisplay==='object'?slot.planDisplay:null;
    if('planDisplay' in slot){delete slot.planDisplay;changed=true}
    if(slot.kind!=='plans')continue;
    // A slot's own choices win, even over settings left by a widget it held before;
    // the old defaults apply only where the slot has nothing of its own.
    if(own){slot.packageSettings=planSettings(own);changed=true}
    else if(defaults&&!slot.packageSettings){slot.packageSettings=planSettings(defaults);changed=true}
  }
  if('planDefaults' in config){delete config.planDefaults;changed=true}
  return changed;
}
