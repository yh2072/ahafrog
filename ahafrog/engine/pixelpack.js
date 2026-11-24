// Created by Yuqi Hang (github.com/yh2072)
/**
 * Pixel-pack runtime — draws scenes and characters from the licensed 16-bit
 * asset pack instead of model-written canvas rectangles.
 *
 * The art layer is adapted from the owner's own AhaFrog pixel-game template
 * (its scene composer, stamp table and sprite drawing). Only the rendering is
 * taken: AhaFrog keeps its own pipeline, content format and generation
 * flow, and none of that template's game schema or agent workflow is here.
 *
 *   PixelPack.scene({preset:'village', seed:3, props:[{stamp:'house_red', x:140, y:100}]})
 *                                        -> a composed 320x240 scene canvas
 *   PixelPack.sprite(g, 'character', 'Monk', x, y, {scale:3, dir:'down'})
 *   PixelPack.backdrop(g, spec, x, y, w, h)   -> scene behind a simulation
 *
 * Everything degrades. When the pack is not served every call returns false
 * and the caller keeps its existing drawing, so a generated game opened
 * without the art still runs.
 *
 * Pack layout:
 *   character|monster/<Name>/SpriteSheet.png  4 directions x 7 rows of 16x16
 *   character|monster/<Name>/Faceset.png      38x38 portrait
 *   background/Tilesets/<Name>.png            16x16 tile grid
 *   items/<Group>/<Name>.png · ui/Emote/emote<N>.png
 */
