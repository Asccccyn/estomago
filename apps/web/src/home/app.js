(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const scene = $('scene');
  const clock = document.querySelector('.clock-module');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  // Lift the real clock text above the foreground cord, keeping its original
  // coordinates and live IDs. The blue card and its shadow stay underneath.
  const clockFace = $('clock-face');
  const clockPicture = clock.querySelector('.clock-picture');
  const home = document.querySelector('.home');
  function positionClockFace(){
    const card=clockPicture.getBoundingClientRect(), bounds=home.getBoundingClientRect();
    Object.assign(clockFace.style,{left:`${card.left-bounds.left}px`,top:`${card.top-bounds.top}px`,width:`${card.width}px`,height:`${card.height}px`});
  }
  clockFace.classList.add('clock-face-foreground');
  home.insertBefore(clockFace,scene);
  positionClockFace();
  const clockFaceObserver=new ResizeObserver(positionClockFace);
  clockFaceObserver.observe(clockPicture);
  clockFaceObserver.observe(home);
  window.addEventListener('resize',positionClockFace);
  const albumIds = ['daily','chat','stickers'];
  const albums = {
    daily:{name:'日常照片',src:'home-v2-original/assets/illustrations/album-daily.png'},
    chat:{name:'聊天记录',src:'home-v2-original/assets/illustrations/album-chat.png'},
    stickers:{name:'表情包',src:'home-v2-original/assets/illustrations/album-stickers.png'}
  };
  const labels = {call:'通话',chat:'聊天',calendar:'日历',study:'书房',radio:'电台',cinema:'影院',living:'客厅',games:'游戏室',admin:'后台',mcp:'MCP 连接',wishes:'许愿星'};
  const urls = new Map();
  let frontId='daily', openAlbumId='daily', clickTimer, toastTimer, pendingTap=null;
  function toast(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>{$('toast').hidden=true;},4200);}
  function emitAction(action,detail={}){return document.dispatchEvent(new CustomEvent('home:action',{bubbles:true,cancelable:true,detail:{action,...detail}}));}
  function action(name){const unhandled=emitAction(name);if(!unhandled)return;if(name==='admin'){$('admin-dialog').showModal();return;}toast(`素材预览：${labels[name]||name}入口已触发，尚未连接实际功能。`);}
  document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>action(button.dataset.action)));
  $('admin-close').addEventListener('click',()=>$('admin-dialog').close());
  document.querySelector('[data-admin-action="mcp"]').addEventListener('click',()=>action('mcp'));

  function resetPointer(){clock.style.setProperty('--pointer-x','0px');clock.style.setProperty('--pointer-y','0px');}
  clock.addEventListener('pointermove',event=>{if(event.pointerType==='touch'||reducedMotion.matches){resetPointer();return;}const b=clock.getBoundingClientRect();const offset=(p,s,w)=>Math.max(-6,Math.min(6,((p-s)/w-.5)*12));clock.style.setProperty('--pointer-x',`${offset(event.clientX,b.left,b.width).toFixed(2)}px`);clock.style.setProperty('--pointer-y',`${offset(event.clientY,b.top,b.height).toFixed(2)}px`);});
  clock.addEventListener('pointerleave',resetPointer);clock.addEventListener('pointercancel',resetPointer);clock.addEventListener('pointerdown',event=>{if(event.pointerType==='touch')resetPointer();});
  $('clock-touch').addEventListener('click',()=>{$('clock-touch').setAttribute('aria-expanded',String(clock.classList.toggle('revealed')));});
  function updateClock(){const parts=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',weekday:'long',hourCycle:'h23'}).formatToParts(new Date());const p=type=>parts.find(x=>x.type===type)?.value||'';$('clock-year').textContent=p('year');$('clock-month-day').textContent=`${p('month')}${p('day')}`;$('clock-time').textContent=`${p('hour')}${p('minute')}`;$('clock-weekday').textContent=new Intl.DateTimeFormat('en-US',{weekday:'long'}).format(new Date());}
  updateClock();setInterval(updateClock,1000);

  function objectUrl(file,key){if(!file||!file.type.startsWith('image/')){toast('请选择图片文件。');return null;}if(file.size>30*1024*1024){toast('请使用小于 30 MB 的图片。');return null;}if(urls.has(key))URL.revokeObjectURL(urls.get(key));const url=URL.createObjectURL(file);urls.set(key,url);return url;}

  function setFront(id){if(!albums[id])return;frontId=id;const offset=albumIds.indexOf(id);document.querySelectorAll('.album-card').forEach(card=>{const position=(albumIds.indexOf(card.dataset.albumId)-offset+3)%3;card.dataset.layer=['front','middle','back'][position];card.setAttribute('aria-label',`${albums[card.dataset.albumId].name}${position===0?'，当前最前卡片':''}；单击换层，双击打开`);});}
  function nextAlbum(){setFront(albumIds[(albumIds.indexOf(frontId)+1)%3]);}
  function refreshDialog(){const album=albums[openAlbumId];$('album-title').textContent='';$('album-large').src=album.src;$('album-large').alt=`${album.name}${album.uploaded?'':' · 示意插画'}`;$('album-dialog').dataset.albumId=openAlbumId;}
  function openAlbum(id=frontId){clearTimeout(clickTimer);if(!albums[id])return;setFront(id);openAlbumId=id;if(!emitAction('album:open',{albumId:id}))return;refreshDialog();$('album-dialog').showModal();}
  // One gesture owner retains the first stable album ID even if a card changes layer.
  $('album-stack').addEventListener('click',event=>{
    const card=event.target.closest('.album-card');
    if(!card)return;
    event.preventDefault();
    const id=card.dataset.albumId;
    if(event.detail===0){clearTimeout(clickTimer);pendingTap=null;openAlbum(id);return;}
    const now=performance.now();
    if(pendingTap&&now-pendingTap.at<=500){
      const firstId=pendingTap.id;clearTimeout(clickTimer);pendingTap=null;
      setFront(firstId);openAlbum(firstId);return;
    }
    clearTimeout(clickTimer);pendingTap={id,at:now};
    clickTimer=setTimeout(()=>{
      const selected=pendingTap?.id;pendingTap=null;
      if(!selected)return;
      if(selected===frontId)nextAlbum();else setFront(selected);
    },500);
  });
  $('album-stack').addEventListener('dblclick',event=>event.preventDefault());
  document.querySelectorAll('.album-card').forEach(card=>{
    card.addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();clearTimeout(clickTimer);pendingTap=null;const next=(albumIds.indexOf(frontId)+(event.key==='ArrowRight'?1:2))%3;setFront(albumIds[next]);document.querySelector(`[data-album-id="${frontId}"]`).focus();}});
  });
  $('album-close').addEventListener('click',()=>$('album-dialog').close());
  $('album-next').addEventListener('click',()=>{openAlbumId=albumIds[(albumIds.indexOf(openAlbumId)+1)%3];setFront(openAlbumId);refreshDialog();});
  $('album-upload').addEventListener('change',event=>{if(!event.target.files[0])return;const url=objectUrl(event.target.files[0],`album-${openAlbumId}`);if(url){albums[openAlbumId].src=url;albums[openAlbumId].uploaded=true;document.querySelector(`[data-album-id="${openAlbumId}"] img`).src=url;refreshDialog();}});
  ['album-dialog','admin-dialog'].forEach(id=>{$(id).addEventListener('click',event=>{if(event.target!==$(id))return;const b=$(id).getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)$(id).close();});});

  function updateMotion(){const paused=reducedMotion.matches;document.body.classList.toggle('motion-paused',paused);resetPointer();}
  reducedMotion.addEventListener('change',updateMotion);updateMotion();
  window.addEventListener('beforeunload',()=>{urls.forEach(url=>URL.revokeObjectURL(url));clockFaceObserver.disconnect();window.removeEventListener('resize',positionClockFace);});
  window.EstomagoHomePreview={version:'2.0.0',setAlbum:setFront,openAlbum};
})();
