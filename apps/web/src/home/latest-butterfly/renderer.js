/* Standalone, dependency-free renderer. Assets are the approved drawing's cutout layers. */
(function (global) {
  'use strict';
  const scriptBase = document.currentScript && document.currentScript.src
    ? new URL('.', document.currentScript.src).href : new URL('.', location.href).href;
  const TAU = Math.PI * 2;
  const PARTICLE_TRAILS = [{age:.24,weight:.10},{age:.12,weight:.18},{age:0,weight:.72}];
  const KEYS = ['leftForewing', 'leftHindwing', 'rightForewing', 'rightHindwing', 'body', 'leftTail', 'rightTail', 'particles'];
  const FILES = {
    leftForewing: 'assets/left-forewing.png', leftHindwing: 'assets/left-hindwing.png',
    rightForewing: 'assets/right-forewing.png', rightHindwing: 'assets/right-hindwing.png',
    body: 'assets/body.png', leftTail: 'assets/left-tail.png', rightTail: 'assets/right-tail.png', particles: 'assets/particles.png'
  };
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const smooth = n => { n = clamp(n, 0, 1); return n * n * (3 - 2 * n); };
  const point = value => Array.isArray(value) ? {x: value[0], y: value[1]} : value;
  const makeCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.ceil(w); c.height = Math.ceil(h); return c; };
  const loadImage = src => new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法加载蝴蝶素材：' + src));
    image.src = src;
  });

  // Map a triangle from its source texture into the articulated artwork plane.
  function triangle(ctx, texture, s, d) {
    const x0 = s[0].x, y0 = s[0].y, x1 = s[1].x, y1 = s[1].y, x2 = s[2].x, y2 = s[2].y;
    const den = x0 * (y1-y2) + x1 * (y2-y0) + x2 * (y0-y1);
    if (Math.abs(den) < 0.00001) return;
    const solve = values => [
      (values[0]*(y1-y2)+values[1]*(y2-y0)+values[2]*(y0-y1))/den,
      (values[0]*(x2-x1)+values[1]*(x0-x2)+values[2]*(x1-x0))/den,
      (values[0]*(x1*y2-x2*y1)+values[1]*(x2*y0-x0*y2)+values[2]*(x0*y1-x1*y0))/den
    ];
    const a = solve(d.map(p => p.x)), b = solve(d.map(p => p.y));
    ctx.save();
    ctx.beginPath();
    // A subpixel overlap prevents antialiasing cracks between texture strips.
    const center = {x:(d[0].x+d[1].x+d[2].x)/3, y:(d[0].y+d[1].y+d[2].y)/3};
    d.forEach((p, i) => {
      const dx=p.x-center.x, dy=p.y-center.y, length=Math.hypot(dx,dy)||1;
      const q={x:p.x+dx/length*.22,y:p.y+dy/length*.22};
      i ? ctx.lineTo(q.x,q.y) : ctx.moveTo(q.x,q.y);
    });
    ctx.closePath(); ctx.clip();
    ctx.transform(a[0],b[0],a[1],b[1],a[2],b[2]);
    ctx.drawImage(texture,0,0); ctx.restore();
  }

  // Rotate a tail into its own lengthwise texture coordinates once, not every frame.
  function prepareTail(image, definition) {
    if (!image || !definition || !definition.anchor || !definition.tip) return null;
    const anchor = point(definition.anchor), tip = point(definition.tip);
    const length = Math.hypot(tip.x-anchor.x,tip.y-anchor.y);
    if (length < 1) return null;
    const u={x:(tip.x-anchor.x)/length,y:(tip.y-anchor.y)/length}, v={x:-u.y,y:u.x};
    const source=makeCanvas(image.width,image.height), cx=source.getContext('2d',{willReadFrequently:true});
    cx.drawImage(image,0,0);
    const pixels=cx.getImageData(0,0,source.width,source.height).data;
    let minX=image.width,minY=image.height,maxX=0,maxY=0;
    for(let y=0;y<source.height;y++) for(let x=0;x<source.width;x++) {
      if(pixels[(y*source.width+x)*4+3]>1) { minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y); }
    }
    const corners=[{x:minX,y:minY},{x:maxX,y:minY},{x:maxX,y:maxY},{x:minX,y:maxY}];
    const along=corners.map(p=>(p.x-anchor.x)*u.x+(p.y-anchor.y)*u.y);
    const across=corners.map(p=>(p.x-anchor.x)*v.x+(p.y-anchor.y)*v.y);
    const lo=Math.floor(Math.min(...along))-3, hi=Math.ceil(Math.max(...along))+3;
    const top=Math.floor(Math.min(...across))-3, bottom=Math.ceil(Math.max(...across))+3;
    const texture=makeCanvas(Math.max(1,hi-lo),Math.max(1,bottom-top)), tc=texture.getContext('2d');
    tc.setTransform(u.x,v.x,u.y,v.y,-anchor.x*u.x-anchor.y*u.y-lo,-anchor.x*v.x-anchor.y*v.y-top);
    tc.drawImage(image,0,0);
    // The texture grid is fixed; only the bend changes during a frame.
    const columns=Array.from({length:23},(_,i)=>{
      const x=texture.width*i/22,s=lo+x;
      return {
        sourceTop:{x,y:0},sourceBottom:{x,y:texture.height},position:s/length,
        amplitude:smooth(s/length),
        top:{x:anchor.x+u.x*s+v.x*top,y:anchor.y+u.y*s+v.y*top},
        bottom:{x:anchor.x+u.x*s+v.x*(top+texture.height),y:anchor.y+u.y*s+v.y*(top+texture.height)}
      };
    });
    const strips=columns.slice(0,-1).map((column,i)=>{
      const next=columns[i+1];
      return [
        [column.sourceTop,next.sourceTop,next.sourceBottom],
        [column.sourceTop,next.sourceBottom,column.sourceBottom]
      ];
    });
    return {texture,v,columns,strips};
  }

  function drawTail(ctx, tail, time, phase, amplitude) {
    if (!tail) return;
    const {texture,v,columns,strips}=tail;
    const destination=columns.map(column=>{
      const bend=amplitude*column.amplitude*Math.sin(time*TAU*.75-column.position*2.1+phase);
      return {
        top:{x:column.top.x+v.x*bend,y:column.top.y+v.y*bend},
        bottom:{x:column.bottom.x+v.x*bend,y:column.bottom.y+v.y*bend}
      };
    });
    for(let i=0;i<strips.length;i++) {
      const column=destination[i],next=destination[i+1];
      triangle(ctx,texture,strips[i][0],[column.top,next.top,next.bottom]);
      triangle(ctx,texture,strips[i][1],[column.top,next.bottom,column.bottom]);
    }
  }

  function mountButterfly(canvas, options={}) {
    if (!canvas || typeof canvas.getContext!=='function') throw new TypeError('mountButterfly requires a canvas.');
    const ctx=canvas.getContext('2d',{alpha:true});
    const base=new URL(options.assetBase || '.',scriptBase).href;
    const media=global.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced=options.reducedMotion==='auto'||options.reducedMotion===undefined ? media.matches : Boolean(options.reducedMotion);
    let ready=false,destroyed=false,playing=options.autoplay!==false,frame=0,speed=clamp(Number(options.speed)||1,.1,3);
    let elapsed=0,lastNow=null,lastDrawNow=null,rig,images={},tails={},particleGroups=[],size={w:1,h:1,dpr:1};
    let pageSuspended=false;
    const frameInterval=1000/clamp(Number(options.maxFps)||30,1,60);
    let forcedStatic=options.motion===false;
    function pixelRatio() {
      let scale=1;
      // A fixed-size scene can be scaled by its same-origin iframe host.
      // Its canvas bounds alone do not include that outer transform.
      try{
        let owner=global;
        while(owner.frameElement){
          const element=owner.frameElement;
          if(element.offsetWidth)scale*=element.getBoundingClientRect().width/element.offsetWidth;
          owner=owner.parent;
        }
      }catch{ /* Cross-origin hosts keep the ordinary canvas density. */ }
      return Math.min(global.devicePixelRatio||1,options.maxDpr||2)*clamp(scale,.01,1);
    }
    function resize() {
      if(destroyed)return;
      const bounds=canvas.getBoundingClientRect();
      size={w:bounds.width||canvas.width||640,h:bounds.height||canvas.height||640,dpr:pixelRatio()};
      const w=Math.max(1,Math.round(size.w*size.dpr)),h=Math.max(1,Math.round(size.h*size.dpr));
      if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
      if(ready)draw(elapsed);
    }
    const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(resize):null;
    observer?.observe(canvas);
    // The host also dispatches resize when it rescales its fixed-size iframe.
    global.addEventListener('resize',resize);
    const isStill=()=>forcedStatic||reduced;
    function draw(ms) {
      if(!ready||destroyed)return;
      const time=(ms%16000)/1000, still=isStill();
      const pivot=point(rig.pivot);
      const angle=(rig.bodyAngleDeg??55)*Math.PI/180;
      const b={x:Math.cos(angle),y:Math.sin(angle)},n={x:-b.y,y:b.x};
      const padding=options.padding===undefined?.065:options.padding;
      const fit=Math.min(size.w/rig.width,size.h/rig.height)*(1-padding*2);
      const flutterActive=!still&&time<6;
      const flutterEnvelope=flutterActive?smooth(time/.65)*smooth((6-time)/.65):0;
      const hover=Math.sin(time*TAU*.25)*rig.height*.006*flutterEnvelope;
      const drift=Math.sin(time*TAU*.125)*rig.width*.003*flutterEnvelope;
      ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.setTransform(size.dpr*fit,0,0,size.dpr*fit,size.dpr*(size.w-rig.width*fit)/2,size.dpr*(size.h-rig.height*fit)/2);
      ctx.translate(drift,hover);
      const rate=rig.motion?.flapHz||.5;
      const wave=flutterActive?(1-Math.cos(time*TAU*rate))*.5:0;
      const farWave=flutterActive?(1-Math.cos(time*TAU*rate-.06))*.5*flutterEnvelope:0;
      if(options.particles!==false){
        const sprites=global.BUTTERFLY_PARTICLE_SPRITES||[];
        if(!still&&particleGroups.length&&sprites.length){
          sprites.forEach((sprite,index)=>{
            const image=particleGroups[sprite.group];
            if(!image)return;
            const phase=index*2.3999632297;
            const lag=.12+(index%7)*.045;
            const cx=sprite.x+sprite.w/2,cy=sprite.y+sprite.h/2;
            // Analytic delayed motion gives soft following without frame-rate-dependent physics.
            // Subtract the parent's current hover so glints trail the butterfly's earlier position.
            function follow(t){
              const beat=(1-Math.cos(t*TAU*rate-lag))*.5;
              return {
                x:Math.sin(t*TAU*.125)*rig.width*.003-drift+
                  Math.sin(t*TAU*.25+phase)*5+Math.sin(t*TAU*rate-lag)*3,
                y:Math.sin(t*TAU*.25)*rig.height*.006-hover+
                  Math.sin(t*TAU*.25+phase*.35)*9-beat*7,
                beat,
                alpha:.82*Math.pow((1+Math.sin(t*TAU*rate+phase))*.5,1.6)
              };
            }
            // Two faint history samples and one main glint: a short, restrained golden trace.
            for(const trail of PARTICLE_TRAILS){
              const state=follow(time-lag-trail.age);
              const scale=1+.035*state.beat;
              ctx.save();
              ctx.globalAlpha=clamp(state.alpha*trail.weight,0,1);
              ctx.translate(cx+state.x,cy+state.y);ctx.scale(scale,scale);
              ctx.drawImage(image,sprite.x,sprite.y,sprite.w,sprite.h,-sprite.w/2,-sprite.h/2,sprite.w,sprite.h);
              ctx.restore();
            }
          });
        }else{
          // Still/reduced-motion mode keeps the original artwork intact.
          const layers=particleGroups.length?particleGroups:images.particles?[images.particles]:[];
          layers.forEach((image,index)=>{
            const beat=(1-Math.cos(time*TAU*rate-index*.13))*.5;
            ctx.save();ctx.globalAlpha=still?1:.18+.75*beat;
            if(!still)ctx.translate(Math.sin(time*TAU*.125+index)*7,-beat*12);
            ctx.drawImage(image,0,0);ctx.restore();
          });
        }
      }
      // Perspective fold around a stable body hinge. No sprite spin or wing-root travel.
      function wing(side) {
        const left=side==='left';
        const fold=still?0:(left?wave:farWave)*1.08;
        const squeeze=Math.cos(fold);
        // n points down-left. Each side's depth moves gently toward the head.
        const sign=left?1:-1;
        const shear=-sign*Math.sin(fold)*.20;
        // Construct M = squeeze*n*n^T + shear*b*n^T + b*b^T explicitly.
        const m00=squeeze*n.x*n.x+shear*b.x*n.x+b.x*b.x;
        const m01=squeeze*n.x*n.y+shear*b.x*n.y+b.x*b.y;
        const m10=squeeze*n.y*n.x+shear*b.y*n.x+b.y*b.x;
        const m11=squeeze*n.y*n.y+shear*b.y*n.y+b.y*b.y;
        ctx.save();ctx.translate(pivot.x,pivot.y);ctx.transform(m00,m10,m01,m11,0,0);ctx.translate(-pivot.x,-pivot.y);
        const key=left?'left':'right';
        const tail=tails[key];
        if(tail&&flutterActive)drawTail(ctx,tail,time,left?1.7:0,rig.width*.0045*flutterEnvelope);
        else if(images[key+'Tail'])ctx.drawImage(images[key+'Tail'],0,0);
        if(images[key+'Hindwing'])ctx.drawImage(images[key+'Hindwing'],0,0);
        if(images[key+'Forewing'])ctx.drawImage(images[key+'Forewing'],0,0);
        ctx.restore();
      }
      wing('right');wing('left');
      if(images.body)ctx.drawImage(images.body,0,0);
      if(typeof options.onFrame==='function')options.onFrame({time:ms,fold:wave,flutter:flutterEnvelope,still,canvas,pixelRatio:size.dpr});
    }
    const canAnimate=()=>ready&&playing&&!destroyed&&!isStill()&&!document.hidden&&!pageSuspended;
    function stopFrames(){
      if(frame)global.cancelAnimationFrame(frame);
      frame=0;lastNow=null;lastDrawNow=null;
    }
    function schedule(){
      if(!frame&&canAnimate())frame=global.requestAnimationFrame(tick);
    }
    function tick(now) {
      frame=0;
      if(!canAnimate())return;
      if(lastNow!==null)elapsed+=Math.min(now-lastNow,100)*speed;
      lastNow=now;
      const interval=lastDrawNow===null?frameInterval:now-lastDrawNow;
      if(interval+.01>=frameInterval){
        lastDrawNow=lastDrawNow===null?now:lastDrawNow+Math.floor((interval+.01)/frameInterval)*frameInterval;
        draw(elapsed);
      }
      schedule();
    }
    function play(){if(destroyed)return;playing=true;schedule();}
    function pause(){playing=false;stopFrames();}
    function refreshMotion(){stopFrames();draw(elapsed);schedule();}
    function onVisibility(){stopFrames();schedule();}
    function onPageHide(){pageSuspended=true;stopFrames();}
    function onPageShow(){pageSuspended=false;resize();schedule();}
    function onReduced(event){
      if(options.reducedMotion!==undefined&&options.reducedMotion!=='auto')return;
      reduced=event.matches;refreshMotion();
    }
    media.addEventListener?.('change',onReduced);
    document.addEventListener('visibilitychange',onVisibility);
    global.addEventListener('pagehide',onPageHide);
    global.addEventListener('pageshow',onPageShow);
    const api={
      ready:null,play,pause,loopDurationMs:16000,
      renderAt(ms){pause();elapsed=Math.max(0,Number(ms)||0);draw(elapsed);return api;},
      setSpeed(value){speed=clamp(Number(value)||1,.1,3);return api;},
      setReducedMotion(value){reduced=Boolean(value);refreshMotion();return api;},
      setMotion(value){forcedStatic=!value;refreshMotion();return api;},
      resize,
      get state(){return {ready,playing,speed,time:elapsed,reducedMotion:reduced,motion:!forcedStatic,pixelRatio:size.dpr};},
      destroy(){
        pause();destroyed=true;observer?.disconnect();global.removeEventListener('resize',resize);
        media.removeEventListener?.('change',onReduced);document.removeEventListener('visibilitychange',onVisibility);
        global.removeEventListener('pagehide',onPageHide);global.removeEventListener('pageshow',onPageShow);
        ctx.clearRect(0,0,canvas.width,canvas.height);
      }
    };
    api.ready=(async()=>{
      rig=options.rig||global.BUTTERFLY_RIG;
      if(!rig){const response=await fetch(new URL('rig.json',base));if(!response.ok)throw new Error('无法加载蝴蝶关节数据');rig=await response.json();}
      if(!rig.width||!rig.height||!rig.pivot)throw new Error('蝴蝶关节数据缺少画布尺寸或翅根坐标');
      const sources={...FILES,...(rig.assets||{}),...(global.BUTTERFLY_ASSETS||{}),...(options.assets||{})};
      const groupSources=options.particleGroups||global.BUTTERFLY_PARTICLE_GROUPS||rig.particleGroups||[];
      const imageRequests=new Map();
      function requestImage(source){
        const src=new URL(source,base).href;
        if(!imageRequests.has(src))imageRequests.set(src,loadImage(src));
        return imageRequests.get(src);
      }
      async function loadParticles(){
        if(options.particles===false)return;
        if(groupSources.length){
          try{particleGroups=await Promise.all(groupSources.map(requestImage));return;}
          catch(error){particleGroups=[];options.onWarning?.(error);}
        }
        // The composite duplicates the grouped artwork. Download it only as a fallback.
        if(sources.particles)try{images.particles=await requestImage(sources.particles);}catch{ /* Optional glints. */ }
      }
      await Promise.all([
        ...KEYS.filter(key=>key!=='particles').map(async key=>{
          if(sources[key]!==null)images[key]=await requestImage(sources[key]);
        }),
        loadParticles()
      ]);
      if(destroyed)return api;
      tails.left=prepareTail(images.leftTail,rig.tails?.left);tails.right=prepareTail(images.rightTail,rig.tails?.right);
      ready=true;resize();schedule();
      options.onReady?.(api);return api;
    })().catch(error=>{api.destroy();options.onError?.(error);throw error;});
    return api;
  }
  global.mountButterfly=mountButterfly;
})(window);
