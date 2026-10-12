/* The original scene stays intact. This layer adds the thread and the next screen. */
(function (root) {
  'use strict';
  const scene = typeof module !== 'undefined' && module.exports ? require('./scene.js') : root.PinkyScene;
  const duration = 10.1;
  const timing = { drop: 4.8, pan: 5.35, panEnd: 7.35, borderEnd: 9.65, form: 8.95 };
  const clamp = n => Math.max(0, Math.min(1, n));
  const ease = n => { n = clamp(n); return n * n * n * (n * (n * 6 - 15) + 10); };
  // Short acceleration/deceleration ramps leave the long strand at a steady pace.
  const reveal = n => {
    n = clamp(n);
    const ramp = .06;
    if (n < ramp) return n*n/(2*ramp*(1-ramp));
    if (n > 1-ramp) return 1-(1-n)*(1-n)/(2*ramp*(1-ramp));
    return (n-ramp/2)/(1-ramp);
  };
  const point = (x, y) => ({ x, y });

  // Visible portions end inside the existing finger folds; the hands hide the rest.
  const grips = [
    { left: [152, 93], right: [438, 116], bridge: [[261, 184], [354, 184]] },
    { left: [137, 92], right: [433, 116], bridge: [[257, 182], [350, 185]] },
    { left: [138, 92], right: [407, 116], bridge: [[258, 182], [367, 180]] },
    { left: [141, 92], right: [399, 121], bridge: [[261, 184], [356, 184]] },
    { left: [155, 81], right: [397, 115], bridge: [[271, 186], [362, 184]] },
    { left: [140, 80], right: [386, 109], bridge: [[261, 180], [348, 177]] },
    { left: [137, 73], right: [389, 98], bridge: [[256, 171], [348, 167]] },
    { left: [138, 81], right: [389, 110], bridge: [[256, 185], [347, 178]] },
  ];
  // These foreground contours come from the unchanged cel, in its 485×385 space.
  // Clipping only the new rope leaves every hand pixel already on the canvas intact.
  const foreground = {
    thumb:[[108,61],[113,57],[128,50],[141,43],[151,34],[159,27],[164,29],[167,34],[168,41],[166,49],[161,59],[155,67],[148,73],[142,77],[139,83],[136,89],[130,95],[119,101],[107,105],[98,99]],
    index:[[135,94],[141,90],[148,85],[154,78],[161,69],[170,59],[175,77],[164,99],[144,107],[132,103]],
    ring:[[330,156],[344,156],[351,162],[355,169],[355,173],[352,176],[348,176],[342,174],[335,170],[329,165]],
    femaleIndex:[[357,115],[368,111],[373,117],[379,127],[374,139],[362,143],[356,133]],
    palmWrist:[[429,132],[434,138],[437,145],[438,153],[438,177],[438,196],[435,207],[437,221],[448,241],[457,251],[440,279],[414,290],[405,287],[396,281],[388,272],[381,264],[374,257],[367,250],[367,235],[386,215],[412,196],[421,176],[424,145]],
  };

  function curve(points, a, b, c) {
    const p = points[points.length - 1];
    for (let i = 1; i <= 28; i++) {
      const t = i / 28, u = 1 - t;
      points.push(point(u*u*u*p.x + 3*u*u*t*a.x + 3*u*t*t*b.x + t*t*t*c.x,
        u*u*u*p.y + 3*u*u*t*a.y + 3*u*t*t*b.y + t*t*t*c.y));
    }
    return points;
  }
  function length(points) {
    let result = 0;
    for (let i = 1; i < points.length; i++) result += Math.hypot(points[i].x-points[i-1].x, points[i].y-points[i-1].y);
    return result;
  }
  function trace(ctx, points, progress) {
    if (!points.length || progress <= 0) return;
    let remaining = length(points) * clamp(progress);
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const a = points[i-1], b = points[i], d = Math.hypot(b.x-a.x, b.y-a.y);
      if (remaining >= d) { ctx.lineTo(b.x,b.y); remaining -= d; }
      else { const k = d ? remaining/d : 0; ctx.lineTo(a.x+(b.x-a.x)*k,a.y+(b.y-a.y)*k); break; }
    }
  }
  function behindHands(ctx,polygons,width,height,draw) {
    ctx.save();
    for(const polygon of polygons){
      // The hand scene itself ends at the first viewport; its mask must end there too.
      const clipped=[];
      let a=polygon[polygon.length-1];
      for(const b of polygon){
        if((a.y<=height)!==(b.y<=height)){
          const t=(height-a.y)/(b.y-a.y);clipped.push(point(a.x+(b.x-a.x)*t,height));
        }
        if(b.y<=height)clipped.push(b);
        a=b;
      }
      if(clipped.length<3)continue;
      ctx.beginPath();ctx.rect(-width,-height,width*3,height*4);
      ctx.moveTo(clipped[0].x,clipped[0].y);
      for(let i=1;i<clipped.length;i++)ctx.lineTo(clipped[i].x,clipped[i].y);
      ctx.closePath();ctx.clip('evenodd');
    }
    draw();ctx.restore();
  }
  function stroke(ctx, points, progress, width, unit) {
    if (progress <= 0 || points.length < 2) return;
    ctx.save(); ctx.lineCap='round'; ctx.lineJoin='round';
    ctx.beginPath(); trace(ctx,points,progress);
    // A continuous shaded core carries the silhouette; the fine fibers never notch it.
    ctx.strokeStyle='#892735'; ctx.lineWidth=width+.45*unit; ctx.stroke();
    ctx.strokeStyle='#b53747'; ctx.lineWidth=width; ctx.stroke();
    ctx.strokeStyle='rgba(223,103,110,.27)'; ctx.lineWidth=width*.68; ctx.stroke();

    const distances=[0];
    for(let i=1;i<points.length;i++) distances.push(distances[i-1]+Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y));
    const visible=distances[distances.length-1]*clamp(progress);
    function at(distance,across=0) {
      distance=Math.max(0,Math.min(visible,distance));
      let lo=0,hi=distances.length-1;
      while(lo+1<hi){const mid=(lo+hi)>>1;if(distances[mid]<distance)lo=mid;else hi=mid;}
      const a=points[lo],b=points[hi],span=distances[hi]-distances[lo];
      const t=span?(distance-distances[lo])/span:0;
      const before=points[Math.max(0,lo-1)],after=points[Math.min(points.length-1,hi+1)];
      const ax=b.x-before.x,ay=b.y-before.y,al=Math.hypot(ax,ay)||1;
      const bx=after.x-a.x,by=after.y-a.y,bl=Math.hypot(bx,by)||1;
      const tx=ax/al*(1-t)+bx/bl*t,ty=ay/al*(1-t)+by/bl*t,tl=Math.hypot(tx,ty)||1;
      return point(a.x+(b.x-a.x)*t-ty/tl*across,a.y+(b.y-a.y)*t+tx/tl*across);
    }
    // The phase is measured from the complete path origin, so it stays still as
    // the drawing tip advances, is paused, or is sought to an earlier frame.
    const pitch=width*.92,step=Math.max(.8*unit,width*.16);
    ctx.beginPath();
    for(const offset of [-.23,.12]){
      for(let s=0;s<=visible+step;s+=step){
        const distance=Math.min(s,visible),p=at(distance,width*(offset+.018*Math.sin(distance/pitch*2.1)));
        if(s===0)ctx.moveTo(p.x,p.y);else ctx.lineTo(p.x,p.y);
      }
    }
    ctx.strokeStyle='rgba(246,170,163,.22)';ctx.lineWidth=Math.max(.18*unit,width*.035);ctx.stroke();

    // Close, low-contrast diagonal filaments suggest a twisted red cord, rather
    // than alternating colored bands or a row of separately shaded beads.
    function twist(shift) {
      ctx.beginPath();
      for(let s=pitch*.4;s<visible+width*.22;s+=pitch){
        let started=false;
        for(let i=0;i<=8;i++){
          const v=-.84+i*.21,distance=s+width*(v*.23+.09*(1-v*v))+shift;
          if(distance<0||distance>visible){started=false;continue;}
          const p=at(distance,v*width*.46);
          if(!started){ctx.moveTo(p.x,p.y);started=true;}else ctx.lineTo(p.x,p.y);
        }
      }
    }
    twist(0);ctx.strokeStyle='rgba(104,28,43,.28)';ctx.lineWidth=Math.max(.23*unit,width*.055);ctx.stroke();
    twist(-width*.075);ctx.strokeStyle='rgba(241,145,145,.22)';ctx.lineWidth=Math.max(.17*unit,width*.035);ctx.stroke();
    ctx.restore();
  }
  function layout(width,height,unit = width > height*1.12 ? width/1440 : width/390) {
    const frameWidth = Math.min(width-44*unit,440*unit);
    const frameHeight = Math.min(352*unit, height-112*unit);
    return { left:(width-frameWidth)/2, top:(height-frameHeight)/2-12*unit, width:frameWidth, height:frameHeight, unit };
  }
  function stateAt(time,width,height,unit) {
    return { camera:height*ease((time-timing.pan)/(timing.panEnd-timing.pan)),
      form: ease((time-timing.form)/.7), frame:layout(width,height,unit), ended:time>=duration };
  }
  function paths(width,height,time,unit) {
    const f = scene.framing(width,height), pose=scene.poseAt(Math.min(time,scene.duration));
    const g=grips[pose.index];
    const bob=pose.index===7?-1.8*Math.sin(pose.settle*Math.PI):0;
    const convert=(x,y)=>point(f.x+x*f.scale,f.y+(y+bob)*f.scale);
    const left=convert(g.left[0]+5,g.left[1]+9), right=convert(g.right[0]-13+pose.entrance*300,g.right[1]+12+pose.entrance*22);
    const top=[point(left.x-8*f.scale,-18*f.scale)];
    curve(top,point(left.x-22*f.scale,height*.21),point(left.x-30*f.scale,left.y-57*f.scale),left);
    const bridge=[convert(g.bridge[0][0]-1,g.bridge[0][1]+4)];
    const end=convert(g.bridge[1][0],g.bridge[1][1]-4.5);
    // A low, soft U has a quiet horizontal bottom and tucks under the curled finger.
    const span=end.x-bridge[0].x, bridgeLow=Math.max(bridge[0].y,end.y)+23*f.scale;
    const bridgeMiddle=point(bridge[0].x+span*.54,bridgeLow);
    curve(bridge,point(bridge[0].x+span*.18,bridge[0].y+14*f.scale),point(bridgeMiddle.x-span*.2,bridgeLow),bridgeMiddle);
    curve(bridge,point(bridgeMiddle.x+span*.25,bridgeLow),point(end.x-span*.11,end.y+22*f.scale),end);

    // Rise out of the finger fold, arch around the outside, then pass behind the palm.
    const side=[point(right.x-5*f.scale,right.y+3*f.scale)];
    curve(side,point(right.x-3*f.scale,right.y+2*f.scale),point(right.x-f.scale,right.y+.7*f.scale),right);
    curve(side,point(right.x+21*f.scale,right.y-15*f.scale),point(right.x+48*f.scale,right.y-25*f.scale),point(right.x+62*f.scale,right.y-12*f.scale));
    curve(side,point(right.x+71*f.scale,right.y-2*f.scale),point(right.x+69*f.scale,right.y+21*f.scale),point(right.x+58*f.scale,right.y+41*f.scale));
    curve(side,point(right.x+59*f.scale,right.y+83*f.scale),point(right.x+34*f.scale,right.y+117*f.scale),point(right.x+11*f.scale,right.y+138*f.scale));
    const tail=[side[side.length-1]];
    const box=layout(width,height,unit), y=height+box.top, l=box.left, r=l+box.width, b=y+box.height, u=box.unit;
    const start=tail[0], entry=point(r-20*u,y);
    const radius=Math.max(2*u,Math.min(32*u,width-entry.x-10*u,Math.max(0,y-start.y)*.22));
    const turn=point(entry.x+radius,y-radius);
    // Rejoin the earlier relaxed fall before page two, retaining its gentle entry.
    const formerStart=convert(g.right[0]+40+pose.entrance*300,g.right[1]+89+pose.entrance*22);
    const fall=turn.y-formerStart.y;
    const sway=Math.min(width*.06,32*u,Math.max(0,fall)*.13);
    const middle=point((formerStart.x+turn.x)/2-sway,formerStart.y+fall*.57);
    if(middle.y>start.y+35*u){
      const lead=Math.min(30*f.scale,(middle.y-start.y)*.22);
      curve(tail,point(start.x-6*f.scale,start.y+lead),point(middle.x,middle.y-fall*.17),middle);
      curve(tail,point(middle.x,middle.y+fall*.17),point(turn.x,turn.y-fall*.17),turn);
    }else{
      // A short landscape viewport has no room for a long visible fall below the wrist.
      curve(tail,point(start.x-18*u,start.y+8*u),point(turn.x,turn.y-18*u),turn);
    }
    // A round quarter-turn carries the falling line into the leftward frame stroke.
    const arc=.55228475*radius;
    curve(tail,point(turn.x,turn.y+arc),point(entry.x+arc,entry.y),entry);

    // A single continuous loop, arriving on the right and leaving on the left.
    const border=[tail[tail.length-1]];
    const topMiddle=point(l+box.width*.52,y+3*u);
    curve(border,point(r-70*u,y-2*u),point(topMiddle.x+34*u,y+4*u),topMiddle);
    curve(border,point(topMiddle.x-44*u,y+2*u),point(l+74*u,y-4*u),point(l+22*u,y));
    curve(border,point(l-4*u,y-3*u),point(l-5*u,y+27*u),point(l,y+66*u));
    curve(border,point(l+6*u,y+box.height*.29),point(l-5*u,y+box.height*.43),point(l-3*u,y+box.height*.55));
    curve(border,point(l-1*u,y+box.height*.69),point(l+6*u,b-74*u),point(l+2*u,b-24*u));
    curve(border,point(l+4*u,b+9*u),point(l+28*u,b+3*u),point(l+58*u,b+1*u));
    const bottomMiddle=point(l+box.width*.56,b+2*u);
    curve(border,point(l+125*u,b-5*u),point(bottomMiddle.x-30*u,b+1*u),bottomMiddle);
    curve(border,point(bottomMiddle.x+38*u,b+3*u),point(r-63*u,b-4*u),point(r-25*u,b));
    curve(border,point(r+2*u,b-2*u),point(r+1*u,b-27*u),point(r-1*u,b-54*u));
    curve(border,point(r+1*u,b-92*u),point(r-7*u,y+box.height*.65),point(r-4*u,y+box.height*.49));
    curve(border,point(r-2*u,y+box.height*.33),point(r+5*u,y+79*u),point(r-1*u,y+31*u));
    curve(border,point(r-2*u,y+9*u),point(r-7*u,y+1*u),point(r-20*u,y));
    const firstTurnEnd=border.length-1;
    // The second turn rests against the first, crossing it gently in a few places.
    const ropeWidth=4.5*f.scale;
    const knot=point(l+Math.max(35*u,ropeWidth*3.55),y-Math.max(9*u,ropeWidth*1.1));
    const leftLoop=Math.max(28*u,ropeWidth*3.3),rightLoop=Math.max(32*u,ropeWidth*3.8);
    const loopHeight=Math.max(15*u,ropeWidth*1.7);
    curve(border,point(r-box.width*.12,y-ropeWidth*.18),point(r-box.width*.27,y-ropeWidth*.82),point(r-box.width*.35,y-ropeWidth*.75));
    curve(border,point(r-box.width*.5,y-ropeWidth*.6),point(l+box.width*.62,y+ropeWidth*.75),point(l+box.width*.42,y+ropeWidth*.65));
    // Enter under the right loop, so no straight strand cuts through its open eye.
    curve(border,point(l+box.width*.30,y+ropeWidth*.6),point(knot.x+37*u,knot.y+ropeWidth*.8),point(knot.x-ropeWidth*.15,knot.y+ropeWidth*.72));
    const returnEnd=border.length-1;
    // Soft, mostly horizontal loops lean in opposite directions around the binding.
    curve(border,point(knot.x-leftLoop*.35,knot.y-loopHeight*.85),point(knot.x-leftLoop*1.05,knot.y-loopHeight*1.15),point(knot.x-leftLoop,knot.y+loopHeight*.12));
    curve(border,point(knot.x-leftLoop*.94,knot.y+loopHeight*.97),point(knot.x-leftLoop*.4,knot.y+loopHeight*.9),point(knot.x+ropeWidth*.05,knot.y+ropeWidth*.22));
    const leftLoopEnd=border.length-1;
    curve(border,point(knot.x+rightLoop*.37,knot.y+loopHeight*.85),point(knot.x+rightLoop*1.04,knot.y+loopHeight*.3),point(knot.x+rightLoop,knot.y-loopHeight*.35));
    curve(border,point(knot.x+rightLoop*.96,knot.y-loopHeight),point(knot.x+rightLoop*.45,knot.y-loopHeight*1.03),point(knot.x+ropeWidth*.24,knot.y-ropeWidth*.5));
    const rightLoopEnd=border.length-1;
    // A narrow slanted wrap gathers the loop roots into a recognisable tied centre.
    curve(border,point(knot.x+ropeWidth*.37,knot.y-ropeWidth*.05),point(knot.x+ropeWidth*.03,knot.y+ropeWidth*.48),point(knot.x-ropeWidth*.22,knot.y+ropeWidth*.78));
    // The loose end falls inside the left margin, safely before the title and fields.
    curve(border,point(knot.x-ropeWidth*.55,knot.y+ropeWidth),point(l+16*u,y+22*u),point(l+24*u,y+42*u));
    curve(border,point(l+27*u,y+55*u),point(l+36*u,y+57*u),point(l+34*u,y+70*u));
    // One arc-length clock carries the visible tip across every join without a pause.
    const strand=side.concat(tail.slice(1),border.slice(1));
    // Paint the return and knot over the earlier cord, keeping its dark edge at crossings.
    const strandSections=[side.concat(tail.slice(1),border.slice(1,firstTurnEnd+1)),
      border.slice(firstTurnEnd,returnEnd+1),border.slice(returnEnd,leftLoopEnd+1),
      border.slice(leftLoopEnd,rightLoopEnd+1),border.slice(rightLoopEnd)];
    const moved=(polygon,dx=0,dy=0)=>polygon.map(p=>convert(p[0]+dx,p[1]+dy));
    const maleDX=g.left[0]-138,maleDY=g.left[1]-81;
    const ringDX=g.bridge[1][0]-347,ringDY=g.bridge[1][1]-178;
    const femaleDX=g.right[0]-389+pose.entrance*300,femaleDY=g.right[1]-110+pose.entrance*22;
    const masks={top:[moved(foreground.thumb,maleDX,maleDY),moved(foreground.index,maleDX,maleDY)],
      bridge:[moved(foreground.ring,ringDX,ringDY)],
      side:[moved(foreground.femaleIndex,femaleDX,femaleDY),moved(foreground.palmWrist,femaleDX,femaleDY)]};
    return { top,bridge,side,tail,border,strand,strandSections,masks,scale:f.scale,unit:u,pose };
  }
  let cache=null;
  function finalCanvas(sheet,width,height) {
    if(cache&&cache.sheet===sheet&&cache.width===width&&cache.height===height)return cache.canvas;
    const canvas=typeof document!=='undefined'?document.createElement('canvas'):require('@napi-rs/canvas').createCanvas(width,height);
    canvas.width=width; canvas.height=height;
    // Freeze the exact departure pose, including the cord's remaining gentle sway.
    scene.render(canvas.getContext('2d'),sheet,width,height,timing.pan);
    cache={canvas,sheet,width,height}; return canvas;
  }
  function render(ctx,sheet,width,height,time,unit) {
    const state=stateAt(time,width,height,unit);
    if(state.camera===0) scene.render(ctx,sheet,width,height,Math.min(time,scene.duration));
    else {
      ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
      if(state.camera<height)ctx.drawImage(finalCanvas(sheet,width,height),0,-state.camera);
      ctx.restore();
    }
    const p=paths(width,height,time,unit);
    ctx.save();ctx.setTransform(1,0,0,1,0,-state.camera);
    // Restore the original cord's weight, with the same artwork-relative scaling.
    const threadWidth=4.5*p.scale;
    behindHands(ctx,p.masks.top,width,height,()=>stroke(ctx,p.top,ease((time-scene.introDuration)/.85),threadWidth,p.unit));
    if(p.pose.index>=2)behindHands(ctx,p.masks.bridge,width,height,()=>stroke(ctx,p.bridge,ease((time-3.37)/.65),threadWidth,p.unit));
    let remaining=length(p.strand)*reveal((time-timing.drop)/(timing.borderEnd-timing.drop));
    for(let i=0;i<p.strandSections.length;i++){
      const section=p.strandSections[i];
      const distance=length(section);
      if(remaining<=0)break;
      const draw=()=>stroke(ctx,section,clamp(remaining/distance),threadWidth,p.unit);
      if(i===0)behindHands(ctx,p.masks.side,width,height,draw);else draw();
      remaining-=distance;
    }
    ctx.restore();
    return state;
  }
  const api={duration,timing,stateAt,layout,paths,render};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PinkyJourney=api;
})(typeof window!=='undefined'?window:globalThis);
