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
 const cordLoop=document.getElementById('butterfly-cord-loop');
 const cordLayers=document.querySelectorAll('.drawn-red-cord');
 let lastCordTime=-100;
 function updateCords(time,fold,flutter,still){
   if(Math.abs(time-lastCordTime)<32&&!still)return;
   lastCordTime=time;
   const lift=still?0:-8*fold*flutter;
   if(cordLoop)cordLoop.setAttribute('d',`M481 940 C462 947 434 ${961+lift*.5} 437 ${974+lift} C444 ${993+lift} 484 ${1006+lift} 512 ${1012+lift} C560 ${1020+lift} 611 ${1003+lift*.7} 655 ${992+lift*.5} C699 ${979+lift*.3} 734 963 765 972 C791 980 808 1008 814 1037`);
   cordLayers.forEach(layer=>layer.style.setProperty('--cord-offset',String(still?0:-(time/1000*12)%202)));
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
