/* Reveal complete physical cords, including the lengths hidden behind artwork.
   Use painted SVG paths and real lengths: no animated defs/use shadow trees. */
(() => {
 'use strict';
 const paths=Array.from(document.querySelectorAll('.drawn-red-cord .thread-line'));
 if(!paths.length)return;
 const media=window.matchMedia('(prefers-reduced-motion: reduce)');
 let frame=0,finished=false;
 function finish(){
   finished=true;
   cancelAnimationFrame(frame);
   paths.forEach(path=>{path.style.removeProperty('stroke-dasharray');path.style.removeProperty('stroke-dashoffset');});
   media.removeEventListener?.('change',motionChanged);
   document.removeEventListener('visibilitychange',visibilityChanged);
   window.removeEventListener('pagehide',finish);
 }
 function motionChanged(){if(media.matches)finish();}
 function visibilityChanged(){if(document.hidden)finish();}
 try{
   if(media.matches||document.hidden)return;
   const lengths=paths.map(path=>path.getTotalLength());
   if(lengths.some(length=>!Number.isFinite(length)||length<=0))return;
   const longest=Math.max(...lengths),speed=longest/4000;
   const start=performance.now();
   paths.forEach((path,i)=>{
     path.style.strokeDasharray=`${lengths[i]} ${lengths[i]}`;
     path.style.strokeDashoffset=String(lengths[i]);
   });
   function draw(now){
     if(finished)return;
     try{
       const distance=Math.max(0,now-start)*speed;
       if(distance>=longest){finish();return;}
       paths.forEach((path,i)=>{path.style.strokeDashoffset=String(Math.max(0,lengths[i]-distance));});
       frame=requestAnimationFrame(draw);
     }catch{finish();}
   }
   media.addEventListener?.('change',motionChanged);
   document.addEventListener('visibilitychange',visibilityChanged);
   window.addEventListener('pagehide',finish);
   frame=requestAnimationFrame(draw);
 }catch{finish();}
})();

