const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export const tradingDate=t=>dateFormat.format(t);
export function sessionAt(t,calendar){
  const day=calendar.get(tradingDate(t));
  if(!day)return null;
  const minute=clock.format(t);
  if(minute<day.open)return 'Pre-market';
  if(minute>=day.close)return 'After hours';
  return 'Regular session';
}
export function applyTrade(s,time,price,calendar){
  if(!Number.isFinite(time)||!Number.isFinite(price)||price<=0||time<(s.time||0))return;
  if(s.time && tradingDate(time)!==tradingDate(s.time)){s.points=[];delete s.regularClose;delete s.extendedStart}
  const minute=Math.floor(time/60000)*60000;
  if(s.points.at(-1)?.[0]===minute)s.points.at(-1)[1]=price;
  else s.points.push([minute,price]);
  s.price=price;s.time=time;s.session=sessionAt(time,calendar);
  if(s.session==='Regular session')s.regularClose=price;
  if(s.session==='After hours')s.extendedStart??=minute;
}
