// Shared game shell behaviour -- loaded by BOTH template.html and
// player.html. Edit here, never in a shell.
/* ── Mobile responsive scaling ── */
(function(){
  var _c=null;
  function _scale(){
    if(!_c)_c=document.getElementById('game-container');
    if(!_c)return;
    var vw=window.innerWidth,vh=window.innerHeight;
    // Was capped at 1, so a 27" display showed a 768x576 box adrift in empty
    // space. Fill what is available instead, leaving a margin, and cap the
    // upscale so the pixel art stays crisp rather than mushy.
    // In fullscreen there is no browser chrome to leave room for and the stage
    // is the only thing on screen, so the margin shrinks and the cap lifts.
    var full=!!(document.fullscreenElement||document.webkitFullscreenElement);
    var pad=full?0.995:0.96, padY=full?0.995:0.94, cap=full?3:1.7;
    var s=Math.min((vw*pad)/768,(vh*padY)/576,cap);
    if(s<0.999||s>1.001){
      _c.style.position='fixed';
      _c.style.top='50%';
      _c.style.left='50%';
      _c.style.transform='translate(-50%,-50%) scale('+s+')';
      _c.style.transformOrigin='center center';
      _c.style.margin='0';
    }else{
      _c.style.position='';
      _c.style.top='';
      _c.style.left='';
      _c.style.transform='';
      _c.style.transformOrigin='';
      _c.style.margin='';
    }
  }
  window.__edgcScale=_scale;          // fullscreen re-runs this
  window.addEventListener('resize',_scale);
  ['fullscreenchange','webkitfullscreenchange'].forEach(function(e){
    document.addEventListener(e,function(){setTimeout(_scale,60)});
  });
  window.addEventListener('orientationchange',function(){setTimeout(_scale,200)});
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',_scale);}
  _scale();
})();
/* Fullscreen.
   The whole document goes fullscreen, not the stage: the stage is positioned
   with a transform by the scaler, and fullscreening a transformed element
   makes the browser letterbox it at its untransformed size. With the document
   fullscreen the existing scaler simply sees a bigger viewport and fills it. */
window.toggleFullscreen = function () {
  var root = document.documentElement;
  var active = document.fullscreenElement || document.webkitFullscreenElement;
  var done;
  if (active) {
    done = (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
  } else {
    var request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!request) return;
    done = request.call(root);
  }
  if (done && done.catch) done.catch(function () { /* refused: stay windowed */ });
};

(function () {
  var btn = document.getElementById('fullscreen-btn');
  if (!btn) return;
  // Hide the control where the API does not exist (iPhone Safari), rather
  // than offering a button that silently does nothing.
  var root = document.documentElement;
  if (!(root.requestFullscreen || root.webkitRequestFullscreen)) { btn.style.display = 'none'; return; }
  function sync() {
    var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    btn.innerHTML = on ? '&#10717;' : '&#9974;';
    btn.setAttribute('aria-pressed', String(on));
  }
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (e) {
    document.addEventListener(e, sync);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'f' && !/input|textarea/i.test((e.target && e.target.tagName) || '')) window.toggleFullscreen();
  });
  sync();
})();

/* ── Fit minigame content to the stage ────────────────────────────────────
   The overlay reserves bands top and bottom for host chrome (sound and
   settings above, report and skip below), which leaves about 454px of a
   576px stage. A generated minigame sizes its own canvas with no knowledge
   of that band -- it cannot have any -- so anything taller produced a
   scrollbar, which is the stage admitting it does not fit.

   The host is the only party that knows the band, so the host is what
   resizes. Content is scaled down to fit and never up, so nothing is
   enlarged into mush. The transform is the same kind the stage scaler
   already applies around all of this, and pointer math is unaffected either
   way a minigame reads it: getBoundingClientRect() reflects the transform,
   and offsetX/offsetY report the element's own untransformed space. */
(function () {
  var ov = null, pending = 0;

  function fit() {
    pending = 0;
    ov = ov || document.getElementById('mini-game-overlay');
    if (!ov || getComputedStyle(ov).display === 'none') return;
    var kid = ov.firstElementChild;
    if (!kid) return;

    // Measure unscaled, or each pass would compound the last one's shrink.
    kid.style.transform = '';
    var cs = getComputedStyle(ov);
    var band = ov.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    var room = ov.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    var h = kid.offsetHeight, w = kid.offsetWidth;
    if (!h || !w || (h <= band && w <= room)) return;

    var s = Math.min(band / h, room / w, 1);
    if (s < 0.999) {
      kid.style.transformOrigin = 'top center';
      kid.style.transform = 'scale(' + s + ')';
      // Transforms do not shrink the layout box, so the overlay would still
      // consider itself overflowing and leave a scroll offset behind. Pull
      // the box in to match what is now drawn.
      kid.style.marginBottom = -(h * (1 - s)) + 'px';
      ov.scrollTop = 0;
    } else {
      kid.style.marginBottom = '';
    }
  }

  function schedule() {
    if (pending) return;
    pending = requestAnimationFrame(fit);
  }

  function start() {
    ov = document.getElementById('mini-game-overlay');
    if (!ov) return;

    // Deliberately childList only, never attributes: fit() sets a transform
    // on the child, and an attribute observer would see its own write and
    // reschedule itself every frame for as long as a minigame is open.
    new MutationObserver(schedule).observe(ov, { childList: true, subtree: true });

    // A canvas that grows after mount changes the child's border-box, which
    // a transform never does -- so watching the child's size catches late
    // layout without the observer tripping over fit()'s own output.
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(schedule);
      var watched = null;
      var rewatch = function () {
        var kid = ov.firstElementChild;
        if (kid === watched) return;
        if (watched) ro.unobserve(watched);
        watched = kid;
        if (kid) ro.observe(kid);
      };
      new MutationObserver(rewatch).observe(ov, { childList: true });
      rewatch();
      ro.observe(ov);
    }

    window.addEventListener('resize', schedule);
    schedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
