// The PINBALL face is drawn on the controller. Redraw the photographed face at
// its native resolution: one bit is one LED, even in the seconds formats.
// Each column of words below is one digit, 0 through 9. Hex rows are 12 dots wide.
const atlas = [
  '7fe 0f0 7fe ffe 00f fff 7fe fff 7fe 7fe',
  'fff 0f0 fff fff 01f fff fff fff fff fff',
  'fff 3f0 fff fff 03f fff fff fff fff fff',
  'fff 3f0 fff fff 07f fff fff fff fff fff',
  'f0f 3f0 f0f 00f 0ff f00 f00 00f f0f f0f',
  'f0f 3f0 00f 00f 1ef f00 f00 01f f0f f0f',
  'f0f 0f0 00f 00f 3cf f00 f00 01e f0f f0f',
  'f0f 0f0 7ff 7fe 78f ffe ffe 03e 7fe fff',
  'f0f 0f0 fff 7fe f0f fff fff 03c fff fff',
  'f0f 0f0 fff 7ff fff fff fff 07c fff fff',
  'f0f 0f0 ffe 7ff fff fff fff 078 fff 7ff',
  'f0f 0f0 f00 00f fff 00f f0f 0f8 f0f 00f',
  'f0f 0f0 f00 00f fff 00f f0f 0f0 f0f 00f',
  'f0f 0f0 f00 00f 00f f0f f0f 1f0 f0f 00f',
  'fff 3fc fff fff 00f fff fff 1e0 fff fff',
  'fff 3fc fff fff 00f fff fff 3e0 fff fff',
  'fff 3fc fff fff 00f fff fff 3c0 fff fff',
  '7fe 3fc fff ffe 00f 7fe 7fe 3c0 7fe 7fe'
].map(row=>row.split(' ').map(value=>parseInt(value,16)));

const digits=Array.from({length:10},(_,digit)=>atlas.map(row=>row[digit]));
const colon=[0,0,0,0,7,7,7,0,0,0,0,7,7,7,0,0,0,0];
const suffix={
  A:[0x3e,0x7f,0x63,0x63,0x63,0x7f,0x7f,0x63,0x63,0x63],
  P:[0x7e,0x7f,0x63,0x63,0x63,0x7e,0x60,0x60,0x60,0x60],
  M:[0xc3,0xe7,0xff,0xdb,0xdb,0xc3,0xc3,0xc3,0xc3,0xc3]
};

export function drawPinballClock(ctx,value,separator,shade){
  const [time,period]=value.split(' ');
  const width=[...time].reduce((sum,c)=>sum+(c===':'?4:13),-1)+(period?19:0);
  let x=Math.floor((128-width)/2);
  const top=7;
  ctx.fillStyle='rgb('+[shade,shade,shade].join(',')+')';
  function stamp(rows,columns,y){
    for(let r=0;r<rows.length;r++)for(let col=0;col<columns;col++){
      if(rows[r]&(1<<(columns-col-1)))ctx.fillRect(x+col,y+r,1,1);
    }
  }
  for(const c of time){
    if(c===':'){
      if(separator)stamp(colon,3,top);
      x+=4;
    }else{
      stamp(digits[c],12,top);
      x+=13;
    }
  }
  if(period){
    x+=2;
    stamp(suffix[period[0]],7,top+8);
    x+=8;
    stamp(suffix.M,8,top+8);
  }
}
