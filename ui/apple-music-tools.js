import {el,button} from './common.js';

function group(parent,title){
  const section=el('section','am-tool-group');
  section.append(el('h3','',title));parent.append(section);return section;
}
function volume(name,initial,save){
  const slider=el('input');slider.type='range';slider.min=0;slider.max=100;slider.value=initial;
  slider.setAttribute('data-edge-range','');slider.setAttribute('aria-label',name);
  const number=el('output','',initial+'%'),label=el('label','am-volume');
  slider.oninput=()=>number.textContent=slider.value+'%';slider.onchange=()=>save(slider.value);
  label.append(slider,number);return label;
}

export async function soundControls(sheet,request,refresh){
  const {dialog,body}=sheet('Sound & outputs');
  body.classList.add('am-sound');body.textContent='Loading sound controls…';
  let pending=false;
  async function change(action,value='',arg=''){
    if(pending)return;
    pending=true;
    try{
      body.inert=true;await request(action,value,arg);
      if(dialog.open)await load();refresh();
    }catch(e){
      if(dialog.open){
        try{await load();body.querySelector('[role=status]').textContent=String(e)}
        catch(readError){body.textContent=String(readError)}
      }
    }
    finally{pending=false;body.inert=false}
  }
  async function load(){
    const data=await request('devices');
    if(!dialog.open)return;
    const scroll=body.scrollTop;body.replaceChildren();
    const status=el('p','am-status');status.setAttribute('role','status');body.append(status);
    const master=group(body,'Music volume');
    master.append(volume('Music volume',data.volume,v=>change('volume',v)));
    const outputs=group(body,'AirPlay speakers');
    if(!data.devices.length)outputs.append(el('p','','No AirPlay outputs available.'));
    for(const dev of data.devices){
      const row=el('div','am-output');
      const toggle=button(dev.name,()=>change('device',dev.id,dev.selected?'remove':'add'));
      toggle.setAttribute('aria-pressed',String(dev.selected));
      const only=button('Only',()=>change('device',dev.id,'only'));only.setAttribute('aria-label','Play only on '+dev.name);
      row.append(toggle,only);outputs.append(row);
      if(dev.selected)outputs.append(volume(dev.name+' volume',dev.volume,v=>change('speaker-volume',dev.id,v)));
    }
    const shuffle=group(body,'Shuffle'),modes=el('div','am-choices');
    for(const name of ['Off','Songs','Albums','Groupings']){
      const b=button(name,()=>change('shuffle-mode',name));b.setAttribute('aria-pressed',String(name===data.shuffle));modes.append(b);
    }
    shuffle.append(modes);
    const eq=group(body,'Equalizer'),choices=el('div','am-choices');
    const off=button('EQ off',()=>change('eq-off'));off.setAttribute('aria-pressed',String(!data.eq));choices.append(off);
    for(const name of data.presets){
      const b=button(name,()=>change('preset',name));b.setAttribute('aria-pressed',String(data.eq&&name===data.preset));choices.append(b);
    }
    eq.append(choices);body.scrollTop=scroll;
  }
  try{await load()}catch(e){body.textContent=String(e)}
}

export async function songInfo(sheet,request){
  const {dialog,body}=sheet('Song info');body.textContent='Loading song…';
  try{
    const d=await request('details');
    if(!dialog.open)return;
    body.replaceChildren(el('h2','',d.title),el('p','',d.artist));
    const rating=group(body,'Star rating'),stars=el('div','am-choices am-stars'),status=el('p','am-status');
    status.setAttribute('role','status');
    function paint(value){
      for(const b of stars.children){
        const n=Number(b.dataset.stars);
        b.setAttribute('aria-pressed',String(n===value));b.classList.toggle('am-lit',n>0&&n<=value);
      }
    }
    for(const n of [1,2,3,4,5,0]){
      const b=button(n?'★':'Clear',async()=>{
        stars.inert=true;
        try{await request('rating',n,d.id);paint(n);status.textContent=n?n+' of 5 stars':'Rating cleared'}
        catch(e){status.textContent=String(e)}finally{stars.inert=false}
      });
      b.dataset.stars=n;b.disabled=!d.id;b.setAttribute('aria-label',n?'Rate '+n+(n===1?' star':' stars'):'Clear rating');stars.append(b);
    }
    paint(d.rating);if(d.computed&&d.rating)status.textContent='Music calculated this rating.';
    rating.append(stars,status);
    const eq=group(body,'Song equalizer');
    const choose=button(d.preset||'Default',()=>{choices.hidden=!choices.hidden;choose.setAttribute('aria-expanded',String(!choices.hidden))});
    choose.disabled=!d.id;choose.setAttribute('aria-expanded','false');
    const choices=el('div','am-choices');choices.hidden=true;
    for(const name of ['',...d.presets]){
      const b=button(name||'Use default',async()=>{
        choices.inert=true;
        try{
          await request('track-preset',name,d.id);choose.textContent=name||'Default';
          for(const other of choices.children)other.setAttribute('aria-pressed',String(other===b));
          choices.hidden=true;choose.setAttribute('aria-expanded','false');
        }catch(e){status.textContent=String(e)}finally{choices.inert=false}
      });
      b.setAttribute('aria-pressed',String(d.preset===name));choices.append(b);
    }
    eq.append(choose,choices);
    const info=group(body,'Track details'),list=el('dl','am-facts');
    const fields=[['Album',d.album],['Year',d.year],['Genre',d.genre],['Composer',d.composer],['Tempo',d.bpm&&d.bpm+' BPM'],
      ['Format',d.format],['Bit rate',d.bitrate&&d.bitrate+' kbps'],['Sample rate',d.rate&&d.rate/1000+' kHz'],
      ['Disc',d.disc],['Track',d.track],['Play count',String(d.plays)],['Skip count',String(d.skips)],
      ['Last played',d.lastPlayed>0&&new Date(d.lastPlayed*1000).toLocaleString()]];
    for(const [name,value] of fields)if(value)list.append(el('dt','',name),el('dd','',value));
    info.append(list);
    const lyrics=group(body,'Lyrics');
    const show=button('Show lyrics',async()=>{
      show.disabled=true;
      try{lyrics.append(el('p','am-lyrics',(await request('lyrics','',d.id)).lyrics||'No lyrics in this track’s metadata.'));show.remove()}
      catch(e){status.textContent=String(e);show.disabled=false}
    });lyrics.append(show);
  }catch(e){body.textContent=String(e)}
}