/* One animation source drives both the butterfly and its masked reflection. */
(() => {
 'use strict';
 const canvas = document.getElementById('latest-butterfly-canvas');
 if (!canvas || typeof window.mountButterfly !== 'function') {
   console.error('最新蝴蝶动效未加载；检查 latest-butterfly 目录是否完整。');
   return;
 }
 const reflection=document.getElementById('butterfly-reflection');
 const reflectionCtx=reflection?.getContext('2d',{alpha:true});
 let reflectionSize={width:0,height:0,dpr:1};
 let reflectionSource=canvas;
 let reflectionTime=0;
 const loop='C437 960 424 984 462 1002 C518 1033 615 1002 690 980 C750 960 784 966 802 1008 C807 1020 810 1031 812 1042';
 const cordPaths=Array.from(document.querySelectorAll('[data-cord="main"] .thread-line')).map(path=>({path,parts:path.getAttribute('d').split(loop)})).filter(({parts})=>parts.length===2);
 let lastCordTime=-100;
 function updateCords(time,fold,flutter,still){
   // Keep the measured path stable during the initial four-second reveal.
   if(cordPaths.some(({path})=>path.style.strokeDasharray))return;
   if(Math.abs(time-lastCordTime)<32&&!still)return;
   lastCordTime=time;
   const lift=still?0:-8*fold*flutter;
   const lifted=`C437 ${960+lift*.4} 424 ${984+lift*.7} 462 ${1002+lift} C518 ${1033+lift} 615 ${1002+lift*.7} 690 ${980+lift*.4} C750 ${960+lift*.2} 784 966 802 1008 C807 1020 810 1031 812 1042`;
   cordPaths.forEach(({path,parts})=>path.setAttribute('d',parts[0]+lifted+parts[1]));
 }

 const media=window.matchMedia('(prefers-reduced-motion: reduce)');
 function drawReflection(source=reflectionSource){
   if(!reflectionCtx)return;
   const {width,height,dpr}=reflectionSize;
   const sourceWidth=source.naturalWidth||source.width;
   const sourceHeight=source.naturalHeight||source.height;
   if(!width||!height||!sourceWidth||!sourceHeight)return;
   reflectionCtx.setTransform(1,0,0,1,0,0);
   reflectionCtx.clearRect(0,0,reflection.width,reflection.height);
   reflectionCtx.setTransform(dpr,0,0,dpr,0,0);
   reflectionCtx.save();
   // Match the butterfly's diagonal: source ~54deg, +5deg here, mirror -12deg.
   // Anchor further along the tails, leaving room for their complete moving tips.
   reflectionCtx.translate(width*.56,height*.52);
   reflectionCtx.rotate(5*Math.PI/180);
   reflectionCtx.scale(1,.90);
   const fit=Math.min(width*.82/sourceWidth,height*.94/sourceHeight);
   reflectionCtx.globalAlpha=.62;
   const x=-sourceWidth*fit*.76,y=-sourceHeight*fit*.78;
   const tailStart=sourceHeight*.70;
   // Keep the upper wings fixed; only the lower tail region receives a soft traveling wave.
   reflectionCtx.drawImage(source,0,0,sourceWidth,tailStart,x,y,sourceWidth*fit,tailStart*fit);
   const bands=28;
   const lift=position=>{
     const u=Math.max(0,(position-tailStart)/(sourceHeight-tailStart));
     const ease=u*u*(3-2*u);
     return media.matches?0:Math.sin(reflectionTime/1000*Math.PI*2*.375-u*1.6)*sourceHeight*.018*ease;
   };
   for(let i=0;i<bands;i++){
     const a=tailStart+(sourceHeight-tailStart)*i/bands;
     const b=tailStart+(sourceHeight-tailStart)*(i+1)/bands;
     const da=a+lift(a),db=b+lift(b);
     reflectionCtx.drawImage(source,0,a,sourceWidth,b-a,x,y+da*fit,sourceWidth*fit,(db-da)*fit);
   }
   reflectionCtx.restore();
 }
 function resizeReflection(){
   if(!reflectionCtx)return;
   const width=reflection.clientWidth,height=reflection.clientHeight,dpr=Math.min(window.devicePixelRatio||1,2);
   reflectionSize={width,height,dpr};
   reflection.width=Math.max(1,Math.round(width*dpr));
   reflection.height=Math.max(1,Math.round(height*dpr));
   drawReflection();
 }
 const reflectionObserver=reflection&&typeof ResizeObserver!=='undefined'?new ResizeObserver(resizeReflection):null;
 reflectionObserver?.observe(reflection);
 if(!reflectionObserver)window.addEventListener('resize',resizeReflection);
 resizeReflection();
 const butterfly = window.mountButterfly(canvas, {
   speed:1,reducedMotion:'auto',
   onFrame:({canvas:source,time,fold=0,flutter=0,still=false})=>{reflectionSource=source;reflectionTime=time||0;drawReflection(source);updateCords(time||0,fold,flutter,still);}
 });

 const sync=()=>{
   const paused=document.body.classList.contains('motion-paused')||media.matches;
   if(paused)butterfly.pause();else butterfly.play();
 };
 butterfly.ready.then(()=>{sync();drawReflection();}).catch(error=>{
   console.error('最新版蝴蝶素材加载失败：',error);
   const replacement=document.createElement('img');
   replacement.onload=()=>{reflectionSource=replacement;drawReflection();};
   replacement.src='latest-butterfly/source/selected-image-1.png';
   replacement.alt='最新版蝴蝶（静态原画）';
   replacement.className='latest-butterfly-canvas';
   canvas.replaceWith(replacement);
 });
 const observer=new MutationObserver(sync);
 observer.observe(document.body,{attributes:true,attributeFilter:['class']});
 media.addEventListener?.('change',sync);
 window.addEventListener('beforeunload',()=>{
   observer.disconnect();reflectionObserver?.disconnect();
   media.removeEventListener?.('change',sync);
   window.removeEventListener('resize',resizeReflection);
   butterfly.destroy();
 });
})();
