/* Settld 3D moments, three.js r147. Framework-free ES module: each factory takes a canvas plus
   options and returns a controller { dispose, setTime, play, ... }. Ported from the design build,
   where it read a global THREE; here three and its GLTFLoader are imported instead. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
const T = Object.assign({}, THREE, { GLTFLoader: GLTFLoader });
export const Settld3D = (function () {

  'use strict';
  
  // palette: exact swatches only. Charcoal / Beige / Electric Blue / Bleu Ciel / Portland Orange (+ red for failures). Paid reads Beige on charcoal.
  var C = {
    bg: 0x1A1A1A, line: 0xFFE6D0, warm: 0xFFE6D0, gray: 0xFFE6D0, mint: 0xFFE6D0, ink: 0x1A1A1A,
    violet: 0xFF5A00, blue: 0x2038E2, ciel: 0x007BFF, orange: 0xFF5A00, peach: 0xFFE6D0, red: 0xE5251B, cyan: 0x007BFF, elev: 0x1A1A1A, white: 0xFFFFFF
  };
  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  var seg = function (t, a, b) { return clamp((t - a) / (b - a), 0, 1); };
  var easeOut = function (x) { return 1 - Math.pow(1 - x, 3); };
  var easeInOut = function (x) { return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function baseStage(canvas, cam) {
    var renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x000000, 0);
    var scene = new T.Scene();
    var camera = new T.PerspectiveCamera(cam.fov, 1, 0.01, 50);
    function resize() {
      var w = canvas.clientWidth || canvas.parentNode.clientWidth, h = canvas.clientHeight || canvas.parentNode.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    resize();
    var ro = window.ResizeObserver ? new ResizeObserver(resize) : null; if (ro) ro.observe(canvas);
    return { renderer: renderer, scene: scene, camera: camera, resize: resize, ro: ro };
  }

  function glowTexture(rgb) {
    rgb = rgb || '0,123,255';
    var c = document.createElement('canvas'); c.width = c.height = 128;
    var g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(' + rgb + ',0.9)'); gr.addColorStop(0.35, 'rgba(' + rgb + ',0.25)'); gr.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    var t = new T.CanvasTexture(c); return t;
  }

  function fadeLines(geom, from, to, axis, a0, a1) {
    // vertex colours that fade from colour "from" to background along an axis
    var pos = geom.attributes.position, col = new Float32Array(pos.count * 3), cf = new T.Color(from), ct = new T.Color(to), tmp = new T.Color();
    for (var i = 0; i < pos.count; i++) {
      var v = axis === 'x' ? pos.getX(i) : pos.getY(i), k = clamp((v - a0) / (a1 - a0), 0, 1);
      tmp.copy(ct).lerp(cf, k); col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
    }
    geom.setAttribute('color', new T.BufferAttribute(col, 3));
    return geom;
  }

  function rimMaterial(base, rim, power, strength) {
    var m = new T.MeshPhongMaterial({ color: base, shininess: 0, specular: 0x000000, emissive: base, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    m.onBeforeCompile = function (sh) {
      sh.uniforms.rimColor = { value: new T.Color(rim) }; sh.uniforms.rimPow = { value: power }; sh.uniforms.rimK = { value: strength };
      sh.fragmentShader = 'uniform vec3 rimColor; uniform float rimPow; uniform float rimK;\n' + sh.fragmentShader.replace('#include <dithering_fragment>',
        'float fr = pow(1.0 - abs(dot(normalize(vNormal), normalize(vViewPosition))), rimPow);\n gl_FragColor.rgb = mix(gl_FragColor.rgb, rimColor, clamp(fr * rimK, 0.0, 1.0));\n#include <dithering_fragment>');
      m.userData.shader = sh;
    };
    return m;
  }

  function loop(ctrl, update, render) {
    var t = 0, last = performance.now(), playing = !!ctrl.autoplay && !reduced, raf = 0, visible = true;
    function frame(now) {
      raf = requestAnimationFrame(frame);
      var dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!visible) return;
      if (playing) { t += dt; }
      update(t, dt); render();
      if (ctrl.onTime) ctrl.onTime(t);
    }
    raf = requestAnimationFrame(frame);
    var onScreen = true, docVis = true;
    var onVis = function () { docVis = !document.hidden; visible = docVis && onScreen; last = performance.now(); };
    document.addEventListener('visibilitychange', onVis);
    var io = window.IntersectionObserver && ctrl.canvas ? new IntersectionObserver(function (en) { onScreen = en[0].isIntersecting; onVis(); }) : null;
    if (io) io.observe(ctrl.canvas);
    return {
      play: function () { playing = true; last = performance.now(); },
      pause: function () { playing = false; },
      replay: function () { t = 0; playing = true; last = performance.now(); },
      setTime: function (s) { t = s; playing = false; },
      time: function () { return t; },
      isPlaying: function () { return playing; },
      stop: function () { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); if (io) io.disconnect(); }
    };
  }

  /* ───────────────────────── HANDSHAKE ───────────────────────── */
  var FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
  var PH = ['metacarpal', 'phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];

  function b64ToBuf(b64) { var s = atob(b64), n = s.length, u = new Uint8Array(n); for (var i = 0; i < n; i++) u[i] = s.charCodeAt(i); return u.buffer; }

  var SWEEP = { uSweep: { value: -9 }, uSweepCol: { value: new T.Color(0xffffff) } };
  function sweepify(mat) {
    mat.onBeforeCompile = function (sh) {
      sh.uniforms.uSweep = SWEEP.uSweep; sh.uniforms.uSweepCol = SWEEP.uSweepCol;
      sh.vertexShader = 'varying float vWX;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n vWX = (modelMatrix * vec4(transformed, 1.0)).x;');
      sh.fragmentShader = 'uniform float uSweep; uniform vec3 uSweepCol; varying float vWX;\n' + sh.fragmentShader.replace('#include <dithering_fragment>',
        'float sb = exp(-pow((vWX - uSweep) / 0.022, 2.0));\n gl_FragColor.rgb = mix(gl_FragColor.rgb, uSweepCol, clamp(sb, 0.0, 1.0));\n gl_FragColor.a = max(gl_FragColor.a, sb * 0.95);\n#include <dithering_fragment>');
    };
    return mat;
  }
  function buildHand(gltf, rim) {
    var root = gltf.scene, bones = {}, mesh = null;
    root.traverse(function (o) { if (o.isBone) bones[o.name] = o; if (o.isSkinnedMesh) mesh = o; });
    var rest = {}; Object.keys(bones).forEach(function (k) { rest[k] = { p: bones[k].position.clone(), q: bones[k].quaternion.clone() }; });
    // wireframe + rim-lit occluder
    var wire = mesh.clone(); wire.material = sweepify(new T.MeshBasicMaterial({ color: C.warm, wireframe: true, transparent: true, opacity: 0.4, depthWrite: false }));
    wire.bind(mesh.skeleton, mesh.bindMatrix);
    mesh.material = rimMaterial(C.bg, rim, 2.4, 1.2);
    mesh.parent.add(wire);
    mesh.frustumCulled = false; wire.frustumCulled = false;
    return { root: root, bones: bones, rest: rest, mesh: mesh, wire: wire };
  }

  function resetPose(h) { Object.keys(h.rest).forEach(function (k) { h.bones[k].position.copy(h.rest[k].p); h.bones[k].quaternion.copy(h.rest[k].q); }); }

  var _q = new T.Quaternion(), _ax = new T.Vector3(), _v = new T.Vector3();
  function rotateChain(h, names, k, angle, axis) {
    // rotate joints names[k..] about names[k]'s local X axis, pivoting at its position (armature space)
    var pivot = h.bones[names[k]];
    if (axis === 'y') _ax.set(0, 1, 0); else _ax.set(1, 0, 0); _ax.applyQuaternion(pivot.quaternion).normalize();
    _q.setFromAxisAngle(_ax, angle);
    var p0 = pivot.position.clone();
    for (var j = k; j < names.length; j++) {
      var b = h.bones[names[j]];
      _v.copy(b.position).sub(p0).applyQuaternion(_q).add(p0); b.position.copy(_v);
      b.quaternion.premultiply(_q);
    }
  }
  var HP = { beta: 0.0, alpha: -0.6, gx: -0.066, gy: 0.04, gz: 0.018, yawG: 0, mcp: 1.25, pip: 1.05, dip: 0.55, th0: 0, th1: 0.2, th2: 0.15, splay: 0,
    // the orange hand hooks its fingers round the lower edge of the blue hand, thumb over the top
    B: { mcp: 0.1, pip: 1.55, dip: 1.4, gy: 0.035, gx: -0.07, fmcp: [0, 0.05, 0.12, 0.2] } };
  function hpFor(k) { var B = k === 1 ? HP.B : HP.A; if (!B) return HP; var o = {}; for (var key in HP) o[key] = HP[key]; for (key in B) o[key] = B[key]; return o; }
  function curl(h, grip, spread, k) {
    var HP = hpFor(k || 0);
    resetPose(h);
    FINGERS.forEach(function (f, i) {
      var names = PH.map(function (p) { return f + '-' + p; });
      var g = clamp(grip - i * 0.06, 0, 1); // index leads, pinky last (stagger)
      var fm = HP.fmcp ? HP.fmcp[i] : 0, fp = HP.fpip ? HP.fpip[i] : 0;
      rotateChain(h, names, 1, -g * (HP.mcp + fm) - spread * 0.05);
      if (HP.splay) rotateChain(h, names, 1, (i - 1.5) * HP.splay * g, 'y');
      rotateChain(h, names, 2, -g * (HP.pip + fp));
      rotateChain(h, names, 3, -g * HP.dip);
    });
    var th = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];
    if (HP.th0) rotateChain(h, th, 0, -grip * HP.th0);
    rotateChain(h, th, 1, -grip * HP.th1);
    rotateChain(h, th, 2, -grip * HP.th2);
  }

  function handOrient(h) {
    // rotation G that maps wrist joint axes: -Z (to fingers) -> +X world, +Y (back of hand) -> +Z world
    var w = h.rest['wrist'];
    var target = new T.Matrix4().makeBasis(new T.Vector3(0, -1, 0), new T.Vector3(0, 0, 1), new T.Vector3(-1, 0, 0));
    var tq = new T.Quaternion().setFromRotationMatrix(target);
    var g = tq.clone().multiply(w.q.clone().invert());
    return { q: g, wristOffset: w.p.clone().applyQuaternion(g).negate() };
  }

  function forearm() {
    var geo = new T.CylinderGeometry(0.0345, 0.0288, 0.36, 14, 9, true);
    geo.rotateZ(Math.PI / 2); geo.translate(-0.18 - 0.01, 0, 0);
    var edges = new T.EdgesGeometry(geo, 1);
    // EdgesGeometry drops seams on smooth cylinders; use wireframe-of-quads instead
    var quads = new T.BufferGeometry(), pts = [];
    var rs = 14, hs = 9, len = 0.36;
    for (var i = 0; i <= hs; i++) {
      var x = -0.01 - (i / hs) * len, r = 0.03 + (i / hs) * 0.006;
      for (var j = 0; j < rs; j++) {
        var a0 = j / rs * Math.PI * 2, a1 = (j + 1) / rs * Math.PI * 2;
        pts.push(x, Math.cos(a0) * r, Math.sin(a0) * r, x, Math.cos(a1) * r, Math.sin(a1) * r);
        if (i < hs) { var x2 = -0.01 - ((i + 1) / hs) * len, r2 = 0.03 + ((i + 1) / hs) * 0.006; pts.push(x, Math.cos(a0) * r, Math.sin(a0) * r, x2, Math.cos(a0) * r2, Math.sin(a0) * r2); }
      }
    }
    quads.setAttribute('position', new T.Float32BufferAttribute(pts, 3));
    fadeLines(quads, C.warm, C.bg, 'x', -0.37, -0.04);
    var m = new T.LineSegments(quads, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 }));
    var occ = new T.Mesh(geo, new T.MeshBasicMaterial({ color: C.bg, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
    var g = new T.Group(); g.add(occ); g.add(m); edges.dispose(); return g;
  }

  function sealRing() {
    var g = new T.Group(), arcs = [], seq = [C.ciel, C.warm, C.orange, C.blue];
    for (var i = 0; i < 4; i++) {
      var a0 = i * Math.PI / 2 + 0.09, a1 = (i + 1) * Math.PI / 2 - 0.09;
      var curve = new T.EllipseCurve(0, 0, 1, 1, a0, a1, false, 0), pts = curve.getPoints(40).map(function (p) { return new T.Vector3(p.x, 0, p.y); });
      var line = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: seq[i], transparent: true, opacity: 1 })); g.add(line); arcs.push(line);
      var tick = new T.Mesh(new T.BoxGeometry(0.035, 0.035, 0.035), new T.MeshBasicMaterial({ color: seq[i] === C.blue ? C.ciel : seq[i], transparent: true }));
      tick.position.set(Math.cos(a0), 0, Math.sin(a0)); g.add(tick); arcs.push(tick);
    }
    var disc = new T.Group();
    [1, 0.72, 0.46].forEach(function (r, i) {
      var c = new T.EllipseCurve(0, 0, r, r, 0, Math.PI * 2, false, 0), pts = c.getPoints(72).map(function (p) { return new T.Vector3(p.x, 0, p.y); });
      disc.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: C.warm, transparent: true, opacity: i === 0 ? 1 : 0.5 })));
    });
    for (var k = 0; k < 24; k++) { var a = k / 24 * Math.PI * 2; var tk = new T.Mesh(new T.BoxGeometry(0.02, 0.005, 0.06), new T.MeshBasicMaterial({ color: k % 2 ? C.orange : C.ciel, transparent: true })); tk.position.set(Math.cos(a) * 0.86, 0, Math.sin(a) * 0.86); tk.rotation.y = -a; disc.add(tk); }
    g.add(disc);
    return { group: g, arcs: arcs, disc: disc };
  }

  function setOpacity(obj, o) { obj.traverse(function (x) { if (x.material) { x.material.transparent = true; x.material.opacity = o * (x.material.userData.base == null ? (x.material.userData.base = x.material.opacity) : x.material.userData.base); } }); }

  Settld3DHandshake.prototype = {};
  function Settld3DHandshake(canvas, opts) {
    opts = opts || {};
    var st = baseStage(canvas, { fov: 30 }), scene = st.scene, camera = st.camera;
    var ctrl = { autoplay: opts.autoplay !== false, onTime: opts.onTime, canvas: canvas };
    var world = new T.Group(); scene.add(world);
    var grid = new T.GridHelper(2.4, 24, C.line, C.line); grid.position.y = -0.16; grid.material.transparent = true; grid.material.opacity = 0.0; world.add(grid);
    scene.add(new T.AmbientLight(0xffffff, 0.15)); var dl = new T.DirectionalLight(0xffffff, 0.2); dl.position.set(0.3, 0.6, 1); scene.add(dl);
    var glow = new T.Sprite(new T.SpriteMaterial({ map: glowTexture('0,123,255'), transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0 }));
    glow.scale.set(0.24, 0.24, 1); world.add(glow);
    var glow2 = new T.Sprite(new T.SpriteMaterial({ map: glowTexture('255,90,0'), transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0 }));
    glow2.scale.set(0.24, 0.24, 1); world.add(glow2);
    var contact = new T.Group();
    [0.03, 0.036].forEach(function (r) { var c = new T.EllipseCurve(0, 0, r, r, 0, Math.PI * 2, false, 0); contact.add(new T.Line(new T.BufferGeometry().setFromPoints(c.getPoints(64)), new T.LineBasicMaterial({ color: C.warm, transparent: true, opacity: 0, depthTest: false }))); });
    world.add(contact);
    var seal = sealRing(); seal.group.scale.setScalar(0.16); world.add(seal.group);
    // floor shockwaves (blue + orange) and floor glow under the grip
    var FLOOR = -0.16;
    function floorRing(color) { var m = new T.Mesh(new T.RingGeometry(0.985, 1, 96), new T.MeshBasicMaterial({ color: color, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending })); m.rotation.x = -Math.PI / 2; m.position.y = FLOOR + 0.001; world.add(m); return m; }
    var waves = [floorRing(C.ciel), floorRing(C.orange), floorRing(C.ciel), floorRing(C.orange)];
    function floorGlow(rgb, x) { var m = new T.Mesh(new T.PlaneGeometry(0.7, 0.7), new T.MeshBasicMaterial({ map: glowTexture(rgb), transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending })); m.rotation.x = -Math.PI / 2; m.position.set(x, FLOOR + 0.002, 0); world.add(m); return m; }
    var fg1 = floorGlow('0,123,255', -0.09), fg2 = floorGlow('255,90,0', 0.09);
    // contact burst: square pixels thrown out of the grip, half blue, half orange
    var NB = 160, bPos = new Float32Array(NB * 3), bCol = new Float32Array(NB * 3), bVel = [], cA = new T.Color(C.ciel), cB = new T.Color(C.orange), cW = new T.Color(C.warm);
    for (var bi = 0; bi < NB; bi++) {
      var th = Math.random() * Math.PI * 2, ph = (Math.random() - 0.5) * 1.3, sp = 0.18 + Math.random() * 0.5;
      bVel.push(new T.Vector3(Math.cos(th) * Math.cos(ph) * sp, Math.sin(ph) * sp * 0.8 + 0.05, Math.sin(th) * Math.cos(ph) * sp * 0.7));
      var cc = bi % 5 === 0 ? cW : (bi % 2 ? cA : cB); bCol[bi * 3] = cc.r; bCol[bi * 3 + 1] = cc.g; bCol[bi * 3 + 2] = cc.b;
    }
    var bGeo = new T.BufferGeometry(); bGeo.setAttribute('position', new T.BufferAttribute(bPos, 3)); bGeo.setAttribute('color', new T.BufferAttribute(bCol, 3));
    var burst = new T.Points(bGeo, new T.PointsMaterial({ size: 0.0055, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
    burst.frustumCulled = false; world.add(burst);
    // ambient motes drifting round the clasp once the deal is sealed
    var NM = 220, mPos = new Float32Array(NM * 3), mCol = new Float32Array(NM * 3), mSeed = [];
    for (var mi = 0; mi < NM; mi++) {
      mSeed.push([(Math.random() - 0.5) * 1.1, (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.6, Math.random() * 10, 0.004 + Math.random() * 0.01]);
      var mc = mi % 3 === 0 ? cW : (mi % 2 ? cA : cB); mCol[mi * 3] = mc.r; mCol[mi * 3 + 1] = mc.g; mCol[mi * 3 + 2] = mc.b;
    }
    var mGeo = new T.BufferGeometry(); mGeo.setAttribute('position', new T.BufferAttribute(mPos, 3)); mGeo.setAttribute('color', new T.BufferAttribute(mCol, 3));
    var motes = new T.Points(mGeo, new T.PointsMaterial({ size: 0.0032, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: T.AdditiveBlending }));
    motes.frustumCulled = false; world.add(motes);
    var hands = [], ready;
    ready = (opts.handUrl ? fetch(opts.handUrl).then(function (r) { return r.json(); }) : Promise.resolve(opts.handData)).then(function (data) {
      var buf = b64ToBuf(data.glb), loader = new T.GLTFLoader();
      var one = function () { return new Promise(function (res, rej) { loader.parse(buf.slice(0), '', res, rej); }); };
      return Promise.all([one(), one()]);
    }).then(function (gl) {
      gl.forEach(function (g, side) {
        var h = buildHand(g, side === 0 ? C.ciel : C.orange), o = handOrient(h);
        var arm = new T.Group(); // origin = wrist, +x toward fingers, +z = back of hand
        var hroot = new T.Group(); hroot.quaternion.copy(o.q); hroot.position.copy(o.wristOffset); hroot.add(h.root);
        arm.add(hroot); arm.add(forearm());
        var sideG = new T.Group(); sideG.add(arm); if (side === 1) sideG.rotation.y = Math.PI;
        world.add(sideG);
        hands.push({ h: h, arm: arm, side: sideG, hroot: hroot, o: o });
      });
    });

    // grip geometry (metres): wrists 0.075 either side, palms 0.028 apart in z
    var GRIP = new T.Vector3(-0.078, 0, 0.016);
    var START = new T.Vector3(-0.62, -0.1, 0.16);
    // shake: 3 real pumps from the elbows (7° → 5.6° → 3.5°), then a quick double squeeze every 6 s while idle
    function shakeAngle(t, delay) {
      var td = t - delay * 0.2, a = 0;
      if (td > 2.6 && td < 4.15) { var k = (td - 2.6) / 1.55; var env = seg(td, 2.6, 2.72) * (1 - 0.55 * k) * (1 - seg(td, 3.95, 4.15)); a = Math.sin(2 * Math.PI * 1.95 * (td - 2.6)) * 0.125 * env; }
      if (td > 4.15 && td < 4.7) a += Math.sin((td - 4.15) * 11) * Math.exp(-(td - 4.15) * 8) * 0.012;
      if (td > 5.6) { var c = (td - 5.6) % 6; if (c < 1.05) a += Math.sin(2 * Math.PI * 1.9 * c) * 0.05 * Math.sin(Math.PI * c / 1.05); }
      return a;
    }
    function squeeze(t) { if (t < 5.6) return 0; var c = (t - 5.6) % 6; return c < 1.05 ? Math.sin(Math.PI * c / 1.05) : 0; }
    function armPose(k, t, delay) {
      var r = easeInOut(seg(t, 0.3 + delay, 2.1 + delay));
      var HP = hpFor(k);
      GRIP.set(HP.gx, HP.gy, HP.gz); var p = new T.Vector3().lerpVectors(START, GRIP, r);
      p.y += Math.sin(Math.PI * r) * 0.06;                     // curved arc, never straight
      var roll = -Math.PI / 2 * (1 - easeInOut(seg(t, 0.6 + delay, 2.0 + delay))); // palm-down -> thumb-up
      var yaw = 0.35 * (1 - r) + HP.yawG * r;                                 // approach from slightly in front
      var press = Math.sin(Math.PI * seg(t, 2.2, 2.6)) * 0.004;
      var th = shakeAngle(t, delay);
      var LA = 0.37; // forearm length: the shake pivots at the elbow, so the clasp rises and falls on an arc
      var idle = t > 4.4 ? Math.sin(t * 1.3 + k) * 0.0012 : 0;
      p.add(new T.Vector3(press + LA * (Math.cos(th) - 1), LA * Math.sin(th) + idle, 0));
      var gk = easeInOut(seg(t, 1.3 + delay, 2.2 + delay));
      return { p: p, roll: roll, yaw: yaw, wristTilt: th + HP.alpha * gk, flex: -0.62 * th - HP.beta * gk };
    }
    var ix = interact(canvas, camera, { maxYaw: 0.35, maxPitch: 0.1, returnAfter: 2.5, onPick: function () { if (opts.onPick) opts.onPick('grip'); } });
    var mouse = { x: 0, y: 0 };
    var onMove = function (e) { var r = canvas.getBoundingClientRect(); if (!r.width || !r.height) return; mouse.x = clamp(((e.clientX - r.left) / r.width - .5) * 2, -1, 1); mouse.y = clamp(((e.clientY - r.top) / r.height - .5) * 2, -1, 1); };
    window.addEventListener('pointermove', onMove);

    var _fq = new T.Quaternion(), _fz = new T.Vector3(0, 0, 1), scrollK = 0, scrollE = 0;
    function wave(m, t0, t, maxR, op) { var k = seg(t, t0, t0 + 1.6); m.material.opacity = k > 0 && k < 1 ? (1 - k) * op : 0; m.scale.setScalar(0.02 + easeOut(k) * maxR); }
    function update(t, dt) {
      ix.update(dt || 0.016); scrollE += (scrollK - scrollE) * Math.min(1, (dt || 0.016) * 6);
      world.rotation.set(ix.st.pitch * 0.6 + scrollE * 0.15, ix.st.yaw + scrollE * 0.3, 0);
      // camera: a slow arc in from the side, a tiny kick on contact, then it breathes
      var camK = easeInOut(seg(t, 0, 3.4)), kick = t > 2.24 && t < 2.6 ? Math.sin((t - 2.24) * 40) * Math.exp(-(t - 2.24) * 14) * 0.004 : 0;
      var arc = (1 - camK) * 0.35 + (t > 4.4 ? Math.sin((t - 4.4) * 0.25) * 0.05 : 0);
      var cr = 0.72 - 0.16 * camK + scrollE * 0.12;
      camera.position.set(Math.sin(arc) * cr + 0.03 + mouse.x * 0.03, 0.1 - 0.035 * camK - mouse.y * 0.02 + kick, Math.cos(arc) * cr);
      camera.lookAt(0.0, -0.005 + (hands.length ? shakeAngle(t, 0) * 0.37 * 0.6 : 0), 0);
      if (Settld3DHandshake.dbgCam) { var dc = Settld3DHandshake.dbgCam; camera.position.fromArray(dc[0]); camera.lookAt(dc[1][0], dc[1][1], dc[1][2]); }
      // floor fx
      var sq = squeeze(t), lastSq = t > 5.6 ? 5.6 + Math.floor((t - 5.6) / 6) * 6 : -9;
      wave(waves[0], 2.25, t, 1.1, 0.8); wave(waves[1], 2.36, t, 1.0, 0.8);
      wave(waves[2], lastSq, t, 0.6, 0.45); wave(waves[3], lastSq + 0.1, t, 0.55, 0.45);
      var fgo = 0.55 * seg(t, 2.2, 2.6) * (1 - 0.4 * seg(t, 3.0, 4.4)) + sq * 0.25 + Math.abs(shakeAngle(t, 0)) * 1.2;
      fg1.material.opacity = fgo; fg2.material.opacity = fgo;
      // contact burst
      var bk = seg(t, 2.24, 3.6);
      burst.material.opacity = bk > 0 && bk < 1 ? Math.pow(1 - bk, 1.4) : 0;
      if (bk > 0 && bk < 1) { var bt = (t - 2.24), drag = (1 - Math.exp(-bt * 2.6)) / 2.6; for (var i = 0; i < NB; i++) { var v = bVel[i]; bPos[i * 3] = v.x * drag; bPos[i * 3 + 1] = v.y * drag - 0.05 * bt * bt + 0.005; bPos[i * 3 + 2] = 0.02 + v.z * drag; } bGeo.attributes.position.needsUpdate = true; }
      // motes
      motes.material.opacity = 0.75 * seg(t, 2.6, 3.6);
      if (t > 2.5) { for (var j = 0; j < NM; j++) { var m = mSeed[j], yy = ((m[1] + 0.25 + (t + m[3]) * m[4]) % 0.5) - 0.25; mPos[j * 3] = m[0] + Math.sin(t * 0.3 + m[3]) * 0.02; mPos[j * 3 + 1] = yy; mPos[j * 3 + 2] = m[2]; } mGeo.attributes.position.needsUpdate = true; }
      // light sweep along the wireframe: once when the seal splits, then with every idle squeeze
      var sw = seg(t, 3.1, 4.0), sw2 = t > 5.6 ? seg((t - 5.6) % 6, 0.05, 0.85) : 0;
      SWEEP.uSweep.value = sw > 0 && sw < 1 ? -0.45 + sw * 0.9 : (sw2 > 0 && sw2 < 1 ? 0.45 - sw2 * 0.9 : -9);
      grid.material.opacity = 0.1 * seg(t, 0, 0.4);
      hands.forEach(function (H, k) {
        if (Settld3DHandshake.dbgHide != null) H.side.visible = Settld3DHandshake.dbgHide !== k;
        var a = armPose(k, t, k === 1 ? 0.12 : 0);
        H.arm.position.copy(a.p); H.arm.rotation.set(a.roll, a.yaw, a.wristTilt, 'XYZ');
        _fq.setFromAxisAngle(_fz, a.flex); H.hroot.quaternion.copy(_fq).multiply(H.o.q); H.hroot.position.copy(H.o.wristOffset).applyQuaternion(_fq);
        var g = easeOut(seg(t, 2.2 + k * 0.03, 2.62 + k * 0.03)) * 0.97 + (t > 4.1 ? -0.05 * seg(t, 4.1, 4.4) : 0) + squeeze(t) * 0.04;
        var open = (1 - seg(t, 0.8, 1.9)) * 0.15;
        curl(H.h, g, open, k);
      });
      var cK = seg(t, 2.2, 2.6);
      var pK = seg(t, 2.25, 3.1);
      contact.children.forEach(function (c, i) { c.material.opacity = pK > 0 && pK < 1 ? (1 - pK) * (i ? 0.5 : 0.95) : 0; });
      contact.scale.setScalar(0.6 + easeOut(pK) * 3.2);
      contact.position.set(0, 0.0, 0.05); contact.lookAt(camera.position);
      glow.material.opacity = 0.4 * seg(t, 2.2, 2.6) * (1 - 0.35 * seg(t, 3.2, 4.4)) + squeeze(t) * 0.15;
      glow.position.set(-0.035, 0, 0.05); glow2.material.opacity = glow.material.opacity; glow2.position.set(0.035, 0, 0.05);
      // seal: disc forms 2.4-3.0, splits into 4 arcs 3.0-3.8, orbits
      var dK = easeOut(seg(t, 2.4, 3.0)), sK = easeInOut(seg(t, 3.0, 3.8));
      seal.group.position.set(0, 0.008 + shakeAngle(t, 0) * 0.37 * 0.85, 0.0);
      seal.group.rotation.set(0.42, 0, -0.16);
      seal.disc.scale.setScalar(Math.max(0.0001, dK));
      setOpacity(seal.disc, dK * (1 - sK));
      var ringR = 0.06 + dK * 0.05 + sK * 0.045 + squeeze(t) * 0.012 + scrollE * 0.06;
      seal.group.scale.setScalar(ringR);
      seal.arcs.forEach(function (a) { a.visible = sK > 0.01; if (a.material) { a.material.transparent = true; a.material.opacity = sK; } });
      seal.group.children.forEach(function (c) { if (c !== seal.disc) c.rotation.y = 0; });
      seal.group.rotateY(t > 3.0 ? (t - 3.0) * (Math.PI * 2 / 12) : 0);
    }
    var lp = loop(ctrl, update, function () { st.renderer.render(scene, camera); });
    if (reduced) lp.setTime(4.6);
    return {
      setScroll: function (k) { scrollK = reduced ? 0 : k; },
      ready: ready, play: lp.play, pause: lp.pause, replay: lp.replay, setTime: lp.setTime, time: lp.time, isPlaying: lp.isPlaying,
      dispose: function () { lp.stop(); ix.dispose(); window.removeEventListener('pointermove', onMove); if (st.ro) st.ro.disconnect(); st.renderer.dispose(); }
    };
  }

  /* ───────────────────────── JURY ───────────────────────── */
  // Solid charcoal pieces with 1px warm edges; colour appears only where state lives.
  function edged(geo, fill, edge, edgeOp, faceColors) {
    var mats = faceColors ? faceColors.map(function (c) { return new T.MeshLambertMaterial({ color: c, transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }); })
      : new T.MeshLambertMaterial({ color: fill, transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    var m = new T.Mesh(geo, mats), e = new T.LineSegments(geo.userData.edges || new T.EdgesGeometry(geo), new T.LineBasicMaterial({ color: edge, transparent: true, opacity: edgeOp == null ? 1 : edgeOp }));
    var g = new T.Group(); g.add(m); g.add(e); g.userData = { mesh: m, edges: e }; return g;
  }
  function hexGeo(r, h) { var g = new T.CylinderGeometry(r, r, h, 6, 1, false); g.rotateY(Math.PI / 6); return g; }
  function hexLoop(r, color, op) {
    var pts = []; for (var i = 0; i <= 6; i++) { var a = i / 6 * Math.PI * 2 + Math.PI / 6; pts.push(new T.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
    return new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: color, transparent: true, opacity: op == null ? 1 : op }));
  }
  function setOp(g, o) { g.traverse(function (x) { if (x.material) { (Array.isArray(x.material) ? x.material : [x.material]).forEach(function (m) { if (m.userData.b == null) m.userData.b = m.opacity; m.opacity = m.userData.b * o; }); } }); }

  var JURY_LEN = 14.5;
  var JURY_BEATS = [
    { t: 0.0, k: 'frozen', text: 'Clause 04 is frozen. 200 USDC waits in the safe.' },
    { t: 1.2, k: 'verify', text: 'Five jurors prove they are real people with World ID.' },
    { t: 3.4, k: 'bounce', text: 'The brand tries to take a seat. Parties cannot judge their own case.' },
    { t: 5.4, k: 'sealed', text: 'Each juror locks a sealed vote. Nobody can see it, not even us.' },
    { t: 8.6, k: 'reveal', text: 'Votes open together: 3 for the creator, 1 for the brand.' },
    { t: 9.9, k: 'slash', text: 'Juror 5 never opened their vote and loses their stake.' },
    { t: 10.2, k: 'verdict', text: 'The contract pays the creator. No human moved the money.' }
  ];

  function Settld3DJury(canvas, opts) {
    opts = opts || {};
    var st = baseStage(canvas, { fov: 30 }), scene = st.scene, camera = st.camera;
    var ctrl = { autoplay: opts.autoplay !== false, onTime: opts.onTime, canvas: canvas };
    var hover = null;
    var ix = interact(canvas, camera, { onPick: opts.onPick, onHover: function (id) { hover = id; if (opts.onHover) opts.onHover(id); }, maxYaw: 0.55, maxPitch: 0.25 });
    var timerFrac = null; // live mode: fraction of voting time left (0..1); null = story timeline drives it
    scene.add(new T.AmbientLight(0xffffff, 0.62));
    var key = new T.DirectionalLight(0xffffff, 0.55); key.position.set(-1.2, 2.4, 1.6); scene.add(key);
    var grid = new T.GridHelper(5, 25, C.line, C.line); grid.material.transparent = true; grid.material.opacity = opts.gridOp || 0.55; scene.add(grid);
    var CEN = new T.Vector3(0, 0, 0.2);

    // the frozen clause: a hex slab with a violet top, a coin stack inside, a violet cage over it
    var slab = edged(hexGeo(0.3, 0.08), 0, C.warm, 0.7, null);
    slab.userData.mesh.material = [new T.MeshLambertMaterial({ color: C.elev, transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }), new T.MeshLambertMaterial({ color: C.violet, transparent: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }), new T.MeshLambertMaterial({ color: C.elev })];
    slab.position.copy(CEN).setY(0.04); scene.add(slab);
    var stack = new T.Group(); for (var s = 0; s < 4; s++) { var cn = edged(chipGeo(0.12, 0.03), C.ciel, C.ink, 1); cn.position.y = 0.1 + s * 0.042; cn.rotation.y = s * 0.12; stack.add(cn); }
    stack.position.copy(CEN); scene.add(stack);
    var cage = new T.Group(); [0.0, 0.42].forEach(function (y) { var l = hexLoop(0.3, C.violet, 1); l.position.y = y; cage.add(l); });
    for (var v = 0; v < 6; v++) { var a6 = v / 6 * Math.PI * 2 + Math.PI / 6; var bar = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(Math.cos(a6) * 0.3, 0, Math.sin(a6) * 0.3), new T.Vector3(Math.cos(a6) * 0.3, 0.42, Math.sin(a6) * 0.3)]), new T.LineBasicMaterial({ color: C.violet, transparent: true })); cage.add(bar); }
    cage.position.copy(CEN).setY(0.08); scene.add(cage);
    var clauseHit = new T.Mesh(new T.CylinderGeometry(0.34, 0.34, 0.55, 6), new T.MeshBasicMaterial({ visible: false })); clauseHit.position.copy(CEN).setY(0.27); scene.add(clauseHit); ix.add(clauseHit, 'clause');
    var timerBg = arcLine(0.46, 0, Math.PI * 2, C.warm, 0.18, 96); timerBg.position.copy(CEN).setY(0.012); scene.add(timerBg);
    var timer = arcLine(0.46, 0, 0.01, C.orange, 0, 96); timer.position.copy(CEN).setY(0.014); scene.add(timer);

    // the two parties as hex tokens: brand left, creator right
    var brand = edged(hexGeo(0.17, 0.07), C.elev, C.warm, 0.8); brand.position.set(-1.12, 0.035, 0.42); scene.add(brand);
    var creator = edged(hexGeo(0.17, 0.07), C.elev, C.warm, 0.8); creator.position.set(1.12, 0.035, 0.42); scene.add(creator);
    var creatorTop = hexLoop(0.12, C.mint, 0); creatorTop.position.copy(creator.position).setY(0.075); scene.add(creatorTop);

    // juror seats on an arc behind (five humans by default, or opts.seats AI models)
    var NS = opts.seats || 5, VOTES = opts.votes || ['creator', 'creator', 'creator', 'brand', 'none'];
    var SPAN = NS >= 5 ? 124 : 120, seats = [];
    for (var i = 0; i < NS; i++) {
      var a = (opts.seatAngles ? opts.seatAngles[i] : (NS === 1 ? 0 : -SPAN / 2 + i * SPAN / (NS - 1))) * Math.PI / 180, R = Array.isArray(opts.seatR) ? opts.seatR[i] : (opts.seatR || 1.05);
      var base = new T.Vector3(Math.sin(a) * R, 0, CEN.z - Math.cos(a) * R * 0.78);
      var ped = edged(hexGeo(0.15, 0.18), C.elev, C.warm, 0.35); ped.position.copy(base).setY(0.09); scene.add(ped);
      var scan = hexLoop(0.19, C.violet, 0); scan.position.copy(base); scene.add(scan);
      var juror = opts.seats ? edged(new T.OctahedronGeometry(0.07, 0), C.ciel, C.ink, 1) : edged(hexGeo(0.09, 0.05), C.warm, C.ink, 1); juror.position.copy(base).setY(opts.seats ? 0.26 : 0.205); juror.visible = false; scene.add(juror);
      ix.add(ped.userData.mesh, 'juror-' + (i + 1));
      // vote cube: reveal face (+z, index 4) starts pointing down
      var reveal = VOTES[i] === 'creator' ? C.mint : (VOTES[i] === 'brand' ? C.blue : C.ink);
      var vote = edged(new T.BoxGeometry(0.11, 0.11, 0.11), 0, C.warm, 1, [0x1A1A1A, 0x1A1A1A, 0x1A1A1A, 0x1A1A1A, reveal === C.ink ? 0x1A1A1A : reveal, 0x1A1A1A]);
      vote.visible = false; scene.add(vote);
      seats.push({ base: base, ped: ped, scan: scan, juror: juror, vote: vote });
    }
    // the human arbitrator: a raised bench at the back, lit once they sign in and rule
    var arb = null;
    if (opts.arbiter) {
      var AP = opts.arbPos || [0, -1.5], AH = opts.arbH || 0.42;
      var ab = new T.Vector3(AP[0], 0, CEN.z + AP[1]);
      var aped = edged(hexGeo(opts.arbW || 0.2, AH), C.elev, C.warm, 0.45); aped.position.copy(ab).setY(AH / 2); scene.add(aped);
      var atok = edged(hexGeo(0.12, 0.06), C.orange, C.ink, 1); atok.position.copy(ab).setY(AH + 0.03); atok.visible = false; scene.add(atok);
      var aring = hexLoop(0.26, C.orange, 0); aring.position.copy(ab).setY(AH + 0.01); scene.add(aring);
      ix.add(aped.userData.mesh, 'arbiter');
      arb = { base: ab, ped: aped, tok: atok, ring: aring, on: !!opts.arbiterOn };
    }
    var rail = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(0.17 * NS + 0.07, 0.17, 0.17)), new T.LineBasicMaterial({ color: C.gray, transparent: true, opacity: 0 }));
    rail.position.set(0, opts.railY || 0.82, CEN.z); scene.add(rail);
    var party = edged(new T.BoxGeometry(0.12, 0.12, 0.12), C.orange, C.ink, 1); party.visible = false; scene.add(party);
    var bounce = hexLoop(0.22, C.orange, 0); scene.add(bounce);
    var coins = []; for (var c = 0; c < 8; c++) { var co = edged(chipGeo(0.075, 0.016), C.orange, C.ink, 1); co.visible = false; scene.add(co); coins.push(co); }
    var VERIFY = opts.verifyAt || [1.6, 2.1, 2.6, 3.1, 4.7];
    var VOTE = opts.voteAt || [5.4, 5.72, 6.04, 6.36, 6.68], holdUntil = null;
    var VD = opts.verdictAt == null ? 10.2 : opts.verdictAt, SIDE = opts.side || 'creator';
    var _p = new T.Vector3(), _q2 = new T.Vector3();

    function update(T0) {
      if (holdUntil != null && T0 >= holdUntil) { holdUntil = null; lp.pause(); }
      var t = opts.loop === false ? T0 : T0 % JURY_LEN;
      var dtj = Math.min(0.05, Math.max(0.001, T0 - (update.last || T0))) || 0.016; update.last = T0; ix.update(dtj);
      orbitCam(camera, ix, { r: opts.camR || 3.62, yaw: Math.sin(T0 * 0.16) * 0.1, pitch: opts.camPitch || 0.5 }, new T.Vector3(0, opts.camY || 0.36, CEN.z - 0.2));
      var tf = timerFrac != null ? timerFrac : (t < 1.2 ? 1 : t > 8.6 ? 0 : 1 - (t - 1.2) / 7.4);
      timer.material.opacity = tf > 0.001 ? 1 : 0; setArc(timer, 0.46, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.002, tf));
      timer.material.color.setHex(tf < 0.15 ? C.red : C.orange);
      seats.forEach(function (s, i) { s.ped.userData.edges.material.color.setHex(hover === 'juror-' + (i + 1) ? C.white : C.warm); });
      if (opts.labels) labelSync(opts.labels, ix.project(seats.map(function (s, i) { return { id: 'juror-' + (i + 1), pos: s.base.clone().setY(-0.02).add(new T.Vector3(0, 0, 0.24)) }; }).concat(arb ? [{ id: 'arbiter', pos: arb.base.clone().setY((opts.arbH || 0.42) + 0.2) }] : []).concat([{ id: 'clause', pos: CEN.clone().setY(0).add(new T.Vector3(0, 0, 0.55)) }, { id: 'brand', pos: brand.position.clone().add(new T.Vector3(0, -0.02, 0.26)) }, { id: 'creator', pos: creator.position.clone().add(new T.Vector3(0, -0.02, 0.26)) }])));
      seats.forEach(function (s, i) {
        var v = VERIFY[i], k = seg(t, v - 0.55, v);
        s.scan.material.opacity = k > 0 && k < 1 ? 1 - k * 0.6 : 0; s.scan.position.y = 0.02 + k * 0.32;
        s.ped.userData.edges.material.opacity = 0.35 + 0.5 * seg(t, v - 0.2, v);
        s.juror.visible = t >= v; s.juror.scale.setScalar(Math.max(0.0001, easeOut(seg(t, v, v + 0.25))));
        var vs = VOTE[i], vk = easeInOut(seg(t, vs, vs + 0.85));
        var slot = _q2.set((i - (NS - 1) / 2) * 0.17, opts.railY || 0.82, CEN.z);
        var from = _p.copy(s.juror.position).setY(0.3);
        var pos = new T.Vector3().lerpVectors(from, slot, vk); pos.y += Math.sin(Math.PI * vk) * 0.32;
        s.vote.visible = t >= vs;
        s.vote.position.copy(pos);
        var flip = VOTES[i] !== 'none' ? easeInOut(seg(t, 8.6 + i * 0.22, 9.05 + i * 0.22)) : 0;
        var spin = (t - vs) * 1.6 * (1 - flip);
        s.vote.rotation.set(Math.PI / 2 * (1 - flip), spin % (Math.PI * 2) * (1 - flip), 0, 'YXZ');
        var slashed = VOTES[i] === 'none' ? seg(t, 9.9, 10.3) : 0;
        s.vote.userData.edges.material.color.setHex(slashed > 0 ? C.red : (flip > 0.5 ? C.ink : C.warm));
        setOp(s.vote, 1 - slashed * 0.7);
        s.vote.position.y -= slashed * 0.12;
      });
      rail.material.opacity = 0.7 * seg(t, 5.0, 5.4) * (1 - seg(t, 8.3, 8.6));
      // the brand tries to sit in seat 5 and is turned away
      var s5 = seats[NS - 1].base, pk = seg(t, 3.4, 4.05), back = seg(t, 4.05, 4.6);
      party.visible = !opts.seats && t > 3.35 && t < 4.6;
      var pFrom = brand.position.clone().setY(0.25), pTo = s5.clone().setY(0.32);
      var pp = new T.Vector3().lerpVectors(pFrom, pTo, easeInOut(pk) * 0.9); pp.y += Math.sin(Math.PI * pk) * 0.4;
      if (back > 0) pp.lerp(pFrom, easeOut(back));
      party.position.copy(pp); party.rotation.set(t * 1.3, t * 2, 0);
      setOp(party, 1 - back);
      var bk = opts.seats ? 0 : seg(t, 3.95, 4.45); bounce.position.copy(s5).setY(0.3); bounce.material.opacity = bk > 0 && bk < 1 ? 1 - bk : 0; bounce.scale.setScalar(1 + bk * 1.4);
      // verdict
      if (arb) {
        var al = arb.on ? 1 : seg(t, VD - 0.6, VD - 0.2);
        arb.ped.userData.edges.material.color.setHex(al > 0.5 || hover === 'arbiter' ? C.orange : C.warm); arb.ped.userData.edges.material.opacity = 0.45 + 0.55 * al;
        arb.tok.visible = al > 0; arb.tok.scale.setScalar(Math.max(0.0001, easeOut(al))); arb.tok.rotation.y = t * 0.6;
        var ak = seg(t, VD - 0.3, VD + 0.5); arb.ring.material.opacity = ak > 0 && ak < 1 ? 1 - ak : 0; arb.ring.scale.setScalar(1 + ak * 1.6);
      }
      var winner = SIDE === 'brand' ? brand : creator;
      var vd = easeInOut(seg(t, VD, VD + 0.6));
      slab.userData.mesh.material[1].color.setHex(C.violet).lerp(new T.Color(SIDE === 'brand' ? C.blue : C.mint), vd);
      cage.position.y = 0.08 + vd * 0.25; setOp(cage, 1 - vd);
      cage.children.forEach(function (l) { l.material.color.setHex(vd > 0 ? C.warm : C.violet); });
      stack.children.forEach(function (cn, j) { var ck = easeInOut(seg(t, VD + 0.5 + (3 - j) * 0.28, VD + 1.3 + (3 - j) * 0.28)); cn.visible = ck < 1; });
      coins.forEach(function (co, j) {
        var ck = seg(t, VD + 0.5 + j * 0.14, VD + 1.35 + j * 0.14); co.visible = ck > 0 && ck < 1;
        var cp = new T.Vector3().lerpVectors(CEN.clone().setY(0.2), winner.position.clone().setY(0.12), easeInOut(ck)); cp.y += Math.sin(Math.PI * ck) * 0.42;
        co.position.copy(cp); co.rotation.set(ck * 6, 0, ck * 2);
      });
      var paid = seg(t, VD + 1.4, VD + 1.8);
      [brand, creator].forEach(function (pt) { var pp2 = pt === winner ? paid : 0; pt.userData.mesh.material.color.setHex(C.elev).lerp(new T.Color(SIDE === 'brand' ? C.blue : C.mint), pp2); pt.userData.edges.material.color.setHex(pp2 > 0.5 ? (SIDE === 'brand' ? C.white : C.ink) : C.warm); });
      creatorTop.material.opacity = 0;
      // gentle fade at loop seam
      var seam = opts.loop === false ? 1 : 1 - seg(t, 14.0, 14.5);
      canvas.style.opacity = Math.min(seam, 0.25 + seg(t, 0, 0.4) * 0.75);
      if (ctrl.onTime) { var beat = 0; JURY_BEATS.forEach(function (b, bi) { if (t >= b.t) beat = bi; }); ctrl.onBeat && ctrl.onBeat(beat); }
    }
    ctrl.onBeat = opts.onBeat;
    var lp = loop(ctrl, update, function () { st.renderer.render(scene, camera); });
    if (reduced) lp.setTime(12.6);
    return {
      beats: JURY_BEATS, length: JURY_LEN,
      setTimer: function (f) { timerFrac = f; },
      seal: function (i) { VOTE[i] = lp.time() + 0.05; holdUntil = VOTE[i] + 1.1; lp.play(); },
      reveal: function () { opts.loop = false; lp.setTime(8.3); holdUntil = Math.min(VD, 10.6); lp.play(); },
      decide: function (side) { SIDE = side || 'creator'; if (arb) arb.on = true; VD = Math.max(lp.time(), 10.4) + 0.3; if (lp.time() < 10.4) lp.setTime(10.4); holdUntil = VD + 2.4; lp.play(); },
      setArbiter: function (on) { if (arb) arb.on = !!on; },
      ready: Promise.resolve(), play: lp.play, pause: lp.pause, replay: lp.replay, setTime: lp.setTime, time: lp.time, isPlaying: lp.isPlaying,
      dispose: function () { lp.stop(); ix.dispose(); if (st.ro) st.ro.disconnect(); st.renderer.dispose(); }
    };
  }

  /* ───────────────────────── SHARED INTERACTION ───────────────────────── */
  // drag to turn (yaw/pitch with spring back), hover + click picking, projected HTML labels
  function interact(canvas, camera, opts) {
    opts = opts || {};
    var st = { yaw: 0, pitch: 0, vy: 0, tyaw: 0, tpitch: 0, drag: false, moved: 0, lastX: 0, lastY: 0, idle: 0, hover: null };
    var maxYaw = opts.maxYaw == null ? 0.6 : opts.maxYaw, maxPitch = opts.maxPitch == null ? 0.25 : opts.maxPitch;
    var picks = [], ray = new T.Raycaster(), ndc = new T.Vector2();
    canvas.style.touchAction = 'pan-y'; canvas.style.cursor = 'grab';
    function setNdc(e) { var r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }
    function hit() { ray.setFromCamera(ndc, camera); var h = ray.intersectObjects(picks, false); return h.length ? h[0].object.userData.pick : null; }
    function down(e) { st.drag = true; st.moved = 0; st.lastX = e.clientX; st.lastY = e.clientY; canvas.style.cursor = 'grabbing'; try { canvas.setPointerCapture(e.pointerId); } catch (x) {} }
    function move(e) {
      setNdc(e);
      if (st.drag) {
        var dx = e.clientX - st.lastX, dy = e.clientY - st.lastY; st.lastX = e.clientX; st.lastY = e.clientY; st.moved += Math.abs(dx) + Math.abs(dy);
        st.tyaw = clamp(st.tyaw + dx * 0.006, -maxYaw, maxYaw); st.tpitch = clamp(st.tpitch + dy * 0.004, -maxPitch, maxPitch); st.idle = 0;
        return;
      }
      var id = hit();
      if (id !== st.hover) { st.hover = id; canvas.style.cursor = id ? 'pointer' : 'grab'; if (opts.onHover) opts.onHover(id); }
    }
    function up(e) {
      var wasDrag = st.drag; st.drag = false; canvas.style.cursor = st.hover ? 'pointer' : 'grab';
      if (wasDrag && st.moved < 6) { setNdc(e); var id = hit(); if (opts.onPick) opts.onPick(id); }
    }
    function leave() { if (st.hover) { st.hover = null; if (opts.onHover) opts.onHover(null); } canvas.style.cursor = 'grab'; }
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointerleave', leave);
    var labelEls = [], _v = new T.Vector3();
    return {
      st: st,
      add: function (mesh, id) { mesh.userData.pick = id; picks.push(mesh); return mesh; },
      update: function (dt) {
        st.idle += dt;
        if (!st.drag && st.idle > (opts.returnAfter || 3)) { st.tyaw *= 0.96; st.tpitch *= 0.96; }
        st.yaw += (st.tyaw - st.yaw) * Math.min(1, dt * 8); st.pitch += (st.tpitch - st.pitch) * Math.min(1, dt * 8);
      },
      project: function (list) { // list: [{id, pos: Vector3}] -> [{id, x, y}] in CSS px
        var w = canvas.clientWidth, h = canvas.clientHeight;
        return list.map(function (l) { _v.copy(l.pos).project(camera); return { id: l.id, x: (_v.x * 0.5 + 0.5) * w, y: (-_v.y * 0.5 + 0.5) * h, behind: _v.z > 1 }; });
      },
      dispose: function () { canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointerleave', leave); }
    };
  }
  // orbit camera around a target using the interact yaw/pitch
  function orbitCam(camera, ix, base, target) {
    var r = base.r, yaw = base.yaw + ix.st.yaw, pitch = clamp(base.pitch + ix.st.pitch, 0.05, 1.2);
    camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * r, target.y + Math.sin(pitch) * r, target.z + Math.cos(yaw) * Math.cos(pitch) * r);
    camera.lookAt(target);
  }
  function labelSync(container, list) {
    // positions children [data-l="id"] of container at projected points
    if (!container) return;
    list.forEach(function (p) {
      var el = container.querySelector('[data-l="' + p.id + '"]'); if (!el) return;
      el.style.transform = 'translate(' + p.x.toFixed(1) + 'px,' + p.y.toFixed(1) + 'px)';
      el.style.opacity = p.behind ? 0 : '';
    });
  }
  // money is always a coin: a short cylinder with a bright rim and an embossed inner ring
  function chipGeo(w, h) { var g = new T.CylinderGeometry(w / 2, w / 2, h, 40); g.userData.edges = coinEdge(w, h); return g; }
  function coinEdge(w, h) {
    var r = w / 2, pts = [], N = 40;
    function ring(rad, y) { for (var i = 0; i < N; i++) { var a0 = i / N * Math.PI * 2, a1 = (i + 1) / N * Math.PI * 2; pts.push(Math.cos(a0) * rad, y, Math.sin(a0) * rad, Math.cos(a1) * rad, y, Math.sin(a1) * rad); } }
    ring(r, h / 2); ring(r, -h / 2); ring(r * 0.66, h / 2 + 0.0004);
    var g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pts, 3)); return g;
  }
  function lambert(c, op) { return new T.MeshLambertMaterial({ color: c, transparent: op != null, opacity: op == null ? 1 : op, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }); }
  function lights(scene) { scene.add(new T.AmbientLight(0xffffff, 0.64)); var d = new T.DirectionalLight(0xffffff, 0.55); d.position.set(-1.2, 2.4, 1.6); scene.add(d); }
  function edgeBox(w, h, d, color, op) { var l = new T.LineSegments(new T.EdgesGeometry(new T.BoxGeometry(w, h, d)), new T.LineBasicMaterial({ color: color, transparent: true, opacity: op == null ? 1 : op })); return l; }
  function arcLine(r, a0, a1, color, op, n) {
    var c = new T.EllipseCurve(0, 0, r, r, a0, a1, false, 0), pts = c.getPoints(n || 48).map(function (p) { return new T.Vector3(p.x, 0, p.y); });
    return new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: color, transparent: true, opacity: op == null ? 1 : op }));
  }
  function setArc(line, r, a0, a1) { var c = new T.EllipseCurve(0, 0, r, r, a0, a1, false, 0), pts = c.getPoints(48); var pos = line.geometry.attributes.position; for (var i = 0; i < pts.length; i++) pos.setXYZ(i, pts[i].x, 0, pts[i].y); pos.needsUpdate = true; }
  function common(lp, st, extra) {
    var o = { play: lp.play, pause: lp.pause, replay: lp.replay, setTime: lp.setTime, time: lp.time, isPlaying: lp.isPlaying, ready: Promise.resolve() };
    for (var k in extra) o[k] = extra[k];
    var d = o.dispose; o.dispose = function () { lp.stop(); if (st.ro) st.ro.disconnect(); if (d) d(); st.renderer.dispose(); };
    return o;
  }
  var STATE_COL = { locked: C.ciel, checking: C.orange, verified: C.blue, paid: C.mint, returning: C.blue, returned: C.blue, failed: C.red, frozen: C.violet, pending: C.gray };

  /* ───────────────────────── DEAL VAULT (DealPage) ─────────────────────────
     Settld3D.vault(canvas, { clauses: [{ id, amount, state, progress }], labels: element, onPick, onHover })
     A safe with one lane of coin chips per clause. Locked chips are Bleu Ciel; checking lanes get an
     orange scan ring; verified lanes show a release-window ring; paid chips fly to the creator (mint);
     returning chips fly back to the brand (electric blue). Drag to turn it, click a lane to open that clause. */
  function Vault(canvas, opts) {
    opts = opts || {};
    var st = baseStage(canvas, { fov: 30 }), scene = st.scene, camera = st.camera;
    var ctrl = { autoplay: true, canvas: canvas };
    lights(scene);
    var grid = new T.GridHelper(6, 30, C.line, C.line); grid.material.transparent = true; grid.material.opacity = 0.1; scene.add(grid);
    var ix = interact(canvas, camera, { onPick: opts.onPick, onHover: function (id) { hover = id; if (opts.onHover) opts.onHover(id); }, maxYaw: 0.7, maxPitch: 0.3 });
    var hover = null, focus = null;
    var clauses = (opts.clauses || []).map(function (c) { return Object.assign({}, c); });
    var n = clauses.length, LW = 0.34, GAP = 0.06, W = n * LW + (n + 1) * GAP, H = 0.78, D = 0.5;
    var safe = new T.Group(); scene.add(safe);
    var plinth = new T.Mesh(new T.BoxGeometry(W + 0.16, 0.08, D + 0.16), lambert(C.elev)); plinth.position.y = 0.04; safe.add(plinth);
    var pe = edgeBox(W + 0.16, 0.08, D + 0.16, C.warm, 0.35); pe.position.y = 0.04; safe.add(pe);
    var frame = edgeBox(W, H, D, C.warm, 0.55); frame.position.y = 0.08 + H / 2; safe.add(frame);
    var back = new T.Mesh(new T.PlaneGeometry(W, H), new T.MeshBasicMaterial({ color: 0x1A1A1A })); back.position.set(0, 0.08 + H / 2, -D / 2); safe.add(back);
    var lid = edgeBox(W + 0.04, 0.05, D + 0.04, C.warm, 0.8); lid.position.y = 0.08 + H + 0.025; safe.add(lid);
    var lidFill = new T.Mesh(new T.BoxGeometry(W + 0.04, 0.05, D + 0.04), lambert(C.elev)); lidFill.position.copy(lid.position); safe.add(lidFill);
    var brand = new T.Group(), creator = new T.Group();
    [[brand, -1], [creator, 1]].forEach(function (pp) {
      var g = pp[0]; var m = new T.Mesh(hexGeo(0.2, 0.08), lambert(C.elev)); m.position.y = 0.04; g.add(m);
      var e = new T.LineSegments(new T.EdgesGeometry(hexGeo(0.2, 0.08)), new T.LineBasicMaterial({ color: C.warm, transparent: true, opacity: 0.7 })); e.position.y = 0.04; g.add(e);
      g.position.set(pp[1] * (W / 2 + 0.62), 0, 0.15); g.userData = { stack: [], edge: e, base: m }; scene.add(g);
      ix.add(m, pp[1] < 0 ? 'brand' : 'creator');
    });
    var lanes = clauses.map(function (c, i) {
      var x = -W / 2 + GAP + LW / 2 + i * (LW + GAP);
      var g = new T.Group(); g.position.set(x, 0.08, 0); safe.add(g);
      var edges = edgeBox(LW, H - 0.04, D - 0.08, C.warm, 0.25); edges.position.y = H / 2; g.add(edges);
      var hitBox = new T.Mesh(new T.BoxGeometry(LW, H, D), new T.MeshBasicMaterial({ visible: false })); hitBox.position.y = H / 2; g.add(hitBox); ix.add(hitBox, c.id);
      var chips = [], count = Math.max(1, Math.round(c.amount * (opts.chipsPerUnit || 10)));
      for (var k = 0; k < count; k++) {
        var ch = new T.Group(), m = new T.Mesh(chipGeo(LW * 0.66, 0.042), lambert(STATE_COL[c.state] || C.ciel)), e = new T.LineSegments(coinEdge(LW * 0.66, 0.042), new T.LineBasicMaterial({ color: C.ink }));
        ch.add(m); ch.add(e); ch.userData = { m: m, home: new T.Vector3(x, 0.08 + 0.04 + k * 0.05, 0), fly: null };
        ch.position.copy(ch.userData.home); scene.add(ch); chips.push(ch);
      }
      var scan = hexLoop(LW * 0.62, C.orange, 0); scan.rotation.y = Math.PI / 6; g.add(scan);
      var win = arcLine(LW * 0.42, 0, 0.01, C.ciel, 0); win.position.y = H + 0.112; g.add(win);
      var winBg = arcLine(LW * 0.42, 0, Math.PI * 2, C.warm, 0, 64); winBg.position.y = H + 0.112; g.add(winBg);
      return { c: c, g: g, edges: edges, chips: chips, scan: scan, win: win, winBg: winBg, x: x, flash: 0 };
    });
    function chipColor(L) { var col = STATE_COL[L.c.state] || C.ciel; L.chips.forEach(function (ch) { if (!ch.userData.fly && !ch.userData.gone) ch.userData.m.material.color.setHex(col); }); }
    lanes.forEach(chipColor);
    var clock = 0;
    function send(L, to, color) {
      var target = to === 'creator' ? creator : brand;
      L.chips.slice().reverse().forEach(function (ch, j) {
        if (ch.userData.gone) return;
        ch.userData.fly = { t0: clock + j * 0.12, dur: 0.75, from: ch.position.clone(), to: target, color: color };
        ch.userData.gone = true;
      });
    }
    function setClauses(list) {
      list.forEach(function (nc) {
        var L = lanes.filter(function (l) { return l.c.id === nc.id; })[0]; if (!L) return;
        var prev = L.c.state; L.c = Object.assign(L.c, nc);
        if (prev !== nc.state) {
          L.flash = 1;
          if (nc.state === 'paid') send(L, 'creator', C.mint);
          if (nc.state === 'returned' || nc.state === 'returning') send(L, 'brand', C.blue);
          if (nc.state !== 'paid' && nc.state !== 'returned' && nc.state !== 'returning') reset(L);
          chipColor(L);
        }
      });
    }
    function reset(L) { L.chips.forEach(function (ch) { ch.userData.gone = false; ch.userData.fly = null; ch.visible = true; ch.position.copy(ch.userData.home); }); }
    function landOn(target, color) {
      var s = target.userData.stack, ch = new T.Group(), m = new T.Mesh(chipGeo(0.2, 0.036), lambert(color)), e = new T.LineSegments(coinEdge(0.2, 0.036), new T.LineBasicMaterial({ color: C.ink }));
      ch.add(m); ch.add(e); ch.position.set(0, 0.1 + s.length * 0.04, 0); ch.rotation.y = (s.length % 3) * 0.18; target.add(ch); s.push(ch);
      target.userData.pulse = 1;
    }
    var BASE = { r: opts.camR || 2.85, yaw: opts.camYaw || 0, pitch: opts.camPitch || 0.4 }, TGT = new T.Vector3(0, opts.camY == null ? 0.4 : opts.camY, 0);
    var labelPts = lanes.map(function (L, i) { return { id: L.c.id, pos: new T.Vector3(L.x, 0.08 + H + 0.2 + (i % 2) * 0.2, 0) }; })
      .concat([{ id: 'brand', pos: new T.Vector3(brand.position.x, -0.05, brand.position.z + 0.3) }, { id: 'creator', pos: new T.Vector3(creator.position.x, -0.05, creator.position.z + 0.3) }]);
    function update(t, dt) {
      clock += dt || 0.016; ix.update(dt || 0.016);
      orbitCam(camera, ix, BASE, TGT);
      lanes.forEach(function (L) {
        var s = L.c.state, hov = hover === L.c.id || focus === L.c.id;
        L.edges.material.opacity = (hov ? 0.9 : 0.25) + L.flash * 0.6;
        L.edges.material.color.setHex(s === 'failed' ? C.red : (s === 'verified' ? C.blue : C.warm));
        if (s === 'verified') L.edges.material.color.setHex(hov ? C.warm : C.ciel);
        L.flash = Math.max(0, L.flash - (dt || 0.016) * 1.5);
        var scanK = (clock * 0.6) % 1;
        L.scan.material.opacity = s === 'checking' ? 0.9 * Math.sin(Math.PI * scanK) : 0; L.scan.position.y = 0.05 + scanK * (H - 0.1);
        var showWin = s === 'verified'; L.win.material.opacity = showWin ? 1 : 0; L.winBg.material.opacity = showWin ? 0.2 : 0;
        if (showWin) setArc(L.win, LW * 0.42, Math.PI / 2, Math.PI / 2 + Math.PI * 2 * clamp(L.c.progress == null ? 0.4 : L.c.progress, 0.001, 1));
        L.chips.forEach(function (ch, k) {
          var f = ch.userData.fly;
          if (f) {
            var k2 = seg(clock, f.t0, f.t0 + f.dur);
            if (k2 >= 1) { ch.visible = false; ch.userData.fly = null; landOn(f.to, f.color); return; }
            var end = f.to.position.clone().add(new T.Vector3(0, 0.12 + f.to.userData.stack.length * 0.04, 0));
            var p = new T.Vector3().lerpVectors(f.from, end, easeInOut(k2)); p.y += Math.sin(Math.PI * k2) * 0.5; ch.position.copy(p);
            ch.rotation.y = k2 * 4; if (k2 > 0) ch.userData.m.material.color.setHex(f.color);
          } else if (!ch.userData.gone) {
            ch.position.y = ch.userData.home.y + (hov ? Math.sin(clock * 4 + k * 0.6) * 0.006 : 0);
          }
        });
      });
      [brand, creator].forEach(function (g) { var p = g.userData.pulse || 0; g.userData.edge.material.opacity = 0.7 + p * 0.3; g.userData.edge.material.color.setHex(p > 0.05 ? (g === creator ? C.mint : C.ciel) : (hover === (g === brand ? 'brand' : 'creator') ? C.white : C.warm)); g.userData.pulse = Math.max(0, p - (dt || 0.016) * 1.2); });
      if (opts.labels) labelSync(opts.labels, ix.project(labelPts));
    }
    var lp = loop(ctrl, update, function () { st.renderer.render(scene, camera); });
    return common(lp, st, {
      setClauses: setClauses,
      focus: function (id) { focus = id; },
      dispose: function () { ix.dispose(); }
    });
  }

  /* ───────────────────────── WALLET COIN SHELF ─────────────────────────
     Settld3D.coins(canvas, { stacks: [{ id, paid, locked }], labels, onPick, onHover })
     One stack per deal. Solid mint chips = money already yours; outlined Bleu Ciel chips = still locked for you.
     payout(id, n) turns n locked chips into mint and drops them onto the paid part. */
  function Coins(canvas, opts) {
    opts = opts || {};
    var st = baseStage(canvas, { fov: 30 }), scene = st.scene, camera = st.camera, ctrl = { autoplay: true, canvas: canvas };
    lights(scene);
    var hover = null;
    var ix = interact(canvas, camera, { onPick: opts.onPick, onHover: function (id) { hover = id; if (opts.onHover) opts.onHover(id); }, maxYaw: 0.6, maxPitch: 0.25 });
    var grid = new T.GridHelper(6, 30, C.line, C.line); grid.material.transparent = true; grid.material.opacity = 0.1; scene.add(grid);
    var data = opts.stacks || [], n = data.length, SP = 0.56, CH = 0.045, CW = 0.3;
    var shelf = new T.Mesh(new T.BoxGeometry(n * SP + 0.2, 0.06, 0.6), lambert(C.elev)); shelf.position.y = 0.03; scene.add(shelf);
    var se = edgeBox(n * SP + 0.2, 0.06, 0.6, C.warm, 0.35); se.position.y = 0.03; scene.add(se);
    var clock = 0;
    var stacks = data.map(function (d, i) {
      var x = -((n - 1) * SP) / 2 + i * SP, g = new T.Group(); g.position.set(x, 0.06, 0); scene.add(g);
      var hit = new T.Mesh(new T.BoxGeometry(SP * 0.9, 1.2, 0.5), new T.MeshBasicMaterial({ visible: false })); hit.position.y = 0.6; g.add(hit); ix.add(hit, d.id);
      var ring = hexLoop(0.24, C.warm, 0.25); ring.position.y = 0.005; g.add(ring);
      var chips = [];
      function mk(kind) {
        var c = new T.Group(), solid = kind === 'paid';
        var m = new T.Mesh(chipGeo(CW, CH * 0.9), solid ? lambert(C.mint) : new T.MeshBasicMaterial({ color: 0x1A1A1A, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
        var e = new T.LineSegments(coinEdge(CW, CH * 0.9), new T.LineBasicMaterial({ color: solid ? C.ink : C.ciel }));
        c.add(m); c.add(e); c.userData = { kind: kind, m: m, e: e, drop: null }; g.add(c); return c;
      }
      for (var p = 0; p < d.paid; p++) chips.push(mk('paid'));
      for (var l = 0; l < d.locked; l++) chips.push(mk('locked'));
      return { d: d, g: g, ring: ring, chips: chips, x: x };
    });
    function layout(S, instant) { S.chips.forEach(function (c, k) { c.userData.ty = CH * 0.5 + k * CH; if (instant) c.position.y = c.userData.ty; c.rotation.y = (k % 4) * 0.07; }); }
    stacks.forEach(function (S) { layout(S, true); });
    function payout(id, nn) {
      var S = stacks.filter(function (s) { return s.d.id === id; })[0]; if (!S) return;
      var paidCount = S.chips.filter(function (c) { return c.userData.kind === 'paid'; }).length;
      var locked = S.chips.filter(function (c) { return c.userData.kind === 'locked'; });
      locked.slice(0, nn || 1).forEach(function (c, j) {
        c.userData.kind = 'paid'; c.userData.m.material = lambert(C.mint); c.userData.e.material.color.setHex(C.ink);
        c.userData.drop = { t0: clock + j * 0.18 };
        c.position.y = 1.2 + j * 0.1;
      });
      S.chips.sort(function (a, b) { return (a.userData.kind === 'paid' ? 0 : 1) - (b.userData.kind === 'paid' ? 0 : 1); });
      layout(S, false); S.flash = 1;
    }
    var BASE = { r: opts.camR || 3.0, yaw: 0, pitch: opts.camPitch || 0.36 }, TGT = new T.Vector3(0, opts.camY == null ? 0.32 : opts.camY, 0);
    function update(t, dt) {
      dt = dt || 0.016; clock += dt; ix.update(dt); orbitCam(camera, ix, BASE, TGT);
      stacks.forEach(function (S) {
        var hov = hover === S.d.id; S.ring.material.opacity = hov ? 0.9 : 0.25; S.ring.material.color.setHex(S.flash > 0.05 ? C.mint : C.warm);
        S.flash = Math.max(0, (S.flash || 0) - dt);
        S.chips.forEach(function (c, k) {
          var dr = c.userData.drop;
          if (dr) {
            if (clock < dr.t0) return;
            c.userData.vy = (c.userData.vy || 0) - 9.8 * dt; c.position.y += c.userData.vy * dt;
            if (c.position.y <= c.userData.ty) { c.position.y = c.userData.ty; c.userData.vy = -c.userData.vy * 0.3; if (Math.abs(c.userData.vy) < 0.25) { c.userData.drop = null; c.userData.vy = 0; } }
          } else {
            c.position.y += (c.userData.ty + (hov ? k * 0.012 : 0) - c.position.y) * Math.min(1, dt * 10);
          }
        });
      });
      if (opts.labels) labelSync(opts.labels, ix.project(stacks.map(function (S) { return { id: S.d.id, pos: new T.Vector3(S.x, -0.02, 0.36) }; })));
    }
    var lp = loop(ctrl, update, function () { st.renderer.render(scene, camera); });
    return common(lp, st, { payout: payout, dispose: function () { ix.dispose(); } });
  }

  /* ───────────────────────── FUND / SUBMIT MOMENTS ─────────────────────────
     Settld3D.moment(canvas, { mode: 'fund' | 'submit', onPick })  ->  setStep(0..3), fail()
     fund:   0 coins hover over the open safe · 1 approving (coins line up) · 2 locking (coins drop in) · 3 locked (lid shuts, lock ring)
     submit: 0 empty video tile · 1 link received (tile lights) · 2 checking (3 checker rings scan) · 3 verified (3 ticks) */
  function Moment(canvas, opts) {
    opts = opts || {};
    var st = baseStage(canvas, { fov: 30 }), scene = st.scene, camera = st.camera, ctrl = { autoplay: true, canvas: canvas };
    lights(scene);
    var ix = interact(canvas, camera, { onPick: opts.onPick, maxYaw: 0.7, maxPitch: 0.25 });
    var grid = new T.GridHelper(4, 20, C.line, C.line); grid.material.transparent = true; grid.material.opacity = 0.1; scene.add(grid);
    var mode = opts.mode || 'fund', step = 0, stepAt = 0, clock = 0, failed = false;
    var root = new T.Group(); scene.add(root);
    // fund pieces
    var safeG = new T.Group(); root.add(safeG);
    var body = new T.Mesh(new T.BoxGeometry(0.9, 0.5, 0.6), lambert(C.elev)); body.position.y = 0.25; safeG.add(body); ix.add(body, 'safe');
    var be = edgeBox(0.9, 0.5, 0.6, C.warm, 0.7); be.position.y = 0.25; safeG.add(be);
    var hole = new T.Mesh(new T.BoxGeometry(0.62, 0.01, 0.36), new T.MeshBasicMaterial({ color: 0x1A1A1A })); hole.position.y = 0.505; safeG.add(hole);
    var lidPivot = new T.Group(); lidPivot.position.set(0, 0.5, -0.3); safeG.add(lidPivot);
    var lidM = new T.Mesh(new T.BoxGeometry(0.92, 0.05, 0.62), lambert(C.elev)); lidM.position.set(0, 0.025, 0.31); lidPivot.add(lidM);
    var lidE = edgeBox(0.92, 0.05, 0.62, C.warm, 0.8); lidE.position.copy(lidM.position); lidPivot.add(lidE);
    var lockRing = hexLoop(0.16, C.ciel, 0); lockRing.position.set(0, 0.3, 0.305); lockRing.rotation.x = Math.PI / 2; safeG.add(lockRing);
    var lockFace = new T.Mesh(new T.PlaneGeometry(0.14, 0.14), new T.MeshBasicMaterial({ color: C.ciel, transparent: true, opacity: 0 })); lockFace.position.set(0, 0.3, 0.302); safeG.add(lockFace);
    var coins = []; for (var i = 0; i < 6; i++) { var c = new T.Group(), m = new T.Mesh(chipGeo(0.16, 0.035), lambert(C.ciel)), e = new T.LineSegments(coinEdge(0.16, 0.035), new T.LineBasicMaterial({ color: C.ink })); c.add(m); c.add(e); root.add(c); coins.push(c); }
    // submit pieces
    var subG = new T.Group(); root.add(subG);
    var tile = new T.Mesh(new T.BoxGeometry(0.5, 0.86, 0.04), lambert(0x1A1A1A)); tile.position.y = 0.5; subG.add(tile); ix.add(tile, 'video');
    var te = edgeBox(0.5, 0.86, 0.04, C.warm, 0.7); te.position.y = 0.5; subG.add(te);
    var screen = new T.Mesh(new T.PlaneGeometry(0.44, 0.74), new T.MeshBasicMaterial({ color: C.warm, transparent: true, opacity: 0 })); screen.position.set(0, 0.5, 0.021); subG.add(screen);
    var play = new T.Mesh(new T.CircleGeometry(0.07, 3), new T.MeshBasicMaterial({ color: C.ink, transparent: true, opacity: 0 })); play.position.set(0.005, 0.5, 0.023); subG.add(play);
    var checkers = []; for (var k = 0; k < 3; k++) { var a = (-0.9 + k * 0.9), cg = new T.Group(); cg.position.set(Math.sin(a) * 0.95, 0, Math.cos(a) * 0.55 - 0.15); subG.add(cg);
      var hm = new T.Mesh(hexGeo(0.13, 0.1), lambert(C.elev)); hm.position.y = 0.05; cg.add(hm); var he = new T.LineSegments(new T.EdgesGeometry(hexGeo(0.13, 0.1)), new T.LineBasicMaterial({ color: C.warm, transparent: true, opacity: 0.6 })); he.position.y = 0.05; cg.add(he);
      var ring = hexLoop(0.17, C.orange, 0); cg.add(ring); var tick = new T.Mesh(new T.BoxGeometry(0.08, 0.08, 0.08), lambert(C.ciel)); tick.position.y = 0.2; tick.visible = false; cg.add(tick);
      var beam = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0.12, 0), tile.position.clone().sub(cg.position)]), new T.LineBasicMaterial({ color: C.orange, transparent: true, opacity: 0 })); cg.add(beam);
      checkers.push({ g: cg, ring: ring, tick: tick, beam: beam, edge: he, idx: k }); ix.add(hm, 'checker-' + (k + 1)); }
    function setMode(m) { mode = m; safeG.visible = coins[0].visible = (m === 'fund'); coins.forEach(function (c) { c.visible = m === 'fund'; }); subG.visible = m === 'submit'; }
    setMode(mode);
    var BASE = { r: opts.camR || 2.6, yaw: 0.35, pitch: opts.camPitch || 0.42 }, TGT = new T.Vector3(0, opts.camY == null ? 0.36 : opts.camY, 0);
    function update(t, dt) {
      dt = dt || 0.016; clock += dt; ix.update(dt); orbitCam(camera, ix, BASE, TGT);
      var k = clock - stepAt;
      if (mode === 'fund') {
        coins.forEach(function (c, i) {
          var hover = new T.Vector3((i - 2.5) * 0.2, 0.84 + Math.sin(clock * 2 + i) * 0.02, 0.05);
          var line = new T.Vector3((i - 2.5) * 0.12, 0.8, 0.05);
          var inSafe = new T.Vector3((i % 3 - 1) * 0.18, 0.08 + Math.floor(i / 3) * 0.04, (i < 3 ? -0.05 : 0.08));
          var p;
          if (step <= 0) p = hover;
          else if (step === 1) p = new T.Vector3().lerpVectors(hover, line, easeInOut(seg(k, i * 0.05, 0.5 + i * 0.05)));
          else { var dk = easeInOut(seg(k, i * 0.12, 0.55 + i * 0.12)); p = new T.Vector3().lerpVectors(step === 2 ? line : inSafe, inSafe, step === 2 ? dk : 1); if (step === 2) p.y += Math.sin(Math.PI * dk) * 0.12; }
          c.position.copy(p); c.rotation.y = step >= 2 ? 0 : clock * 0.6 + i;
          c.children[0].material.color.setHex(failed ? C.red : (step === 1 ? C.peach : C.ciel));
        });
        var shut = step >= 3 ? easeInOut(seg(k, 0, 0.5)) : 0;
        lidPivot.rotation.x = -1.25 * (1 - shut);
        lockRing.material.opacity = step >= 3 ? seg(k, 0.4, 0.7) : 0; lockFace.material.opacity = step >= 3 ? 0.9 * seg(k, 0.5, 0.8) : 0;
        lockRing.scale.setScalar(1 + (step >= 3 ? (1 - seg(k, 0.4, 0.9)) * 0.6 : 0));
        be.material.color.setHex(failed ? C.red : (step >= 3 ? C.ciel : C.warm));
      } else {
        screen.material.opacity = step >= 1 ? 0.95 * seg(k + (step > 1 ? 9 : 0), 0, 0.4) : 0; play.material.opacity = screen.material.opacity;
        te.material.color.setHex(failed ? C.red : step >= 3 ? C.blue : C.warm);
        checkers.forEach(function (ch) {
          var sk = (clock * 0.8 + ch.idx * 0.33) % 1;
          ch.ring.material.opacity = step === 2 ? Math.sin(Math.PI * sk) : 0; ch.ring.position.y = 0.02 + sk * 0.3;
          ch.beam.material.opacity = step === 2 ? 0.35 + 0.35 * Math.sin(clock * 6 + ch.idx) : 0;
          var on = step >= 3 && seg(k, ch.idx * 0.25, ch.idx * 0.25 + 0.3) > 0;
          ch.tick.visible = on && !failed; ch.tick.scale.setScalar(Math.max(0.001, easeOut(seg(k, ch.idx * 0.25, ch.idx * 0.25 + 0.3))));
          ch.tick.rotation.y = clock; ch.edge.material.color.setHex(on ? (failed ? C.red : C.blue) : C.warm);
        });
      }
    }
    var lp = loop(ctrl, update, function () { st.renderer.render(scene, camera); });
    return common(lp, st, {
      setStep: function (s) { if (s !== step) { step = s; stepAt = clock; failed = false; } },
      fail: function () { failed = true; stepAt = clock; },
      setMode: function (m) { setMode(m); step = 0; stepAt = clock; failed = false; },
      dispose: function () { ix.dispose(); }
    });
  }

  return {
    handshake: function (c, o) { return Settld3DHandshake(c, o); },
    jury: function (c, o) { return Settld3DJury(c, o); },
    vault: function (c, o) { return Vault(c, o); },
    coins: function (c, o) { return Coins(c, o); },
    moment: function (c, o) { return Moment(c, o); },
    juryBeats: JURY_BEATS, juryLength: JURY_LEN, _hp: HP, _hs: Settld3DHandshake
  };
})();