(function () {
  'use strict';
  var BASE = (window.PIXELPACK_BASE || '/assets/pixelpack/');
  var PixelPack = window.PixelPack = { W: 320, H: 240, TILE: 16 };

  var PixelPack = window.PixelPack = { W: 320, H: 240, TILE: 16, active: false, speaker: null, face: null };

  // ── images ────────────────────────────────────────────────────────────────
  var images = {};
  function img(path) {
    var i = images[path]; if (i) return i;
    i = images[path] = new Image(); i._ready = new Promise(function (res) { i.onload = function () { res(i); }; i.onerror = function () { i._failed = true; res(i); }; });
    i.src = BASE + encodeURI(path); return i;
  }
  function ok(i) { return !!(i && i.complete && i.naturalWidth > 0); }
  PixelPack.img = img; PixelPack.ok = ok;
  PixelPack.preload = function (paths) { return Promise.all(paths.map(function (p) { return img(p)._ready; })); };
  var SHEETS = { field: 'background/Tilesets/TilesetField.png', water: 'background/Tilesets/TilesetWater.png', house: 'background/Tilesets/TilesetHouse.png', nature: 'background/Tilesets/TilesetNature.png' };
  var UI = ['ui/Dialog/DialogBoxFaceset.png', 'ui/Dialog/DialogBox.png', 'ui/Receptacle/Heart.png', 'ui/Arrow.png', 'ui/Emote/emote12.png', 'ui/Emote/emote5.png'];

  // ── deterministic randomness ──────────────────────────────────────────────
  function rng(seed) { var a = (seed >>> 0) || 7; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ── terrain: 3×3 patches and fill tiles from TilesetField / TilesetWater ──
  var GROUND = { sand: [0, 0], grass: [0, 3], forest: [0, 6], blossom: [0, 9], snow: [0, 12] };
  function tile(g, im, sx, sy, dx, dy) { g.drawImage(im, sx * 16, sy * 16, 16, 16, dx, dy, 16, 16); }
  function fillGround(g, kind, R) {
    var o = GROUND[kind] || GROUND.grass, im = img(SHEETS.field), x, y;
    for (y = 0; y < 15; y++) for (x = 0; x < 20; x++) tile(g, im, o[0] + 1, o[1] + 1, x * 16, y * 16);
  }
  /** 9-slice patch on the tile grid. open: letters t b l r make that side blend into whatever is already there. */
  function patch(g, im, ox, oy, tx, ty, tw, th, open) {
    open = open || '';
    for (var j = 0; j < th; j++) for (var i = 0; i < tw; i++) {
      var cx = i === 0 && open.indexOf('l') < 0 ? 0 : i === tw - 1 && open.indexOf('r') < 0 ? 2 : 1;
      var cy = j === 0 && open.indexOf('t') < 0 ? 0 : j === th - 1 && open.indexOf('b') < 0 ? 2 : 1;
      tile(g, im, ox + cx, oy + cy, (tx + i) * 16, (ty + j) * 16);
    }
  }
  var WATER = { sand: [0, 0], grass: [0, 6] };

  // ── stamps: ready-made objects cut out of the tilesets (tile units; transparent margins are trimmed) ──
  var STAMPS = {
    house_orange: ['house', 0, 0, 4, 3], house_beige: ['house', 4, 0, 4, 3], house_cottage: ['house', 8, 0, 4, 3], house_red: ['house', 12, 0, 4, 3],
    shop: ['house', 16, 0, 3, 3], shop_dark: ['house', 19, 0, 4, 3], hut: ['house', 23, 0, 3, 3], hall: ['house', 26, 0, 3, 3], cabin: ['house', 29, 0, 4, 3],
    igloo: ['house', 0, 11, 3, 3], igloo_brick: ['house', 6, 11, 3, 3], igloo_small: ['house', 4, 11, 2, 3], barn: ['house', 25, 7, 4, 7], tower: ['house', 25, 14, 4, 6], mill: ['house', 29, 4, 3, 4], statue: ['house', 1, 15, 2, 3],
    bush: ['nature', 0, 0, 2, 2], pine: ['nature', 2, 0, 2, 2], deadtree: ['nature', 4, 0, 2, 2], tree: ['nature', 6, 0, 2, 2], snowtree: ['nature', 8, 0, 2, 2], snowtree2: ['nature', 10, 0, 2, 2], snowbush: ['nature', 12, 0, 2, 2], pinkbush: ['nature', 14, 0, 2, 2],
    pines: ['nature', 0, 2, 4, 3], trees: ['nature', 4, 2, 4, 3], snowtrees: ['nature', 8, 2, 4, 3], pinktrees: ['nature', 12, 2, 4, 3], olivetrees: ['nature', 16, 2, 4, 3],
    bigtree_pink: ['nature', 0, 18, 3, 3], bigtree: ['nature', 3, 18, 3, 3], bigtree_snow: ['nature', 6, 18, 3, 3], bigtree_orange: ['nature', 9, 18, 3, 3],
    rocks: ['nature', 12, 5, 4, 3], rocks_grey: ['nature', 16, 5, 4, 3], stump: ['nature', 0, 8, 2, 2], stump_orange: ['nature', 2, 8, 2, 2],
    flower_yellow: ['nature', 0, 11, 1, 1], flower_sun: ['nature', 1, 11, 1, 1], clover: ['nature', 2, 11, 1, 1], flower_red: ['nature', 3, 11, 1, 1],
    tuft1: ['nature', 0, 10, 1, 1], tuft2: ['nature', 1, 10, 1, 1], tuft3: ['nature', 3, 10, 1, 1], tuft4: ['nature', 4, 10, 1, 1], tuft5: ['nature', 7, 10, 1, 1],
    jars: ['house', 20, 13, 2, 2], banner: ['house', 22, 20, 1, 2],
    crystal_orange: ['nature', 0, 14, 1, 1], crystal_blue: ['nature', 1, 14, 1, 1], crystal_pink: ['nature', 2, 14, 1, 1], crystal_green: ['nature', 3, 14, 1, 1]
  };
  PixelPack.stampNames = function () { return Object.keys(STAMPS); };
  var trimmed = {};
  function stamp(name) {
    if (trimmed[name]) return trimmed[name];
    var def = STAMPS[name]; if (!def) return null;
    var im = img(SHEETS[def[0]]); if (!ok(im)) return null;
    var sx = def[1] * 16, sy = def[2] * 16, sw = def[3] * 16, sh = def[4] * 16;
    var c = document.createElement('canvas'); c.width = sw; c.height = sh; var g = c.getContext('2d'); g.drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
    var d = g.getImageData(0, 0, sw, sh).data, x0 = sw, y0 = sh, x1 = -1, y1 = -1, x, y;
    for (y = 0; y < sh; y++) for (x = 0; x < sw; x++) if (d[(y * sw + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    var t = document.createElement('canvas'); t.width = x1 - x0 + 1; t.height = y1 - y0 + 1; t.getContext('2d').drawImage(c, -x0, -y0);
    return trimmed[name] = t;
  }
  PixelPack.stamp = stamp;
  /** x = centre, y = the bottom edge (where it stands on the ground) */
  function put(g, name, x, y, flip, occupied) {
    var s = stamp(name); if (!s) return null;
    var dx = Math.round(x - s.width / 2), dy = Math.round(y - s.height);
    if (flip) { g.save(); g.translate(dx + s.width, dy); g.scale(-1, 1); g.drawImage(s, 0, 0); g.restore(); } else g.drawImage(s, dx, dy);
    var box = { x: dx, y: dy, w: s.width, h: s.height, bottom: y }; if (occupied) occupied.push(box); return box;
  }
  PixelPack.drawStamp = function (g, name, x, y, flip) { return put(g, name, x, y, flip); };

  // ── scene presets ─────────────────────────────────────────────────────────
  function free(box, occupied, pad) { pad = pad || 2; for (var i = 0; i < occupied.length; i++) { var o = occupied[i]; if (box.x < o.x + o.w + pad && box.x + box.w > o.x - pad && box.y < o.y + o.h + pad && box.y + box.h > o.y - pad) return false; } return true; }
  /** Where the story characters stand (slots 25 / 64 / 103 of 128, feet at y≈158): keep the scenery out of it. */
  function reserve(occ) { [62, 160, 257].forEach(function (x) { occ.push({ x: x - 26, y: 124, w: 52, h: 54 }); }); return occ; }
  function scatter(g, R, names, n, area, occupied, avoid) {
    for (var k = 0, tries = 0; k < n && tries < n * 12; tries++) {
      var name = names[(R() * names.length) | 0], s = stamp(name); if (!s) continue;
      var x = area[0] + R() * (area[2] - area[0]), y = area[1] + R() * (area[3] - area[1]);
      var box = { x: Math.round(x - s.width / 2), y: Math.round(y - s.height), w: s.width, h: s.height };
      if (!free(box, occupied, 1) || (avoid && !avoid(box))) continue;
      put(g, name, x, y, R() < .5, occupied); k++;
    }
  }
  /** The footprint of a scene prop on the 320×240 scene (x = centre, y = bottom edge), or null while its art is not ready. */
  function propBox(p) {
    if (!p) return null; var x = +p.x || 160, y = +p.y || 120, w = 0, h = 0;
    if (STAMPS[p.stamp]) { var s = stamp(p.stamp); if (s) { w = s.width; h = s.height; } else { w = STAMPS[p.stamp][3] * 16; h = STAMPS[p.stamp][4] * 16; } }
    else if (p.sprite && PixelPack.artSize) { var z = PixelPack.artSize(p.sprite), k = +p.scale || 1; if (z) { w = z[0] * k; h = z[1] * k; } }
    return w ? { x: Math.round(x - w / 2), y: Math.round(y - h), w: w, h: h } : null;
  }
  PixelPack.propBox = propBox;
  var PRESETS = {
    /** Any topic: choose a ground and place whatever props the topic needs. {preset:'blank', ground:'grass|forest|snow|sand|blossom', road:true, props:[…]} */
    blank: function (g, R, o) {
      var f = img(SHEETS.field), ground = GROUND[o.ground] ? o.ground : 'grass';
      fillGround(g, ground, R);
      if (o.road) patch(g, f, GROUND[ground === 'sand' ? 'forest' : 'sand'][0], GROUND[ground === 'sand' ? 'forest' : 'sand'][1], -1, 7, 22, 3);
      if (o.bare) return;                                       // a clean playfield (simulations): no decoration
      // Calm by default: the topic props are the subject, so the filler gets out of their way. The more props a scene has,
      // the less scenery is added, and it frames the edges (a back row, a few tufts) instead of covering the ground in noise.
      var occ = reserve([]), props = o.props || [];
      props.forEach(function (p) { var b = propBox(p); if (b) occ.push({ x: b.x - 6, y: b.y - 4, w: b.w + 12, h: b.h + 8 }); });
      var big = { grass: ['tree', 'trees', 'bush', 'bigtree'], forest: ['pines', 'pine', 'trees', 'bigtree', 'stump'], snow: ['snowtree', 'snowtree2', 'snowtrees', 'snowbush', 'rocks_grey'], sand: ['rocks', 'stump_orange', 'bush', 'pinkbush'], blossom: ['pinkbush', 'pinktrees', 'bigtree_pink', 'stump_orange'] }[ground];
      var small = ground === 'snow' ? ['tuft1', 'tuft3', 'crystal_blue'] : ground === 'sand' ? ['tuft1', 'tuft2', 'clover', 'flower_red'] : ['flower_yellow', 'flower_sun', 'clover', 'flower_red', 'tuft1', 'tuft2', 'tuft3', 'tuft5'];
      var n = props.length, edges = function (b) { return b.x < 90 || b.x + b.w > 230; };
      scatter(g, R, big, n ? 3 : 5, [4, 70, 316, 112], occ, n ? edges : null);           // a back row behind the characters, framing the props
      if (!n) scatter(g, R, big, 1, [4, 200, 316, 238], occ, edges);                    // one foreground tree on an empty scene
      scatter(g, R, small, n ? 10 : 14, [4, 60, 316, 238], occ);
    },
    village: function (g, R, o) {
      var occ = reserve([]), f = img(SHEETS.field), w = img(SHEETS.water);
      fillGround(g, 'grass', R);
      patch(g, f, 0, 0, -1, 7, 22, 3);                       // the road
      patch(g, f, 0, 0, 1, 3, 3, 5, 'b');                     // a lane up to the first door
      patch(g, f, 0, 0, 14, 4, 3, 4, 'b');
      patch(g, w, WATER.grass[0], WATER.grass[1], 0, 10, 4, 3);
      var plan = o.plan || ['house_orange', 'house_red', 'shop'];
      var xs = [40, 142, 242];
      plan.forEach(function (n, i) { put(g, n, xs[i] || 60 + i * 70, 96 - (i === 2 ? 0 : 0), false, occ); });
      put(g, 'trees', 296, 102, false, occ); put(g, 'bigtree', 18, 132, false, occ);
      scatter(g, R, ['bush', 'bush', 'tree'], 3, [20, 168, 310, 184], occ);
      scatter(g, R, ['flower_yellow', 'flower_sun', 'clover', 'flower_red', 'tuft1', 'tuft2', 'tuft3', 'tuft4'], 12, [4, 118, 316, 236], occ, function (b) { return !(b.y > 104 && b.y < 164 && b.x > -20); });
    },
    meadow: function (g, R) {
      var occ = reserve([]), f = img(SHEETS.field), w = img(SHEETS.water);
      fillGround(g, 'grass', R);
      patch(g, f, 0, 0, 4, 8, 3, 4, 't');                     // the cabin's path
      patch(g, w, WATER.sand[0], WATER.sand[1], 11, 3, 7, 6);
      put(g, 'bigtree', 36, 88, false, occ); put(g, 'tree', 288, 116, false, occ); put(g, 'trees', 150, 78, false, occ); put(g, 'pinktrees', 270, 60, false, occ); put(g, 'cabin', 80, 128, false, occ);
      scatter(g, R, ['flower_yellow', 'flower_sun', 'clover', 'flower_red', 'tuft1', 'tuft2', 'tuft3', 'tuft4', 'tuft5'], 16, [4, 100, 316, 236], occ, function (b) { return !(b.x > 170 && b.x < 296 && b.y > 40 && b.y < 150); });
    },
    forest: function (g, R) {
      var occ = reserve([]), f = img(SHEETS.field);
      fillGround(g, 'forest', R);
      patch(g, f, 0, 0, -1, 7, 22, 3);
      var row = [['pines', 36, 70], ['bigtree', 120, 62], ['pines', 210, 74], ['trees', 290, 66], ['pine', 8, 120], ['pine', 312, 130]];
      row.forEach(function (t) { put(g, t[0], t[1], t[2], false, occ); });
      put(g, 'rocks', 298, 112, false, occ); put(g, 'stump', 22, 118, false, occ);
      scatter(g, R, ['pine', 'bush', 'tree', 'stump', 'rocks'], 4, [10, 150, 310, 200], occ);
      scatter(g, R, ['flower_yellow', 'clover', 'tuft1', 'tuft2', 'tuft3', 'tuft4', 'tuft5', 'crystal_green'], 12, [4, 80, 316, 236], occ, function (b) { return !(b.y > 112 && b.y < 164 && b.x > 40 && b.x < 280); });
    },
    snow: function (g, R) {
      var occ = reserve([]), f = img(SHEETS.field);
      fillGround(g, 'snow', R);
      patch(g, f, 0, 9, -1, 7, 22, 3);
      put(g, 'igloo', 60, 100, false, occ); put(g, 'igloo_brick', 222, 98, false, occ); put(g, 'snowtrees', 300, 118, false, occ); put(g, 'bigtree_snow', 140, 80, false, occ);
      put(g, 'snowtree', 20, 150, false, occ); put(g, 'rocks_grey', 300, 190, false, occ);
      scatter(g, R, ['snowbush', 'snowtree2', 'snowtree', 'rocks_grey'], 3, [10, 150, 310, 200], occ);
      scatter(g, R, ['tuft1', 'tuft3', 'crystal_blue'], 10, [4, 110, 316, 236], occ, function (b) { return !(b.y > 112 && b.y < 164); });
    },
    autumn: function (g, R) {
      var occ = reserve([]), f = img(SHEETS.field);
      fillGround(g, 'blossom', R);
      patch(g, f, 0, 0, -1, 7, 22, 3);
      put(g, 'house_beige', 56, 96, false, occ); put(g, 'hut', 170, 94, false, occ); put(g, 'mill', 262, 98, false, occ);
      put(g, 'bigtree_orange', 20, 150, false, occ); put(g, 'bigtree_pink', 300, 150, false, occ); put(g, 'pinktrees', 200, 190, false, occ);
      scatter(g, R, ['pinkbush', 'stump_orange', 'tuft1', 'tuft2', 'flower_red', 'flower_yellow', 'clover'], 12, [4, 112, 316, 236], occ, function (b) { return !(b.y > 104 && b.y < 164); });
    }
  };
  PixelPack.presets = function () { return Object.keys(PRESETS); };
  PixelPack.addPreset = function (name, fn) { PRESETS[name] = fn; };
  var sceneCache = {}, specKeys = new WeakMap();
  /** Returns the 320×240 background canvas for a scene spec (cached), or null while the tilesets are still loading. */
  PixelPack.scene = function (spec) {
    spec = spec || {}; var key = specKeys.get(spec); if (!key) { key = JSON.stringify(spec); try { specKeys.set(spec, key); } catch (e) { /* not an object */ } }
    if (sceneCache[key]) return sceneCache[key];
    var names = Object.keys(SHEETS); for (var i = 0; i < names.length; i++) if (!ok(img(SHEETS[names[i]]))) return null;
    var c = document.createElement('canvas'); c.width = PixelPack.W; c.height = PixelPack.H; var g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    var preset = PRESETS[spec.preset] || PRESETS.village, R = rng(spec.seed == null ? 1 : spec.seed);
    preset(g, R, spec);
    (spec.props || []).slice().sort(function (a, b) { return (+(a && a.y) || 120) - (+(b && b.y) || 120); }).forEach(function (p) {   // back to front
      if (p && STAMPS[p.stamp]) put(g, p.stamp, +p.x || 160, +p.y || 120, !!p.flip);
      else if (p && p.sprite && PixelPack.draw) PixelPack.draw(g, p.sprite, +p.x || 160, +p.y || 120, { scale: +p.scale || 1, flip: !!p.flip });
    });
    return sceneCache[key] = c;
  };

  // ── sprites ───────────────────────────────────────────────────────────────
  var DIRS = { down: 0, up: 1, left: 2, right: 3 };
  function folder(kind, name) { return (kind === 'monster' ? 'monster/' : 'character/') + name; }
  /** Draw a 16×16 sprite with its feet at (x, y). o: dir, row (0 idle · 0-3 walk cycle · 4 attack · 5 jump), scale, alpha, flip */
  PixelPack.sprite = function (g, kind, name, x, y, o) {
    o = o || {}; var im = img(folder(kind, name) + '/SpriteSheet.png'); if (!ok(im)) return false;
    var sc = o.scale || 1, d = DIRS[o.dir || 'down'] || 0, row = o.row || 0, w = 16 * sc;
    var dx = Math.round(x - w / 2), dy = Math.round(y - w);
    if (o.alpha != null) g.globalAlpha = o.alpha;
    if (o.flip) { g.save(); g.translate(dx + w, dy); g.scale(-1, 1); g.drawImage(im, d * 16, row * 16, 16, 16, 0, 0, w, w); g.restore(); } else g.drawImage(im, d * 16, row * 16, 16, 16, dx, dy, w, w);
    g.globalAlpha = 1; return true;
  };
  PixelPack.faceImg = function (kind, name) { return img(folder(kind, name) + '/Faceset.png'); };
  var artFaces = {};
  PixelPack.faceUrl = function (kind, name) {
    if (kind === 'art') {
      if (artFaces[name]) return artFaces[name];
      var cv = document.createElement('canvas'); cv.width = 38; cv.height = 38; var fg = cv.getContext('2d'); fg.fillStyle = '#17252a'; fg.fillRect(0, 0, 38, 38);
      if (!(PixelPack.draw && PixelPack.draw(fg, name, 19, 36, { scale: 2 }))) return '';
      return artFaces[name] = cv.toDataURL();
    }
    return BASE + encodeURI(folder(kind, name) + '/Faceset.png');
  };
  /** An item icon (potion, book, gem …) from public/assets/items/<Group>/<Name>.png */
  PixelPack.item = function (path) { return img('items/' + path + '.png'); };
  PixelPack.drawItem = function (g, path, x, y, scale) { var im = PixelPack.item(path); if (!ok(im)) return false; scale = scale || 1; g.drawImage(im, Math.round(x), Math.round(y), im.naturalWidth * scale, im.naturalHeight * scale); return true; };
  PixelPack.emote = function (g, n, x, y, scale) { var im = img('ui/Emote/emote' + n + '.png'); if (!ok(im)) return false; scale = scale || 1; g.drawImage(im, Math.round(x), Math.round(y), im.naturalWidth * scale, im.naturalHeight * scale); return true; };
  PixelPack.hearts = function (g, x, y, quarters) {
    var im = img('ui/Receptacle/Heart.png'); if (!ok(im)) return;
    for (var i = 0; i < 5; i++) { var q = Math.max(0, Math.min(4, quarters - i * 4)); g.drawImage(im, q * 16, 0, 16, 16, x + i * 13, y, 16, 16); }
  };

  /** Paint a scene as the backdrop of a simulation canvas: an integer zoom that covers x,y,w,h, night-tinted under the Dark setting. */
  PixelPack.backdrop = function (g, spec, x, y, w, h) {
    var bg = PixelPack.scene(spec || { preset: 'meadow', seed: 1 }); if (!bg) return false;
    var sc = Math.max(1, Math.ceil(Math.max(w / PixelPack.W, h / PixelPack.H))), sw = Math.min(PixelPack.W, Math.ceil(w / sc)), sh = Math.min(PixelPack.H, Math.ceil(h / sc));
    var sx = Math.floor((PixelPack.W - sw) / 2), sy = Math.floor((PixelPack.H - sh) / 2);
    g.save(); g.imageSmoothingEnabled = false; g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.drawImage(bg, sx, sy, sw, sh, x, y, sw * sc, sh * sc);
    if (schemeIsDark()) { g.globalCompositeOperation = 'multiply'; g.fillStyle = 'rgb(150,160,205)'; g.fillRect(x, y, w, h); }
    g.restore(); return true;
  };
  /** Draw an object stamp (house, tree, rock, flower …) at an integer zoom; x is the centre, y the bottom edge. */
  PixelPack.drawProp = function (g, name, x, y, scale) {
    var s = stamp(name); if (!s) return false; scale = scale || 1;
    g.save(); g.imageSmoothingEnabled = false; g.drawImage(s, Math.round(x - s.width * scale / 2), Math.round(y - s.height * scale), s.width * scale, s.height * scale); g.restore(); return true;
  };


  // ── engine bridge ─────────────────────────────────────────────────────────
  /**
   * Replace a game's generated background painters with composed scenes.
   *
   * The engine clears a 128x96 context and calls BACKGROUNDS[i](ctx). A scene
   * is 320x240, and 320->128 is 2.5x, which would resample the pixel art into
   * mush. Halving to 160x120 is an integer step that stays crisp; the result
   * is then centre-cropped to 128x96, so about 80% of the width is shown
   * rather than a blurry whole.
   *
   * Each index keeps its own seed, so the four acts are different places in
   * the same world instead of one repeated backdrop.
   */
  PixelPack.installBackgrounds = function (presets, opts) {
    opts = opts || {};
    if (!Array.isArray(presets) || !presets.length) return false;
    var W = PixelPack.W, H = PixelPack.H, OUT_W = opts.width || 128, OUT_H = opts.height || 96;
    var half = document.createElement('canvas');
    half.width = Math.floor(W / 2); half.height = Math.floor(H / 2);
    var hg = half.getContext('2d'); hg.imageSmoothingEnabled = false;

    var painters = presets.map(function (preset, i) {
      return function (ctx) {
        var scene = PixelPack.scene({ preset: preset, seed: (opts.seed || 1) * 31 + i });
        if (!scene) return false;                       // art not in yet: caller falls back
        hg.clearRect(0, 0, half.width, half.height);
        hg.drawImage(scene, 0, 0, W, H, 0, 0, half.width, half.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(half,
          Math.floor((half.width - OUT_W) / 2), Math.floor((half.height - OUT_H) / 2),
          OUT_W, OUT_H, 0, 0, OUT_W, OUT_H);
        return true;
      };
    });

    var original = window.BACKGROUNDS || [];
    window.BACKGROUNDS = painters.map(function (painter, i) {
      var fallback = original[i];
      // Keep the generated art as the fallback for the frames before the
      // tilesets land, and for installs that never serve the pack.
      return function (ctx) {
        if (painter(ctx)) return;
        if (typeof fallback === 'function') fallback(ctx);
      };
    });
    return true;
  };


  /**
   * Skin the dialogue box with the pack's own art.
   *
   * The box was a plain rounded panel in UI colours, which read as a web
   * component sitting on top of a pixel game. The pack ships the frame
   * (DialogBoxFaceset 300x58), the portrait frame (FacesetBox 48x48) and the
   * continue arrow, so the chrome can be made of the same pixels as the world.
   *
   * border-image with `repeat` keeps the corners un-stretched at any box size;
   * scaling the sprite would smear its 1px border.
   */
  PixelPack.skinDialog = function () {
    if (document.getElementById('edgc-pack-dialog')) return true;
    var style = document.createElement('style');
    style.id = 'edgc-pack-dialog';
    style.textContent = [
      '#dialog-box{',
      '  background:none !important;border:0 !important;border-radius:0 !important;',
      '  box-shadow:none !important;backdrop-filter:none !important;',
      // DialogueBoxSimple has a uniform 6px frame. DialogBoxFaceset looks right
      // but carries a 50px portrait slot on its left edge, so slicing it tiles
      // that slot across the middle as dark bars. Border width is 12 so each
      // source pixel lands on exactly two, which keeps the edge crisp.
      '  border-image:url("' + BASE + 'ui/Dialog/DialogueBoxSimple.png") 6 fill round !important;',
      '  border-style:solid !important;border-width:12px !important;',
      '  image-rendering:pixelated;padding:10px 18px 12px !important;min-height:112px !important;',
      '}',
      '#dialog-box::before{display:none !important}',
      '#dialog-name{color:#3a2a18 !important;border-bottom:0 !important;letter-spacing:1px}',
      '#dialog-text{color:#2a2018 !important}',
      '#dialog-portrait{width:48px;height:48px;image-rendering:pixelated;',
      '  background:url("' + BASE + 'ui/Dialog/FacesetBox.png") center/48px 48px no-repeat}',
      '#dialog-portrait-inner{width:38px;height:38px;margin:5px;image-rendering:pixelated;',
      '  background-size:38px 38px;background-repeat:no-repeat}',
      '#dialog-next{color:transparent !important;width:13px;height:13px;image-rendering:pixelated;',
      '  background:url("' + BASE + 'ui/Arrow.png") center/13px 13px no-repeat}',
    ].join('\n');
    document.head.appendChild(style);
    return true;
  };

  /** Put a pack portrait in the dialogue frame, when the speaker maps to one. */
  PixelPack.setPortrait = function (name, kind) {
    var slot = document.getElementById('dialog-portrait-inner');
    if (!slot) return false;
    if (!name || !PixelPack.has(kind || 'character', name)) { slot.style.backgroundImage = ''; return false; }
    slot.style.backgroundImage = 'url("' + PixelPack.faceUrl(kind || 'character', name) + '")';
    return true;
  };

  // ── availability ──────────────────────────────────────────────────────────
  var catalog = null, available = null;

  /** Resolves false when the pack is not served, so callers can fall back. */
  PixelPack.ready = function () {
    if (available !== null) return Promise.resolve(available);
    return fetch(BASE + 'catalog.json')
      .then(function (r) { if (!r.ok) throw new Error('no pack'); return r.json(); })
      .then(function (data) {
        catalog = data; available = true;
        PixelPack.characters = data.characters || [];
        PixelPack.monsters = data.monsters || [];
        PixelPack.catalog = data;
        // Only the UI frames are preloaded. The terrain sheets are used by
        // scene(), which nothing in the engine calls and which this repository
        // does not distribute -- preloading them here only produced four 404s
        // per load. scene() requests them itself on first use, so a full pack
        // still works; it just warms up one call later.
        return PixelPack.preload(UI).then(function () { return true; });
      })
      .catch(function () { available = false; return false; });
  };

  /** Whether a named sprite is in the pack, so a caller can choose before drawing. */
  PixelPack.has = function (kind, name) {
    if (!catalog || !name) return false;
    var list = kind === 'monster' ? catalog.monsters : catalog.characters;
    return !!list && list.indexOf(name) >= 0;
  };

  PixelPack.characters = [];
  PixelPack.monsters = [];
  PixelPack.ready();
})();
