(function () {
  const PHASES = {
    T: { name: "Takeoff", color: "#49b6ff" },
    S: { name: "Search", color: "#ffc44d" },
    A: { name: "Acquire", color: "#ff8a3d" },
    K: { name: "Track", color: "#6ee8d1" },
    L: { name: "Lost", color: "#d09bff" },
    R: { name: "Reacquire", color: "#8eb6ff" },
    O: { name: "Other", color: "#b7c0c7" }
  };
  const ORDER = ["T", "S", "A", "K", "L", "R", "O"];

  const state = {
    pack: null,
    wanted: null,
    ep: null,
    index: 0,
    cursor: 0,
    playing: false,
    visible: false,
    raf: 0,
    lastTick: 0,
    az: -0.85,
    el: 0.58,
    radius: 80,
    look: { x: 0, y: 0, z: 8 },
    home: null,
    drag: null,
    pointers: new Map(),
    w: 1,
    h: 1
  };

  const canvas = () => document.getElementById("traj-canvas");
  let ctx = null;
  let sharedVideo = null;
  let detachVideo = null;
  const media = () => sharedVideo || document.getElementById("traj-video");

  function attachVideo(video) {
    if (sharedVideo === video) return;
    if (detachVideo) detachVideo();
    sharedVideo = video;
    state.grab = null;
    state.grabTime = null;
    const refresh = () => {
      if (!state.ep) return;
      adoptVideoClock();
      state.playing = !video.paused && !video.ended;
      clearTimeout(state.playTimer);
      if (state.visible) {
        renderChrome();
        draw();
        if (state.playing) state.playTimer = setTimeout(advanceFrame, 80);
        ensurePump();
      }
    };
    const events = ["play", "pause", "ended", "loadeddata", "seeked"];
    events.forEach((event) => video.addEventListener(event, refresh));
    detachVideo = () => events.forEach((event) => video.removeEventListener(event, refresh));
  }

  function notifyPlayback(playing) {
    document.dispatchEvent(new CustomEvent("missionplaybackchange", { detail: { playing } }));
  }

  function boot(pack) {
    state.pack = pack;
    bind();
    if (state.wanted) show(state.wanted, state.clip, state.record);
  }

  function show(episodeIndex, clipSrc, record) {
    state.wanted = String(episodeIndex);
    if (clipSrc) state.clip = clipSrc;
    if (record) state.record = record;
    if (!state.pack) return;
    const ep = state.pack.episodes[state.wanted];
    const stage = document.getElementById("traj-stage");
    if (!ep || !stage) {
      if (stage) stage.hidden = true;
      return;
    }
    stage.hidden = false;
    state.ep = ep;
    state.playing = sharedVideo ? !sharedVideo.paused && !sharedVideo.ended : false;
    clearTimeout(state.playTimer);
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.sparks = [];
    state.cursor = 0;
    state.index = 0;
    state.needsFrame = false;
    loadClip();
    if (sharedVideo) adoptVideoClock();
    fit(true);
    if (!sharedVideo) resetPlate();
    tighten();
    renderChrome();
    requestAnimationFrame(resize);
    ensurePump();
    if (sharedVideo && state.playing && state.visible) state.playTimer = setTimeout(advanceFrame, 80);
  }

  function loadClip() {
    const video = media();
    if (!video) return;
    const clip = state.clip;
    if (sharedVideo) {
      state.loadedClip = clip;
      state.grab = null;
      state.grabTime = null;
      return;
    }
    if (!clip) {
      video.removeAttribute("src");
      video.load();
      return;
    }
    if (state.loadedClip === clip && video.src) {
      state.seeking = false;
      try { video.currentTime = 0; } catch (err) { /* The new scene starts at the first frame. */ }
      return;
    }
    state.loadedClip = clip;
    state.grab = null;
    state.grabTime = null;
    state.seeking = false;
    video.src = clip;
    video.load();
  }

  function grabVideoFrame() {
    const video = media();
    if (!state.visible || !video || video.readyState < 2 || !video.videoWidth) return;
    if (state.grab && state.grabTime === video.currentTime) return;
    if (!state.grab) {
      state.grab = document.createElement("canvas");
      state.grab.width = 640;
      state.grab.height = 360;
    }
    state.grab.getContext("2d").drawImage(video, 0, 0, 640, 360);
    state.grabTime = video.currentTime || 0;
  }

  function desiredTime() {
    if (!state.ep) return 0;
    return state.cursor * state.ep.dt;
  }

  function syncVideo() {
    const video = media();
    if (sharedVideo) return false;
    if (!state.visible || !video || !state.ep || !video.src || video.readyState < 1) return false;
    const limit = Number.isFinite(video.duration) && video.duration > 0.1
      ? Math.max(0, video.duration - 0.04)
      : desiredTime();
    state.wantVideoTime = Math.min(Math.max(0, desiredTime()), limit);
    if (state.playing && video.paused && video.currentTime < limit) video.play().catch(() => {});
    const drift = Math.abs((video.currentTime || 0) - state.wantVideoTime);
    if (state.seeking || drift < (state.playing ? 0.85 : 0.08)) return false;
    state.seeking = true;
    try {
      video.currentTime = state.wantVideoTime;
    } catch (err) {
      state.seeking = false;
    }
    return false;
  }

  function adoptVideoClock() {
    if (!state.ep) return;
    const video = media();
    if (sharedVideo) {
      state.cursor = Math.max(0, Math.min(count() - 1, (video.currentTime || 0) / state.ep.dt));
      state.index = Math.round(state.cursor);
      return;
    }
    if (!state.playing) return;
    if (!video || video.readyState < 2 || video.ended) return;
    const clip = Number.isFinite(video.duration) && video.duration > 0.2 ? video.duration : 0;
    if (!clip || state.cursor * state.ep.dt > clip - 0.05) return;
    const maxFrame = count() - 1;
    const t = Math.min(Math.max(0, video.currentTime || 0), Math.min(clip, maxFrame * state.ep.dt));
    state.cursor = t / state.ep.dt;
    state.index = Math.round(state.cursor);
  }

  function finishSeek() {
    const video = media();
    state.seeking = false;
    grabVideoFrame();
    if (!state.visible || !video || !state.ep) return;
    if (!state.playing) draw();
    if (state.playing) {
      const wait = Math.max(0, (state.stepStarted || 0) + state.ep.dt * 1000 - performance.now());
      clearTimeout(state.playTimer);
      state.playTimer = setTimeout(advanceFrame, wait);
      return;
    }
    if (Math.abs((video.currentTime || 0) - desiredTime()) > 0.12) syncVideo();
  }

  function advanceFrame() {
    if (!state.visible || !state.playing || !state.ep) return;
    const video = media();
    if (sharedVideo) {
      adoptVideoClock();
      state.playing = !video.paused && !video.ended;
      renderChrome();
      clearTimeout(state.playTimer);
      if (state.playing) state.playTimer = setTimeout(advanceFrame, 80);
      return;
    }
    const maxFrame = count() - 1;
    const clip = video && Number.isFinite(video.duration) && video.duration > 0.2 ? video.duration : 0;
    const flown = state.cursor * state.ep.dt;
    if (clip && video.readyState >= 2 && flown < clip - 0.08 && !video.ended) adoptVideoClock();
    else if (state.cursor < maxFrame) state.cursor = Math.min(maxFrame, state.cursor + 0.08 / state.ep.dt);
    else {
      state.playing = false;
      renderChrome();
      draw();
      return;
    }
    state.index = Math.round(state.cursor);
    renderChrome();
    syncVideo();
    clearTimeout(state.playTimer);
    state.playTimer = setTimeout(advanceFrame, 80);
  }

  function count() {
    return state.ep ? state.ep.phase.length : 0;
  }

  function sample(i) {
    const ep = state.ep;
    const k = Math.max(0, Math.min(ep.phase.length - 1, i | 0));
    const u = k * 5;
    const t = k * 3;
    return {
      x: ep.uav[u], y: ep.uav[u + 1], z: ep.uav[u + 2],
      yaw: ep.uav[u + 3], pitch: ep.uav[u + 4],
      tx: ep.target[t], ty: ep.target[t + 1], tz: ep.target[t + 2],
      phase: ep.phase.charAt(k),
      time: k * ep.dt
    };
  }

  function currentSample() {
    return sampleAt(state.cursor);
  }

  function sampleAt(frame) {
    const n = count();
    const f = Math.max(0, Math.min(n - 1, frame));
    const i0 = Math.floor(f);
    const i1 = Math.min(n - 1, i0 + 1);
    const a = sample(i0);
    const b = sample(i1);
    const u = f - i0;
    if (!u || i0 === i1) return a;
    const mix = (p, q) => p + (q - p) * u;
    let dyaw = b.yaw - a.yaw;
    if (dyaw > 180) dyaw -= 360;
    if (dyaw < -180) dyaw += 360;
    return {
      x: mix(a.x, b.x), y: mix(a.y, b.y), z: mix(a.z, b.z),
      yaw: a.yaw + dyaw * u, pitch: mix(a.pitch, b.pitch),
      tx: mix(a.tx, b.tx), ty: mix(a.ty, b.ty), tz: mix(a.tz, b.tz),
      phase: u < 0.5 ? a.phase : b.phase,
      time: mix(a.time, b.time)
    };
  }

  function fit(store) {
    const n = count();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const s = sample(i);
      minX = Math.min(minX, s.x, s.tx);
      minY = Math.min(minY, s.y, s.ty);
      minZ = Math.min(minZ, s.z, s.tz);
      maxX = Math.max(maxX, s.x, s.tx);
      maxY = Math.max(maxY, s.y, s.ty);
      maxZ = Math.max(maxZ, s.z, s.tz);
    }
    const look = {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2,
      z: Math.max(4, (minZ + maxZ) * 0.32)
    };
    const radius = Math.max(36, Math.hypot((maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2) * 1.85);
    state.look = look;
    state.radius = radius;
    state.az = -0.35;
    state.el = 0.46;
    const span = Math.max(maxX - minX, maxY - minY);
    const reach = Math.max(span * 0.62, 30);
    if (store) state.home = { look: { ...look }, radius, az: state.az, el: state.el, span, reach };
  }

  function contentPoints() {
    const pts = [];
    const n = count();
    const step = Math.max(1, Math.floor((n - 1) / 56));
    for (let i = 0; i < n; i += step) {
      const s = sample(i);
      pts.push([s.x, s.y, s.z], [s.tx, s.ty, s.tz], [s.x, s.y, 0]);
    }
    const last = sample(n - 1);
    pts.push([last.x, last.y, last.z], [last.tx, last.ty, last.tz], [last.x, last.y, 0]);
    const s = sample(state.index);
    const frame = camFrame(s.yaw, s.pitch);
    const length = 15;
    const hh = Math.tan((state.ep.hfov * Math.PI) / 360) * length;
    const vv = Math.tan((state.ep.vfov * Math.PI) / 360) * length;
    [-1, 1].forEach((sy) => {
      [-1, 1].forEach((sx) => {
        pts.push([
          s.x + frame.f[0] * length + frame.r[0] * hh * sx + frame.u[0] * vv * sy,
          s.y + frame.f[1] * length + frame.r[1] * hh * sx + frame.u[1] * vv * sy,
          s.z + frame.f[2] * length + frame.r[2] * hh * sx + frame.u[2] * vv * sy
        ]);
      });
    });
    pts.push([s.x, s.y, s.z], [s.tx, s.ty, s.tz + 0.6]);
    return pts;
  }

  function viewMargins() {
    const short = Math.min(state.w, state.h);
    return {
      l: Math.max(16, Math.min(92, short * 0.1)),
      t: Math.max(14, Math.min(58, short * 0.075)),
      r: Math.max(14, Math.min(40, short * 0.045)),
      b: Math.max(18, Math.min(78, short * 0.11))
    };
  }

  function inside(point, margin) {
    const basis = cameraBasis();
    const q = project(point, basis);
    if (!q) return false;
    return q.x >= margin.l && q.x <= state.w - margin.r && q.y >= margin.t && q.y <= state.h - margin.b;
  }

  function frameContents() {
    const points = contentPoints();
    let sx = 0;
    let sy = 0;
    let sz = 0;
    points.forEach((p) => { sx += p[0]; sy += p[1]; sz += p[2]; });
    state.look = {
      x: sx / points.length,
      y: sy / points.length,
      z: Math.max(3, sz / points.length)
    };
    const margin = viewMargins();
    let mx = 0;
    let my = 0;
    points.forEach((p) => { mx += p[0]; my += p[1]; });
    mx /= points.length;
    my /= points.length;
    let xx = 0;
    let xy = 0;
    let yy = 0;
    points.forEach((p) => {
      const dx = p[0] - mx;
      const dy = p[1] - my;
      xx += dx * dx;
      xy += dx * dy;
      yy += dy * dy;
    });
    const axis = 0.5 * Math.atan2(2 * xy, xx - yy);
    const candidates = [];
    for (let k = 0; k < 8; k += 1) candidates.push(axis + Math.PI + (k * Math.PI) / 8);
    const elevations = [0.34, 0.44, 0.56, 0.7];
    let best = null;
    const saved = { az: state.az, el: state.el, radius: state.radius };
    candidates.forEach((az) => {
      elevations.forEach((el) => {
        state.az = az;
        state.el = el;
        let lo = 12;
        let hi = 1800;
        let fitRadius = null;
        for (let step = 0; step < 14; step += 1) {
          const mid = (lo + hi) / 2;
          state.radius = mid;
          if (points.every((p) => inside(p, margin))) {
            fitRadius = mid;
            hi = mid;
          } else lo = mid;
        }
        if (fitRadius == null) return;
        const off = Math.abs(Math.atan2(Math.sin(az - axis), Math.cos(az - axis)));
        const quarter = Math.min(off, Math.PI - off);
        const threeQuarter = quarter > 0.7 && quarter < 1.2;
        const score = fitRadius * (1 + Math.abs(el - 0.4) * 0.22) * (threeQuarter ? 1 : 2.4);
        if (!best || score < best.score) best = { az, el, radius: fitRadius * 1.22, score };
      });
    });
    if (!best) {
      state.az = saved.az;
      state.el = saved.el;
      state.radius = saved.radius;
      return;
    }
    state.az = best.az;
    state.el = best.el;
    state.radius = best.radius;
    let far = 24;
    points.forEach((p) => {
      far = Math.max(far, Math.hypot(p[0] - state.look.x, p[1] - state.look.y));
    });
    state.home = {
      look: { ...state.look },
      radius: state.radius,
      az: state.az,
      el: state.el,
      span: state.home ? state.home.span : far,
      reach: far * 1.22
    };
    beginIntro();
  }

  function beginIntro() {
    if (!state.home) return;
    state.intro = {
      t0: performance.now(),
      fromAz: state.home.az - 0.7,
      fromEl: Math.min(1.12, state.home.el + 0.36),
      fromR: state.home.radius * 1.48,
      toAz: state.home.az,
      toEl: state.home.el,
      toR: state.home.radius
    };
    state.az = state.intro.fromAz;
    state.el = state.intro.fromEl;
    state.radius = state.intro.fromR;
  }

  function easeIntro() {
    if (!state.intro || state.drag) return;
    const u = Math.min(1, (performance.now() - state.intro.t0) / 1400);
    const e = u * u * (3 - 2 * u);
    const intro = state.intro;
    state.az = intro.fromAz + (intro.toAz - intro.fromAz) * e;
    state.el = intro.fromEl + (intro.toEl - intro.fromEl) * e;
    state.radius = intro.fromR + (intro.toR - intro.fromR) * e;
    if (u >= 1) state.intro = null;
  }

  function eyePos() {
    const ce = Math.cos(state.el);
    const se = Math.sin(state.el);
    return {
      x: state.look.x + state.radius * ce * Math.sin(state.az),
      y: state.look.y + state.radius * ce * Math.cos(state.az),
      z: state.look.z + state.radius * se
    };
  }

  function cameraBasis() {
    const eye = eyePos();
    const zx = eye.x - state.look.x;
    const zy = eye.y - state.look.y;
    const zz = eye.z - state.look.z;
    const zl = Math.hypot(zx, zy, zz) || 1;
    const zxn = zx / zl, zyn = zy / zl, zzn = zz / zl;
    let xx = -zyn, xy = zxn, xz = 0;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl; xy /= xl; xz /= xl;
    const yx = zyn * xz - zzn * xy;
    const yy = zzn * xx - zxn * xz;
    const yz = zxn * xy - zyn * xx;
    return { eye, x: [xx, xy, xz], y: [yx, yy, yz], z: [zxn, zyn, zzn] };
  }

  function project(p, basis) {
    const dx = p[0] - basis.eye.x;
    const dy = p[1] - basis.eye.y;
    const dz = p[2] - basis.eye.z;
    const cx = dx * basis.x[0] + dy * basis.x[1] + dz * basis.x[2];
    const cy = dx * basis.y[0] + dy * basis.y[1] + dz * basis.y[2];
    const cz = dx * basis.z[0] + dy * basis.z[1] + dz * basis.z[2];
    const depth = -cz;
    if (depth < 0.8) return null;
    const f = 1 / Math.tan((42 * Math.PI) / 360);
    const aspect = state.w / state.h;
    const ndcX = (cx / depth) * (f / aspect);
    const ndcY = (cy / depth) * f;
    return {
      x: (ndcX * 0.5 + 0.5) * state.w,
      y: (1 - (ndcY * 0.5 + 0.5)) * state.h,
      depth
    };
  }

  function camFrame(yawDeg, pitchDeg) {
    const yaw = (yawDeg * Math.PI) / 180;
    const pitch = (pitchDeg * Math.PI) / 180;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const f = [cp * cy, cp * sy, sp];
    const r = [-sy, cy, 0];
    const u = [
      f[1] * r[2] - f[2] * r[1],
      f[2] * r[0] - f[0] * r[2],
      f[0] * r[1] - f[1] * r[0]
    ];
    return { f, r, u };
  }

  function tighten() {
    const s = sample(0);
    state.look = { x: s.x, y: s.y, z: s.z };
    state.radius = 13;
    state.el = 0.72;
    state.home = {
      look: { ...state.look },
      radius: state.radius,
      az: state.az,
      el: state.el,
      span: 20,
      reach: 20
    };
    beginIntro();
  }

  function followCraft() {
    if (!state.ep) return;
    const s = currentSample();
    if (state.drag) return;
    state.look.x += (s.x - state.look.x) * 0.28;
    state.look.y += (s.y - state.look.y) * 0.28;
    state.look.z += (s.z + 5.2 - state.look.z) * 0.28;
    if (state.intro) return;
    const prev = sampleAt(Math.max(0, state.cursor - 5));
    const vx = s.x - prev.x;
    const vy = s.y - prev.y;
    if (Math.hypot(vx, vy) < 0.3) return;
    const behind = Math.atan2(-vx, -vy);
    let turn = behind - state.az;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    state.az += turn * 0.08;
  }

  function pictureSource() {
    const video = media();
    if (video && video.readyState >= 2 && video.videoWidth) return video;
    return state.grab || null;
  }

  function coverRect(image) {
    const w = state.w;
    const h = state.h;
    const scale = Math.max(w / image.width, h / image.height);
    const dw = image.width * scale;
    const dh = image.height * scale;
    return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
  }

  function drawVideoCover() {
    const video = media();
    if (video && video.readyState >= 2 && video.videoWidth) grabVideoFrame();
    const image = state.grab && state.grab.width ? state.grab : null;
    ctx.fillStyle = "#12171c";
    ctx.fillRect(0, 0, state.w, state.h);
    if (!image) return null;
    const rect = coverRect(image);
    ctx.drawImage(image, rect.x, rect.y, rect.w, rect.h);
    return rect;
  }

  function projectToPicture(world, pose, rect) {
    const frame = camFrame(pose.yaw, pose.pitch);
    const dx = world[0] - pose.x;
    const dy = world[1] - pose.y;
    const dz = world[2] - pose.z;
    const cf = dx * frame.f[0] + dy * frame.f[1] + dz * frame.f[2];
    const cr = dx * frame.r[0] + dy * frame.r[1] + dz * frame.r[2];
    const cu = dx * frame.u[0] + dy * frame.u[1] + dz * frame.u[2];
    const th = Math.tan((state.ep.hfov * Math.PI) / 360);
    const tv = Math.tan((state.ep.vfov * Math.PI) / 360);
    const ahead = Math.max(cf, 0.35);
    let u = cr / (ahead * th);
    let v = cu / (ahead * tv);
    if (cf <= 0.35) { u = -u; v = -v; }
    const limit = 0.9;
    const fit = Math.max(1, Math.abs(u) / limit, Math.abs(v) / limit);
    u /= fit;
    v /= fit;
    return {
      x: rect.x + (u * 0.5 + 0.5) * rect.w,
      y: rect.y + (0.5 - v * 0.5) * rect.h
    };
  }

  function drawPictureTrail(pose, rect) {
    const last = Math.floor(state.cursor);
    if (last < 1) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let open = false;
    for (let i = 1; i <= last; i += 1) {
      const a = sample(i - 1);
      const b = sample(i);
      const pa = projectToPicture([a.x, a.y, a.z], pose, rect);
      const pb = projectToPicture([b.x, b.y, b.z], pose, rect);
      const fade = 0.2 + 0.8 * (i / last);
      ctx.strokeStyle = hexAlpha(PHASES[a.phase].color, 0.15 + 0.8 * fade);
      ctx.lineWidth = 2 + 4 * (i / last);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
      open = true;
    }
    if (!open) return;
    const tip = projectToPicture([pose.x, pose.y, pose.z], pose, rect);
    ctx.fillStyle = "#f7fbff";
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawTargetMark(pose, rect) {
    const p = projectToPicture([pose.tx, pose.ty, pose.tz + 0.7], pose, rect);
    const animate = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const effect = window.AerialMission.effects(state.ep,state.cursor,animate);
    const pulse = 22 + (effect.beat-.5)*4;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(p.x, p.y, pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = effect.color;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = effect.color;
    ctx.fill();
    if (effect.capture > 0) {
      ctx.globalAlpha = effect.capture;
      ctx.strokeStyle = effect.color;ctx.lineWidth = 2.5;
      ctx.beginPath();ctx.arc(p.x,p.y,pulse+12+(1-effect.capture)*30,0,Math.PI*2);ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.font = "600 13px Palatino, 'Palatino Linotype', Georgia, serif";
    ctx.textAlign = "left";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(20, 6, 8, 0.72)";
    ctx.strokeText("Target", p.x + pulse + 8, p.y - pulse + 4);
    ctx.fillStyle = "#ffe8ea";
    ctx.fillText("Target", p.x + pulse + 8, p.y - pulse + 4);
    ctx.restore();
  }

  function drawPhaseBadge(pose, rect) {
    const phase = PHASES[pose.phase] || PHASES.O;
    const name = phase.name.toUpperCase();
    ctx.save();
    ctx.font = "600 11px Palatino, 'Palatino Linotype', Georgia, serif";
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.72)";
    ctx.fillText("PHASE", rect.x + rect.w - 22, rect.y + 28);
    ctx.font = "600 28px Palatino, 'Palatino Linotype', Georgia, serif";
    const width = ctx.measureText(name).width;
    const x = rect.x + rect.w - 22;
    const y = rect.y + 62;
    ctx.fillStyle = "rgba(8, 14, 20, 0.28)";
    ctx.fillRect(x - width - 16, y - 28, width + 28, 40);
    ctx.fillStyle = phase.color;
    ctx.fillRect(x - width - 16, y - 28, 4, 40);
    ctx.fillStyle = "#f7fbff";
    ctx.fillText(name, x, y);
    ctx.restore();
  }

  function resetPlate() {
    const n = count();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const s = sample(i);
      minX = Math.min(minX, s.x, s.tx);
      minY = Math.min(minY, s.y, s.ty);
      maxX = Math.max(maxX, s.x, s.tx);
      maxY = Math.max(maxY, s.y, s.ty);
    }
    const span = Math.max(24, maxX - minX, maxY - minY);
    const pad = Math.max(90, span * 0.85);
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 1280;
    state.plate = {
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad,
      canvas,
      ctx: canvas.getContext("2d"),
      view: 28,
      mask: new Uint8Array(28 * 28),
      painted: -1
    };
  }

  function worldToPlate(x, y) {
    const plate = state.plate;
    return [
      ((x - plate.minX) / (plate.maxX - plate.minX)) * plate.canvas.width,
      ((plate.maxY - y) / (plate.maxY - plate.minY)) * plate.canvas.height
    ];
  }

  function plateToWorld(px, py) {
    const plate = state.plate;
    return [
      plate.minX + (px / plate.canvas.width) * (plate.maxX - plate.minX),
      plate.maxY - (py / plate.canvas.height) * (plate.maxY - plate.minY),
      0.05
    ];
  }

  function affineRow(u0, v0, u1, v1, u2, v2, x0, x1, x2) {
    const det = u0 * (v1 - v2) - v0 * (u1 - u2) + (u1 * v2 - u2 * v1);
    if (Math.abs(det) < 1e-4) return null;
    return [
      (x0 * (v1 - v2) - v0 * (x1 - x2) + (x1 * v2 - x2 * v1)) / det,
      (u0 * (x1 - x2) - x0 * (u1 - u2) + (u1 * x2 - u2 * x1)) / det,
      (u0 * (v1 * x2 - v2 * x1) - v0 * (u1 * x2 - u2 * x1) + x0 * (u1 * v2 - u2 * v1)) / det
    ];
  }

  function paintTri(context, image, p0, p1, p2, u0, v0, u1, v1, u2, v2) {
    const xs = affineRow(u0, v0, u1, v1, u2, v2, p0[0], p1[0], p2[0]);
    const ys = affineRow(u0, v0, u1, v1, u2, v2, p0[1], p1[1], p2[1]);
    if (!xs || !ys) return;
    context.save();
    context.beginPath();
    context.moveTo(p0[0], p0[1]);
    context.lineTo(p1[0], p1[1]);
    context.lineTo(p2[0], p2[1]);
    context.closePath();
    context.clip();
    context.transform(xs[0], ys[0], xs[1], ys[1], xs[2], ys[2]);
    context.drawImage(image, 0, 0);
    context.restore();
  }

  function groundRay(s, frame, u, v) {
    const th = Math.tan((state.ep.hfov * Math.PI) / 360);
    const tv = Math.tan((state.ep.vfov * Math.PI) / 360);
    const dir = [
      frame.f[0] + frame.r[0] * th * u + frame.u[0] * tv * v,
      frame.f[1] + frame.r[1] * th * u + frame.u[1] * tv * v,
      frame.f[2] + frame.r[2] * th * u + frame.u[2] * tv * v
    ];
    if (dir[2] >= -0.04) return null;
    const dist = (0.02 - s.z) / dir[2];
    if (dist < 0.6 || dist > 160) return null;
    return [s.x + dir[0] * dist, s.y + dir[1] * dist];
  }

  function markPlate(points) {
    const plate = state.plate;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    points.forEach((p) => {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    });
    const x0 = Math.max(0, Math.floor(minX / plate.canvas.width * plate.view));
    const y0 = Math.max(0, Math.floor(minY / plate.canvas.height * plate.view));
    const x1 = Math.min(plate.view - 1, Math.floor(maxX / plate.canvas.width * plate.view));
    const y1 = Math.min(plate.view - 1, Math.floor(maxY / plate.canvas.height * plate.view));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) plate.mask[y * plate.view + x] = 1;
    }
  }

  function paintVideoFrame() {
    const plate = state.plate;
    const video = media();
    if (!plate || !video || !state.ep || state.loadedClip !== state.clip) return;
    const image = state.grab;
    if (!image || state.grabTime == null) return;
    const frame = Math.round(state.grabTime / state.ep.dt);
    if (plate.painted === frame) return;
    const s = sampleAt(state.grabTime / state.ep.dt);
    const cam = camFrame(s.yaw, s.pitch);
    const cols = 18;
    const rows = 10;
    const hits = [];
    for (let iy = 0; iy <= rows; iy += 1) {
      for (let ix = 0; ix <= cols; ix += 1) {
        const u = (ix / cols) * 2 - 1;
        const v = 1 - (iy / rows) * 2;
        hits.push(groundRay(s, cam, u, v));
      }
    }
    const stride = cols + 1;
    let wrote = false;
    for (let iy = 0; iy < rows; iy += 1) {
      for (let ix = 0; ix < cols; ix += 1) {
        const a = hits[iy * stride + ix];
        const b = hits[iy * stride + ix + 1];
        const c = hits[(iy + 1) * stride + ix];
        const d = hits[(iy + 1) * stride + ix + 1];
        if (!a || !b || !c || !d) continue;
        const edge = Math.max(
          Math.hypot(a[0] - b[0], a[1] - b[1]),
          Math.hypot(a[0] - c[0], a[1] - c[1]),
          Math.hypot(b[0] - d[0], b[1] - d[1])
        );
        if (edge > 72) continue;
        const su = (ix / cols) * image.width;
        const sv = (iy / rows) * image.height;
        const sw = image.width / cols;
        const sh = image.height / rows;
        const A = worldToPlate(a[0], a[1]);
        const B = worldToPlate(b[0], b[1]);
        const C = worldToPlate(c[0], c[1]);
        const D = worldToPlate(d[0], d[1]);
        paintTri(plate.ctx, image, A, B, C, su, sv, su + sw, sv, su, sv + sh);
        paintTri(plate.ctx, image, B, D, C, su + sw, sv, su + sw, sv + sh, su, sv + sh);
        markPlate([A, B, C, D]);
        wrote = true;
      }
    }
    if (wrote) plate.painted = frame;
  }

  function drawLiveGround(basis) {
    const video = media();
    if (!video || !state.ep || state.loadedClip !== state.clip) return;
    const image = state.grab;
    if (!image || state.grabTime == null) return;
    const s = sampleAt(state.grabTime / state.ep.dt);
    const cam = camFrame(s.yaw, s.pitch);
    const cols = 22;
    const rows = 12;
    const hits = [];
    for (let iy = 0; iy <= rows; iy += 1) {
      for (let ix = 0; ix <= cols; ix += 1) {
        const u = (ix / cols) * 2 - 1;
        const v = 1 - (iy / rows) * 2;
        hits.push(groundRay(s, cam, u, v));
      }
    }
    const stride = cols + 1;
    const cells = [];
    for (let iy = 0; iy < rows; iy += 1) {
      for (let ix = 0; ix < cols; ix += 1) {
        const a = hits[iy * stride + ix];
        const b = hits[iy * stride + ix + 1];
        const c = hits[(iy + 1) * stride + ix];
        const d = hits[(iy + 1) * stride + ix + 1];
        if (!a || !b || !c || !d) continue;
        const edge = Math.max(
          Math.hypot(a[0] - b[0], a[1] - b[1]),
          Math.hypot(a[0] - c[0], a[1] - c[1]),
          Math.hypot(b[0] - d[0], b[1] - d[1])
        );
        if (edge > 80) continue;
        const world = [
          [a[0], a[1], 0.12],
          [b[0], b[1], 0.12],
          [c[0], c[1], 0.12],
          [d[0], d[1], 0.12]
        ];
        const projected = world.map((point) => project(point, basis));
        if (projected.some((point) => !point)) continue;
        const depth = projected.reduce((sum, point) => sum + point.depth, 0) / projected.length;
        cells.push({
          projected,
          depth,
          su: (ix / cols) * image.width,
          sv: (iy / rows) * image.height,
          sw: image.width / cols,
          sh: image.height / rows
        });
      }
    }
    cells.sort((p, q) => q.depth - p.depth);
    cells.forEach((cell) => {
      const p = cell.projected;
      paintTri(ctx, image, [p[0].x, p[0].y], [p[1].x, p[1].y], [p[2].x, p[2].y], cell.su, cell.sv, cell.su + cell.sw, cell.sv, cell.su, cell.sv + cell.sh);
      paintTri(ctx, image, [p[1].x, p[1].y], [p[3].x, p[3].y], [p[2].x, p[2].y], cell.su + cell.sw, cell.sv, cell.su + cell.sw, cell.sv + cell.sh, cell.su, cell.sv + cell.sh);
    });
  }

  function drawPlate(basis) {
    const plate = state.plate;
    if (!plate) return;
    const cells = [];
    for (let iy = 0; iy < plate.view; iy += 1) {
      for (let ix = 0; ix < plate.view; ix += 1) {
        if (!plate.mask[iy * plate.view + ix]) continue;
        const x0 = (ix / plate.view) * plate.canvas.width;
        const y0 = (iy / plate.view) * plate.canvas.height;
        const x1 = ((ix + 1) / plate.view) * plate.canvas.width;
        const y1 = ((iy + 1) / plate.view) * plate.canvas.height;
        const corners = [plateToWorld(x0, y0), plateToWorld(x1, y0), plateToWorld(x0, y1), plateToWorld(x1, y1)];
        const projected = corners.map((corner) => project(corner, basis));
        if (projected.some((point) => !point)) continue;
        const depth = projected.reduce((sum, point) => sum + point.depth, 0) / projected.length;
        cells.push({ ix, iy, x0, y0, x1, y1, projected, depth });
      }
    }
    cells.sort((a, b) => b.depth - a.depth);
    cells.forEach((cell) => {
      const p = cell.projected;
      paintTri(ctx, plate.canvas, [p[0].x, p[0].y], [p[1].x, p[1].y], [p[2].x, p[2].y], cell.x0, cell.y0, cell.x1, cell.y0, cell.x0, cell.y1);
      paintTri(ctx, plate.canvas, [p[1].x, p[1].y], [p[3].x, p[3].y], [p[2].x, p[2].y], cell.x1, cell.y0, cell.x1, cell.y1, cell.x0, cell.y1);
    });
  }

  function wrap(deg) {
    let a = deg % 360;
    if (a > 180) a -= 360;
    if (a <= -180) a += 360;
    return a;
  }

  function resize() {
    const c = canvas();
    if (!state.visible || !c || !state.ep) return;
    const rect = c.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
    ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.w = rect.width;
    state.h = rect.height;
    if (state.needsFrame) {
      frameContents();
      state.needsFrame = false;
      renderChrome();
    }
    draw();
  }

  function shade(depth) {
    const near = Math.max(8, state.radius * 0.22);
    const far = state.radius * 2.2;
    const u = clamp((depth - near) / (far - near), 0, 1);
    return 1 - u * 0.8;
  }

  function craftSize() {
    return Math.max(1.35, state.radius * 0.036);
  }

  function draw() {
    if (!state.visible || !ctx || !state.ep) return;
    const w = state.w;
    const h = state.h;
    state.ms = performance.now();
    adoptVideoClock();
    followCraft();
    const pose = currentSample();
    const rect = drawVideoCover();
    const basis = cameraBasis();
    drawFlightTrail(basis);
    drawCraft(basis);
    if (rect && "AKLR".indexOf(pose.phase) >= 0) drawTargetMark(pose, rect);
  }

  function drawFlightTrail(basis) {
    const now = currentSample();
    const last = state.cursor;
    const spots = [];
    for (let frame = Math.max(0, last - 8); frame <= last; frame += 0.5) {
      const samplePose = sampleAt(frame);
      const dist = Math.hypot(samplePose.x - now.x, samplePose.y - now.y, samplePose.z - now.z);
      if (dist > 11) continue;
      const point = project([samplePose.x, samplePose.y, samplePose.z], basis);
      if (point) spots.push(point);
    }
    if (spots.length < 2) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < spots.length; i += 1) {
      const a = spots[i - 1];
      const b = spots[i];
      if (Math.hypot(a.x - b.x, a.y - b.y) > 90) continue;
      const fade = i / (spots.length - 1);
      ctx.strokeStyle = "rgba(255,255,255," + (0.12 + 0.78 * fade) + ")";
      ctx.lineWidth = 1.6 + 3.4 * fade;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawGround(basis) {
    const home = state.home;
    const span = home ? home.span : 80;
    const reach = home && home.reach ? home.reach : Math.max(40, span * 0.9);
    const pts = [];
    let groundOk = true;
    for (let i = 0; i < 96; i += 1) {
      const a = (i / 96) * Math.PI * 2;
      const p = project([
        state.look.x + Math.cos(a) * reach,
        state.look.y + Math.sin(a) * reach,
        0
      ], basis);
      if (!p) { groundOk = false; break; }
      pts.push(p);
    }
    if (groundOk) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = "#1a2228";
      ctx.fill();
    }

    let step = 10;
    while (span / step > 16) step *= 2;
    const minX = state.look.x - reach;
    const maxX = state.look.x + reach;
    const minY = state.look.y - reach;
    const maxY = state.look.y + reach;
    const center = [state.look.x, state.look.y];
    ctx.lineWidth = 1;
    for (let x = Math.floor(minX / step) * step; x <= maxX; x += step) {
      const clipped = clipToDisc([x, minY], [x, maxY], center, reach * 0.985);
      if (!clipped) continue;
      const major = Math.abs(Math.round(x / step) % 5) === 0;
      ctx.strokeStyle = major ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.03)";
      strokeWorld([clipped[0][0], clipped[0][1], 0.02], [clipped[1][0], clipped[1][1], 0.02], basis);
    }
    for (let y = Math.floor(minY / step) * step; y <= maxY; y += step) {
      const clipped = clipToDisc([minX, y], [maxX, y], center, reach * 0.985);
      if (!clipped) continue;
      const major = Math.abs(Math.round(y / step) % 5) === 0;
      ctx.strokeStyle = major ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.03)";
      strokeWorld([clipped[0][0], clipped[0][1], 0.02], [clipped[1][0], clipped[1][1], 0.02], basis);
    }
  }

  function drawClouds() {
    const w = state.w;
    const h = state.h;
    const drift = state.ms * 0.000008;
    const banks = [
      [0.12, 0.16, 0.28, 0.07, 0.16],
      [0.38, 0.12, 0.34, 0.08, 0.12],
      [0.62, 0.2, 0.26, 0.06, 0.18],
      [0.84, 0.14, 0.3, 0.07, 0.1],
      [0.22, 0.28, 0.18, 0.045, 0.08],
      [0.7, 0.3, 0.16, 0.04, 0.07]
    ];
    banks.forEach((bank) => {
      const x = ((bank[0] + drift * bank[4] * 40) % 1.4 - 0.2) * w;
      const y = bank[1] * h;
      const glow = ctx.createRadialGradient(x, y, 8, x, y, bank[2] * w);
      glow.addColorStop(0, "rgba(255, 236, 220, " + bank[4] + ")");
      glow.addColorStop(0.45, "rgba(186, 206, 214, " + bank[4] * 0.45 + ")");
      glow.addColorStop(1, "rgba(186, 206, 214, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.ellipse(x, y, bank[2] * w, bank[3] * h, 0, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function drawShafts() {
    const w = state.w;
    const h = state.h;
    const sx = w * 0.78;
    const sy = h * 0.02;
    ctx.save();
    for (let i = 0; i < 6; i += 1) {
      const sway = Math.sin(state.ms * 0.00025 + i) * 12;
      ctx.beginPath();
      ctx.moveTo(sx + sway, sy);
      ctx.lineTo(w * (0.15 + i * 0.12) + sway, h);
      ctx.lineTo(w * (0.28 + i * 0.12) + sway, h);
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 214, 170, 0.045)";
      ctx.fill();
    }
    ctx.restore();
  }

  function drawMotes(basis) {
    if (!state.motes) {
      state.motes = [];
      for (let i = 0; i < 56; i += 1) {
        state.motes.push({
          a: Math.random() * Math.PI * 2,
          r: 0.15 + Math.random() * 0.9,
          z: 1.5 + Math.random() * 26,
          s: 0.35 + Math.random() * 1.1,
          p: Math.random() * Math.PI * 2
        });
      }
    }
    const reach = state.home && state.home.reach ? state.home.reach : 80;
    state.motes.forEach((mote) => {
      const ang = mote.a + state.ms * 0.00004 * mote.s;
      const p = project([
        state.look.x + Math.cos(ang) * mote.r * reach,
        state.look.y + Math.sin(ang) * mote.r * reach,
        mote.z + Math.sin(state.ms * 0.0008 * mote.s + mote.p) * 1.4
      ], basis);
      if (!p) return;
      ctx.globalAlpha = 0.45 * shade(p.depth);
      ctx.fillStyle = mote.z > 14 ? "#fff4e4" : "#d5e4ea";
      ctx.beginPath();
      ctx.arc(p.x, p.y, mote.z > 18 ? 1.6 : 1.1, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawTerrain(basis, rim) {
    const home = state.home;
    const span = home ? home.span : 80;
    const reach = home && home.reach ? home.reach : Math.max(40, span * 0.9);
    let step = 12;
    while (span / step > 14) step *= 2;
    const center = [state.look.x, state.look.y];
    ctx.save();
    if (rim && rim.length) {
      ctx.beginPath();
      rim.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.clip();
    }
    for (let x = Math.floor((center[0] - reach) / step) * step; x < center[0] + reach; x += step) {
      for (let y = Math.floor((center[1] - reach) / step) * step; y < center[1] + reach; y += step) {
        if (Math.hypot(x + step * 0.5 - center[0], y + step * 0.5 - center[1]) > reach) continue;
        const n = hash2(x / step, y / step);
        const lift = 0.45 + n * 0.9;
        fillQuad([
          [x, y, 0.025],
          [x + step, y, 0.025],
          [x + step, y + step, 0.025],
          [x, y + step, 0.025]
        ], basis, () => "rgba(" + Math.floor(20 * lift) + "," + Math.floor(46 * lift) + "," + Math.floor(42 * lift) + ",0.55)");
      }
    }
    ctx.restore();
  }

  function hash2(x, y) {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  }

  function drawSun(basis) {
    const reach = state.home && state.home.reach ? state.home.reach : 80;
    const light = normalize([-0.45, -0.18, 0.88]);
    const p = project([
      state.look.x + light[0] * reach,
      state.look.y + light[1] * reach,
      Math.max(6, state.look.z) + light[2] * reach * 0.28
    ], basis);
    if (!p || p.x < -80 || p.y < -80 || p.x > state.w + 80 || p.y > state.h + 80) return;
    const glow = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 110);
    glow.addColorStop(0, "rgba(255, 244, 224, 0.95)");
    glow.addColorStop(0.18, "rgba(255, 196, 130, 0.35)");
    glow.addColorStop(1, "rgba(255, 170, 90, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 110, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawReflection(basis) {
    const reach = state.home && state.home.reach ? state.home.reach : 80;
    const rim = [];
    for (let i = 0; i < 72; i += 1) {
      const a = (i / 72) * Math.PI * 2;
      const p = project([
        state.look.x + Math.cos(a) * reach,
        state.look.y + Math.sin(a) * reach,
        0
      ], basis);
      if (!p) return;
      rim.push(p);
    }
    ctx.save();
    ctx.beginPath();
    rim.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.clip();
    const n = count();
    const last = Math.min(n - 2, Math.floor(state.cursor));
    const width = Math.max(0.7, craftSize() * 0.16);
    for (let i = 0; i <= last; i += 2) {
      const a = sample(i);
      const b = sample(Math.min(n - 1, i + 1));
      const color = PHASES[a.phase].color;
      fillQuad([
        [a.x, a.y, -a.z * 0.92],
        [b.x, b.y, -b.z * 0.92],
        [b.x, b.y, -0.02],
        [a.x, a.y, -0.02]
      ], basis, (depth) => hexAlpha(color, 0.34 * shade(depth)));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const px = (-dy / len) * width;
      const py = (dx / len) * width;
      fillQuad([
        [a.x + px, a.y + py, -a.z * 0.92],
        [b.x + px, b.y + py, -b.z * 0.92],
        [b.x - px, b.y - py, -b.z * 0.92],
        [a.x - px, a.y - py, -a.z * 0.92]
      ], basis, (depth) => hexAlpha("#f4fbff", 0.28 * shade(depth)));
    }
    ctx.restore();
  }

  function clipToDisc(a, b, c, r) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const fx = a[0] - c[0];
    const fy = a[1] - c[1];
    const A = dx * dx + dy * dy;
    const B = 2 * (fx * dx + fy * dy);
    const C = fx * fx + fy * fy - r * r;
    if (A < 1e-8) return C <= 0 ? [a, b] : null;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    const sd = Math.sqrt(disc);
    let t0 = (-B - sd) / (2 * A);
    let t1 = (-B + sd) / (2 * A);
    t0 = Math.max(0, t0);
    t1 = Math.min(1, t1);
    if (t0 > t1) return null;
    return [
      [a[0] + dx * t0, a[1] + dy * t0],
      [a[0] + dx * t1, a[1] + dy * t1]
    ];
  }

  function drawWalls(basis) {
    const n = count();
    const last = Math.min(n - 2, Math.floor(state.cursor));
    const segs = [];
    for (let i = 0; i <= last; i += 1) {
      const a = sample(i);
      const b = sample(i + 1);
      const pa = project([a.x, a.y, a.z], basis);
      const pb = project([b.x, b.y, b.z], basis);
      if (!pa || !pb) continue;
      segs.push({ i, depth: (pa.depth + pb.depth) * 0.5 });
    }
    segs.sort((p, q) => q.depth - p.depth);
    segs.forEach((seg) => {
      const a = sample(seg.i);
      const b = sample(seg.i + 1);
      const color = PHASES[a.phase].color;
      const top = project([(a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5], basis);
      const bot = project([(a.x + b.x) * 0.5, (a.y + b.y) * 0.5, 0.05], basis);
      fillQuad([
        [a.x, a.y, a.z],
        [b.x, b.y, b.z],
        [b.x, b.y, 0.05],
        [a.x, a.y, 0.05]
      ], basis, (depth) => {
        if (!top || !bot) return hexAlpha(color, 0.16 * shade(depth));
        const g = ctx.createLinearGradient(top.x, top.y, bot.x, bot.y);
        const fade = shade(depth);
        g.addColorStop(0, hexAlpha(color, 0.4 * fade));
        g.addColorStop(0.4, hexAlpha(color, 0.14 * fade));
        g.addColorStop(1, hexAlpha(color, 0.015 * fade));
        return g;
      });
    });
  }

  function drawRibbon(basis) {
    const n = count();
    const last = Math.min(n - 2, Math.floor(state.cursor));
    const width = Math.max(0.7, craftSize() * 0.16);
    for (let i = 0; i <= last; i += 1) {
      const a = sample(i);
      const b = sample(i + 1);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const px = (-dy / len) * width;
      const py = (dx / len) * width;
      const color = PHASES[a.phase].color;
      fillQuad([
        [a.x + px, a.y + py, a.z],
        [b.x + px, b.y + py, b.z],
        [b.x - px, b.y - py, b.z],
        [a.x - px, a.y - py, a.z]
      ], basis, (depth) => hexAlpha(color, 0.62 * shade(depth)));
    }
  }

  function drawUavPath(basis) {
    const n = count();
    const cursor = state.cursor;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = 16;
    for (let i = Math.max(0, Math.floor(cursor) - 14); i < cursor - 1; i += 1) {
      const a = sample(i);
      const b = sample(i + 1);
      ctx.strokeStyle = hexAlpha(PHASES[a.phase].color, 0.2);
      strokeWorld([a.x, a.y, a.z], [b.x, b.y, b.z], basis);
    }
    ctx.lineWidth = 7;
    for (let i = 0; i < n - 1; i += 1) {
      if (i >= cursor) break;
      const a = sample(i);
      const b = sample(i + 1);
      const recent = cursor - i < 8;
      ctx.strokeStyle = hexAlpha(PHASES[a.phase].color, recent ? 0.55 : 0.28);
      strokeWorld([a.x, a.y, a.z], [b.x, b.y, b.z], basis);
    }
    ctx.lineWidth = 2.6;
    for (let i = 0; i < n - 1; i += 1) {
      const a = sample(i);
      const b = sample(i + 1);
      if (i < cursor) {
        ctx.strokeStyle = "#f7fbff";
        strokeWorld([a.x, a.y, a.z], [b.x, b.y, b.z], basis, 0.92);
      }
    }
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 8]);
    ctx.lineDashOffset = -state.ms * 0.03;
    for (let i = Math.floor(cursor); i < n - 1; i += 1) {
      const a = sample(i);
      const b = sample(i + 1);
      ctx.strokeStyle = hexAlpha(PHASES[a.phase].color, 0.75);
      strokeWorld([a.x, a.y, a.z], [b.x, b.y, b.z], basis);
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  function drawTargetPath(basis) {
    const n = count();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 7]);
    ctx.lineDashOffset = -state.ms * 0.02;
    for (let i = 0; i < n - 1; i += 1) {
      const a = sample(i);
      const b = sample(i + 1);
      const past = i < state.cursor;
      ctx.strokeStyle = hexAlpha("#ff5d8f", past ? 0.95 : 0.4);
      strokeWorld([a.tx, a.ty, 0.08], [b.tx, b.ty, 0.08], basis);
    }
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  function drawFootprint(basis) {
    const s = currentSample();
    const frame = camFrame(s.yaw, s.pitch);
    if (frame.f[2] >= -0.05) return;
    const hits = [-1, 1].flatMap((sy) => [-1, 1].map((sx) => {
      const dir = [
        frame.f[0] + frame.r[0] * Math.tan((state.ep.hfov * Math.PI) / 360) * sx + frame.u[0] * Math.tan((state.ep.vfov * Math.PI) / 360) * sy,
        frame.f[1] + frame.r[1] * Math.tan((state.ep.hfov * Math.PI) / 360) * sx + frame.u[1] * Math.tan((state.ep.vfov * Math.PI) / 360) * sy,
        frame.f[2] + frame.r[2] * Math.tan((state.ep.hfov * Math.PI) / 360) * sx + frame.u[2] * Math.tan((state.ep.vfov * Math.PI) / 360) * sy
      ];
      if (dir[2] >= -0.04) return null;
      const t = (0.08 - s.z) / dir[2];
      if (t < 1 || t > 90) return null;
      return [s.x + dir[0] * t, s.y + dir[1] * t, 0.08];
    }));
    if (hits.some((hit) => !hit)) return;
    const color = PHASES[s.phase].color;
    fillQuad([hits[0], hits[1], hits[3], hits[2]], basis, (depth) => hexAlpha(color, 0.22 * shade(depth)));
    ctx.strokeStyle = hexAlpha(color, 0.85);
    ctx.lineWidth = 1.3;
    strokeWorld(hits[0], hits[1], basis);
    strokeWorld(hits[1], hits[3], basis);
    strokeWorld(hits[3], hits[2], basis);
    strokeWorld(hits[2], hits[0], basis);
  }

  function drawShadows(basis) {
    const s = currentSample();
    const pulse = 0.82 + 0.18 * Math.sin(state.ms * 0.004);
    const color = PHASES[s.phase].color;
    fillDisc([s.x, s.y, 0.05], craftSize() * 2.6 * pulse, basis, hexAlpha(color, 0.28));
    fillDisc([s.x, s.y, 0.06], craftSize() * 0.95 * pulse, basis, "rgba(0,0,0,0.38)");
    fillDisc([s.tx, s.ty, 0.05], 2.4, basis, "rgba(255, 70, 120, 0.2)");
    fillDisc([s.tx, s.ty, 0.06], 1.15, basis, "rgba(40, 0, 16, 0.35)");
  }

  function drawFrustum(basis) {
    const s = currentSample();
    const frame = camFrame(s.yaw, s.pitch);
    const length = 15;
    const hh = Math.tan((state.ep.hfov * Math.PI) / 360) * length;
    const vv = Math.tan((state.ep.vfov * Math.PI) / 360) * length;
    const apex = [s.x, s.y, s.z];
    const corners = [-1, 1].flatMap((sy) => [-1, 1].map((sx) => {
      return [
        apex[0] + frame.f[0] * length + frame.r[0] * hh * sx + frame.u[0] * vv * sy,
        apex[1] + frame.f[1] * length + frame.r[1] * hh * sx + frame.u[1] * vv * sy,
        apex[2] + frame.f[2] * length + frame.r[2] * hh * sx + frame.u[2] * vv * sy
      ];
    }));
    const color = PHASES[s.phase].color;
    ctx.strokeStyle = hexAlpha(color, 0.7);
    ctx.lineWidth = 1.35;
    corners.forEach((corner) => strokeWorld(apex, corner, basis));
    strokeWorld(corners[0], corners[1], basis);
    strokeWorld(corners[1], corners[3], basis);
    strokeWorld(corners[3], corners[2], basis);
    strokeWorld(corners[2], corners[0], basis);
  }

  function drawCraft(basis) {
    const s = currentSample();
    const yaw = (s.yaw * Math.PI) / 180;
    const arm = craftSize() * 1.05;
    const hub = [s.x, s.y, s.z];
    const F = [Math.cos(yaw), Math.sin(yaw), 0];
    const R = [-Math.sin(yaw), Math.cos(yaw), 0];
    const U = [0, 0, 1];
    const a = arm * 0.52;
    const duct = arm * 0.46;
    const motors = [
      [a, a],
      [a, -a],
      [-a, a],
      [-a, -a]
    ].map((pair) => add3(add3(hub, scale3(F, pair[0])), scale3(R, pair[1])));
    const bar = (along, reach, width) => {
      const side = scale3(cross(along, U), width);
      const end = scale3(along, reach);
      fillQuad([
        add3(add3(hub, end), side),
        add3(add3(hub, scale3(end, -1)), side),
        add3(add3(hub, scale3(end, -1)), scale3(side, -1)),
        add3(add3(hub, end), scale3(side, -1))
      ], basis, () => "#1a120e");
    };
    bar(F, a * 1.15, arm * 0.07);
    bar(R, a * 1.15, arm * 0.08);
    [-1, 1].forEach((side) => {
      const foot = add3(hub, add3(scale3(R, a * 0.35 * side), scale3(U, -arm * 0.02)));
      ctx.strokeStyle = "#120e0c";
      ctx.lineWidth = 2;
      strokeWorld(foot, add3(foot, scale3(U, -arm * 0.16)), basis, 1);
    });
    motors.forEach((center, index) => {
      const raised = add3(center, scale3(U, arm * 0.03));
      fillDisc(raised, duct * 0.78, basis, "rgba(236, 232, 226, 0.9)", F, R);
      const spin = state.ms * 0.028 + index;
      const along = normalize(add3(scale3(R, Math.cos(spin)), scale3(F, Math.sin(spin))));
      paintBlade(raised, along, U, duct * 0.7, arm * 0.035, "rgba(255,255,255,0.55)", "rgba(255,255,255,0.2)", basis);
      paintBlade(raised, scale3(along, -1), U, duct * 0.7, arm * 0.035, "rgba(255,255,255,0.55)", "rgba(255,255,255,0.2)", basis);
      const mid = project(raised, basis);
      const edge = project(add3(raised, scale3(R, duct)), basis);
      const px = mid && edge ? Math.hypot(edge.x - mid.x, edge.y - mid.y) : 20;
      strokeRing(raised, duct, basis, "#1c140f", Math.max(6, px * 0.34), F, R);
      strokeRing(raised, duct * 0.82, basis, "#4a2c1c", Math.max(2, px * 0.08), F, R);
      fillDisc(raised, duct * 0.16, basis, "#e10600", F, R);
      fillDisc(raised, duct * 0.07, basis, "#7a120c", F, R);
    });
  }

  function strokeRing(center, radius, basis, color, width, axisA, axisB) {
    const ring = discPoints(center, radius, axisA, axisB);
    const proj = ring.map((point) => project(point, basis));
    if (proj.some((point) => !point)) return;
    ctx.beginPath();
    proj.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  function paintBlade(center, along, up, reach, width, inner, tipColor, basis) {
    const side = normalize(cross(along, up));
    const root = add3(center, scale3(along, reach * 0.08));
    const mid = add3(center, scale3(along, reach * 0.62));
    const tip = add3(center, scale3(along, reach));
    const quad = (a, b, wa, wb) => [
      add3(a, scale3(side, wa)),
      add3(b, scale3(side, wb)),
      add3(b, scale3(side, -wb)),
      add3(a, scale3(side, -wa))
    ];
    fillQuad(quad(root, mid, width * 0.45, width), basis, () => inner);
    fillQuad(quad(mid, tip, width, width * 0.55), basis, () => tipColor);
  }

  function paintBody(hub, F, R, U, bl, bw, bh, basis, top, sideColor, bottom) {
    const box = [-1, 1].flatMap((fz) => [-1, 1].flatMap((ry) => [-1, 1].map((ux) => {
      return add3(hub, add3(add3(scale3(F, bl * fz), scale3(R, bw * ry)), scale3(U, bh * ux)));
    })));
    const faces = [
      { idx: [1, 3, 7, 5], n: U, color: top },
      { idx: [0, 4, 6, 2], n: scale3(U, -1), color: bottom || "#8e98a1" },
      { idx: [4, 5, 7, 6], n: F, color: sideColor },
      { idx: [0, 2, 3, 1], n: scale3(F, -1), color: sideColor },
      { idx: [2, 6, 7, 3], n: R, color: sideColor },
      { idx: [0, 1, 5, 4], n: scale3(R, -1), color: sideColor }
    ];
    const light = normalize([-0.35, -0.2, 0.9]);
    const painted = faces.map((face) => {
      const proj = face.idx.map((index) => project(box[index], basis));
      if (proj.some((point) => !point)) return null;
      const depth = proj.reduce((sum, point) => sum + point.depth, 0) / proj.length;
      return { proj, depth, n: face.n, color: face.color };
    }).filter(Boolean);
    painted.sort((a, b) => b.depth - a.depth);
    painted.forEach((face) => {
      const nd = Math.max(0, dot(normalize(face.n), light));
      ctx.beginPath();
      face.proj.forEach((point, i) => (i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
      ctx.closePath();
      ctx.fillStyle = mixHex(face.color, nd * 0.28);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.stroke();
    });
  }

  function drawSparks(basis) {
    const s = currentSample();
    if (!state.sparks) state.sparks = [];
    const prev = sample(Math.max(0, Math.floor(state.cursor) - 1));
    const vel = [s.x - prev.x, s.y - prev.y, s.z - prev.z];
    const speed = Math.hypot(vel[0], vel[1], vel[2]);
    const back = speed > 0.02 ? normalize([-vel[0], -vel[1], -vel[2]]) : [0, 0, 0];
    const color = PHASES[s.phase].color;
    const spawn = speed > 0.04 ? (state.playing ? 3 : 1) : 0;
    for (let i = 0; i < spawn; i += 1) {
      state.sparks.push({
        p: [s.x, s.y, s.z],
        v: [
          back[0] * (2.2 + speed * 4) + (Math.random() - 0.5) * 1.4,
          back[1] * (2.2 + speed * 4) + (Math.random() - 0.5) * 1.4,
          back[2] * (1.4 + speed * 2) - 0.35
        ],
        life: 1,
        color: color
      });
    }
    state.sparks.forEach((spark) => {
      spark.p[0] += spark.v[0] * 0.016;
      spark.p[1] += spark.v[1] * 0.016;
      spark.p[2] += spark.v[2] * 0.016;
      spark.life -= state.playing ? 0.02 : 0.012;
    });
    if (state.sparks.length > 110) state.sparks.splice(0, state.sparks.length - 110);
    state.sparks = state.sparks.filter((spark) => spark.life > 0);
    state.sparks.forEach((spark) => {
      const p = project(spark.p, basis);
      if (!p) return;
      ctx.globalAlpha = spark.life * shade(p.depth);
      ctx.fillStyle = spark.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2 + (1 - spark.life) * 2.4, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawTarget(basis) {
    const s = currentSample();
    const beam = 0.28;
    [[0, beam], [beam, 0]].forEach((axis) => {
      fillQuad([
        [s.tx - axis[0], s.ty - axis[1], s.tz + 1.4],
        [s.tx + axis[0], s.ty + axis[1], s.tz + 1.4],
        [s.tx + axis[0], s.ty + axis[1], 0.08],
        [s.tx - axis[0], s.ty - axis[1], 0.08]
      ], basis, (depth) => hexAlpha("#ff5d8f", 0.28 * shade(depth)));
    });
    for (let k = 0; k < 3; k += 1) {
      const u = ((state.ms * 0.00045) + k / 3) % 1;
      ctx.save();
      ctx.globalAlpha = (1 - u) * 0.85;
      ctx.strokeStyle = "#ffd0e0";
      ctx.lineWidth = 1.4;
      strokeDisc([s.tx, s.ty, 0.1], 0.45 + u * 3.4, basis);
      ctx.restore();
    }
    const breathe = 1.3 + 0.55 * (0.5 + 0.5 * Math.sin(state.ms * 0.005));
    ctx.strokeStyle = hexAlpha("#ff5d8f", 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(state.ms * 0.005)));
    ctx.lineWidth = 1.5;
    strokeDisc([s.tx, s.ty, 0.08], breathe, basis);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.2;
    strokeWorld([s.tx, s.ty, s.tz], [s.tx, s.ty, 0.08], basis);
    const tp = project([s.tx, s.ty, s.tz + 0.6], basis);
    if (!tp) return;
    const halo = ctx.createRadialGradient(tp.x, tp.y, 1, tp.x, tp.y, 18);
    halo.addColorStop(0, "rgba(255, 93, 143, 0.55)");
    halo.addColorStop(1, "rgba(255, 93, 143, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(tp.x, tp.y, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(tp.x, tp.y - 8);
    ctx.lineTo(tp.x + 7, tp.y);
    ctx.lineTo(tp.x, tp.y + 8);
    ctx.lineTo(tp.x - 7, tp.y);
    ctx.closePath();
    ctx.fillStyle = "#ff5d8f";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    labelAt(tp.x + 18, tp.y + 16, "target");
  }

  function labelAt(x, y, text) {
    ctx.font = "600 13px Palatino, 'Palatino Linotype', serif";
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(8, 16, 24, 0.75)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = "#f4f7f8";
    ctx.fillText(text, x, y);
  }

  function drawGizmo(basis) {
    const origin = [58, state.h - 58];
    const len = 30;
    const dirs = [
      { d: [1, 0, 0], color: "#ef7d7d", name: "X" },
      { d: [0, 1, 0], color: "#6dce8c", name: "Y" },
      { d: [0, 0, 1], color: "#79beff", name: "Z" }
    ];
    ctx.lineWidth = 2;
    dirs.forEach((axis) => {
      const sx = axis.d[0] * basis.x[0] + axis.d[1] * basis.x[1] + axis.d[2] * basis.x[2];
      const sy = axis.d[0] * basis.y[0] + axis.d[1] * basis.y[1] + axis.d[2] * basis.y[2];
      const nrm = Math.hypot(sx, sy) || 1;
      const ex = origin[0] + (sx / nrm) * len;
      const ey = origin[1] - (sy / nrm) * len;
      ctx.strokeStyle = axis.color;
      ctx.beginPath();
      ctx.moveTo(origin[0], origin[1]);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.fillStyle = axis.color;
      ctx.font = "600 12px Palatino, 'Palatino Linotype', serif";
      ctx.textAlign = "left";
      ctx.fillText(axis.name, ex + 4, ey + 4);
    });
  }

  function strokeWorld(a, b, basis, alpha) {
    const pa = project(a, basis);
    const pb = project(b, basis);
    if (!pa || !pb) return;
    ctx.save();
    ctx.globalAlpha *= shade((pa.depth + pb.depth) * 0.5) * (alpha == null ? 1 : alpha);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.restore();
  }

  function fillQuad(pts, basis, styleOf) {
    const proj = pts.map((p) => project(p, basis));
    if (proj.some((p) => !p)) return;
    const depth = proj.reduce((sum, p) => sum + p.depth, 0) / proj.length;
    ctx.beginPath();
    proj.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = styleOf(depth);
    ctx.fill();
  }

  function fillDisc(center, radius, basis, color, axisA, axisB) {
    const ring = discPoints(center, radius, axisA, axisB);
    const proj = ring.map((p) => project(p, basis));
    if (proj.some((p) => !p)) return;
    const depth = proj.reduce((sum, p) => sum + p.depth, 0) / proj.length;
    ctx.beginPath();
    proj.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.save();
    ctx.globalAlpha *= shade(depth);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  function strokeDisc(center, radius, basis) {
    const ring = discPoints(center, radius);
    ctx.beginPath();
    let moved = false;
    ring.forEach((p) => {
      const q = project(p, basis);
      if (!q) return;
      if (!moved) { ctx.moveTo(q.x, q.y); moved = true; }
      else ctx.lineTo(q.x, q.y);
    });
    if (moved) ctx.closePath();
    ctx.stroke();
  }

  function discPoints(center, radius, axisA, axisB) {
    const A = axisA || [1, 0, 0];
    const B = axisB || [0, 1, 0];
    const pts = [];
    for (let i = 0; i < 20; i += 1) {
      const t = (i / 20) * Math.PI * 2;
      pts.push(add3(center, add3(scale3(A, Math.cos(t) * radius), scale3(B, Math.sin(t) * radius))));
    }
    return pts;
  }

  function mixHex(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const lift = (c) => Math.round(c + (255 - c) * clamp(k, 0, 1));
    return "rgb(" + lift(r) + "," + lift(g) + "," + lift(b) + ")";
  }

  function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  function scale3(v, k) {
    return [v[0] * k, v[1] * k, v[2] * k];
  }

  function add3(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  }

  function normalize(v) {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  function hexAlpha(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  function renderChrome() {
    const ep = state.ep;
    const s = currentSample();
    if (state.chromeEpisode !== ep) {
      state.chromeEpisode = ep;
      const bar = document.getElementById("traj-phasebar");
      let html = "";
      let run = 1;
      for (let i = 1; i <= ep.phase.length; i += 1) {
        if (i < ep.phase.length && ep.phase.charAt(i) === ep.phase.charAt(i - 1)) {
          run += 1;
        } else {
          const key = ep.phase.charAt(i - 1);
          html += '<i style="width:' + (run / ep.phase.length) * 100 + "%;background:" + PHASES[key].color + '"></i>';
          run = 1;
        }
      }
      bar.innerHTML = html;
    }

    const slider = document.getElementById("traj-time");
    slider.max = String(count() - 1);
    slider.value = String(Math.round(state.cursor));
    const play = document.getElementById("traj-play");
    play.textContent = state.playing ? "Pause" : "Play";

    const dist = Math.hypot(s.tx - s.x, s.ty - s.y, s.tz - s.z);
    const origin = sample(0);
    const clock = document.getElementById("traj-clock");
    clock.textContent = s.time.toFixed(1) + " / " + ((count() - 1) * ep.dt).toFixed(1) + " s";
    const cap = document.getElementById("traj-frame-caption");
    if (cap) cap.hidden = true;
    const values = [
      s.z.toFixed(1) + " m",
      wrap(s.yaw).toFixed(0) + "°",
      s.pitch.toFixed(0) + "°",
      dist.toFixed(1) + " m",
      "ΔX " + signed(s.x - origin.x) + " m, ΔY " + signed(s.y - origin.y) + " m"
    ];
    if (!state.readoutNodes) {
      const readout = document.getElementById("traj-readout");
      state.readoutNodes = ["Altitude", "Yaw", "Pitch", "Range", "From start"].map((name) => {
        const item = document.createElement("span");
        const label = document.createElement("em");
        label.textContent = name;
        const value = document.createTextNode("");
        item.append(label, value);
        readout.appendChild(item);
        return value;
      });
    }
    state.readoutNodes.forEach((node, i) => {
      if (node.nodeValue !== values[i]) node.nodeValue = values[i];
    });
  }

  function signed(value) {
    const text = value.toFixed(1);
    return value >= 0 ? "+" + text : text;
  }

  function setIndex(index) {
    const n = count();
    if (!n) return;
    state.cursor = Math.max(0, Math.min(n - 1, index));
    state.index = Math.round(state.cursor);
    if (sharedVideo) sharedVideo.currentTime = desiredTime();
    renderChrome();
    draw();
    if (!state.playing) syncVideo();
  }

  // Visibility suspends work without changing the visitor's play/pause choice.
  function setVisible(visible) {
    visible = Boolean(visible);
    if (state.visible === visible) return;
    state.visible = visible;
    const video = media();
    clearTimeout(state.playTimer);
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    if (!visible) {
      if (video && !sharedVideo) video.pause();
      state.hiddenAt = performance.now();
      return;
    }
    if (state.intro && state.hiddenAt) state.intro.t0 += performance.now() - state.hiddenAt;
    state.hiddenAt = null;
    if (!state.ep) return;
    if (sharedVideo) { adoptVideoClock(); state.playing = !sharedVideo.paused && !sharedVideo.ended; renderChrome(); }
    resize();
    syncVideo();
    if (state.playing) state.playTimer = setTimeout(advanceFrame, 80);
    ensurePump();
  }

  function pump(timestamp) {
    const stage = document.getElementById("traj-stage");
    if (!state.visible || !state.ep || !stage || stage.hidden) {
      state.raf = 0;
      return;
    }
    // One drawing loop, capped at 30 fps. ResizeObserver handles layout changes.
    if (timestamp - state.lastTick >= 1000 / 30 - 1) {
      state.lastTick = timestamp;
      easeIntro();
      draw();
    }
    if (state.playing || state.intro) state.raf = requestAnimationFrame(pump);
    else state.raf = 0;
  }

  function ensurePump() {
    if (!state.visible || state.raf) return;
    state.raf = requestAnimationFrame(pump);
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;
    const c = canvas();
    const video = media();
    if (video && !sharedVideo) {
      video.addEventListener("loadedmetadata", () => syncVideo());
      video.addEventListener("loadeddata", () => { draw(); ensurePump(); });
      video.addEventListener("seeked", finishSeek);
      video.addEventListener("timeupdate", grabVideoFrame);
    }
    const stopPlayback = () => {
      state.playing = false;
      clearTimeout(state.playTimer);
      const video = media();
      if (video) video.pause();
      if (sharedVideo) notifyPlayback(false);
    };
    document.getElementById("traj-time").addEventListener("input", (event) => {
      stopPlayback();
      setIndex(Number(event.target.value));
    });
    document.getElementById("traj-phasebar").addEventListener("click", (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const u = (event.clientX - rect.left) / rect.width;
      stopPlayback();
      setIndex(Math.round(u * (count() - 1)));
    });
    document.getElementById("traj-play").addEventListener("click", () => {
      const video = media();
      if (sharedVideo) {
        const playing = video.paused || video.ended;
        if (video.ended) video.currentTime = 0;
        state.playing = playing;
        if (playing) video.play().catch(() => {});
        else video.pause();
        notifyPlayback(playing);
        renderChrome();
        ensurePump();
        return;
      }
      if (!state.playing && state.cursor >= count() - 1) {
        state.cursor = 0;
        state.index = 0;
        if (video) video.pause();
      }
      state.playing = !state.playing;
      clearTimeout(state.playTimer);
      if (video && !state.playing) video.pause();
      if (state.playing && state.visible) {
        syncVideo();
        state.stepStarted = performance.now();
        state.playTimer = setTimeout(advanceFrame, (state.ep ? state.ep.dt : 0.2) * 1000);
      }
      renderChrome();
      ensurePump();
    });
    document.getElementById("traj-reset").addEventListener("click", () => {
      if (!state.home) return;
      state.look = { ...state.home.look };
      state.radius = state.home.radius;
      state.az = state.home.az;
      state.el = state.home.el;
      draw();
    });
    window.addEventListener("resize", resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(c.parentElement);
  }

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  function clampRadius(value) {
    return clamp(value, 12, 900);
  }

  window.TrajectoryView = { boot, show, resize, setVisible, attachVideo };
})();
