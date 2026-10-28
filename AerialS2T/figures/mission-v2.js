/* The cover, flight replay and spatial view share the same HTMLVideoElement. */
(function () {
  const PHASES = {
    T: ["TAKEOFF", "#49b6ff"], S: ["SEARCH", "#ffc44d"], A: ["ACQUIRE", "#ff8a3d"],
    K: ["TRACK", "#6ee8d1"], L: ["LOST", "#d09bff"], R: ["REACQUIRE", "#8eb6ff"], O: ["OTHER", "#b7c0c7"]
  };
  const el = (id) => document.getElementById(id);
  const text = (id, value) => { const node = el(id); if (node && node.textContent !== value) node.textContent = value; };
  const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
  const path = (points) => points.map((p, i) => (i ? "L" : "M") + p.x.toFixed(2) + "," + p.y.toFixed(2)).join(" ");
  const clock = (seconds) => String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + (seconds % 60).toFixed(1).padStart(4, "0");

  function cameraCorners(pose, ep) {
    const yaw = pose.yaw*Math.PI/180, pitch = pose.pitch*Math.PI/180;
    const forward = [Math.cos(pitch)*Math.cos(yaw),Math.cos(pitch)*Math.sin(yaw),Math.sin(pitch)];
    const right = [-Math.sin(yaw),Math.cos(yaw),0];
    const up = [-Math.sin(pitch)*Math.cos(yaw),-Math.sin(pitch)*Math.sin(yaw),Math.cos(pitch)];
    const reach = 14, hh = Math.tan(ep.hfov*Math.PI/360)*reach, vv = Math.tan(ep.vfov*Math.PI/360)*reach;
    return [[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sy]) => ({
      x:pose.x+forward[0]*reach+right[0]*hh*sx+up[0]*vv*sy,
      y:pose.y+forward[1]*reach+right[1]*hh*sx+up[1]*vv*sy,
      z:pose.z+forward[2]*reach+right[2]*hh*sx+up[2]*vv*sy
    }));
  }

  function start(scenes) {
    const clips = [...document.querySelectorAll(".hero-video video")];
    const heroDots = [...document.querySelectorAll(".hero .carousel-dot")];
    const sceneDots = [...document.querySelectorAll(".scene-dot")];
    const toggles = [...document.querySelectorAll(".carousel-toggle, .scene-toggle")];
    const motionOK = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    const connection = navigator.connection;
    const conserveData = Boolean(connection?.saveData || ["slow-2g", "2g"].includes(connection?.effectiveType));
    const compactVideo = matchMedia("(max-width: 700px)").matches || conserveData;
    let current = 0, automatic = motionOK, playbackRunning = motionOK && !conserveData;
    let mediaAllowed = false, startupQueued = false, playbackFailed = false, buffering = false;
    let viewerLoading = null;
    let heroVisible = false, trajectoryVisible = false, request = 0, pending = null;
    let pack = null, viewerBooted = false, viewerScene = -1, warmTimer = 0;
    let hudRAF = 0, replayRAF = 0, lastFrame = 0, lastReadout = 0, miniRoute = null, spatialRoute = null;
    let azimuth = -0.65, tilt = 0.68, orbitDrag = null;
    const active = () => clips[current];
    const visible = () => !document.hidden && (heroVisible || trajectoryVisible);
    const episode = () => pack?.episodes[String(scenes[current].ep)];

    function sample(frame) {
      const ep = episode(), max = ep.phase.length - 1;
      const f = clamp(frame, 0, max), a = Math.floor(f), b = Math.min(max, a + 1), u = f - a;
      const mix = (values, stride, offset) => values[a * stride + offset] * (1 - u) + values[b * stride + offset] * u;
      return { x: mix(ep.uav, 5, 0), y: mix(ep.uav, 5, 1), z: mix(ep.uav, 5, 2), yaw: ep.uav[a*5+3] + (((ep.uav[b*5+3]-ep.uav[a*5+3]+540)%360)-180)*u, pitch: mix(ep.uav, 5, 4),
        tx: mix(ep.target, 3, 0), ty: mix(ep.target, 3, 1), tz: mix(ep.target, 3, 2), frame: f };
    }
    function mediaStatus() {
      const video = active(), status = el("mission-load-status"), button = el("mission-start"), note = el("mission-playback-note");
      if (!visible()) { status.hidden = true; button.hidden = true; note.hidden = false; return; }
      if (video.error || playbackFailed) {
        status.hidden = false; status.textContent = "Video could not start";
        button.textContent = "Retry flight"; button.hidden = false; note.hidden = true;
      } else if (!playbackRunning) {
        status.hidden = true; button.textContent = "Play flight"; button.hidden = false; note.hidden = true;
      } else if (!mediaAllowed || buffering || video.readyState < 2 || video.paused || video.seeking) {
        status.textContent = buffering ? "Buffering flight…" : mediaAllowed ? "Loading flight…" : "Preparing replay…";
        status.hidden = false; button.hidden = true; note.hidden = true;
      } else {
        status.hidden = true; button.hidden = true; note.hidden = false;
      }
    }
    function playVideo(video) {
      return video.play().catch((error) => {
        if ((video !== active() && video !== clips[pending]) || !visible() || error.name === "AbortError") return;
        playbackRunning = false;
        playbackFailed = error.name !== "NotAllowedError";
        mediaStatus();
      });
    }
    function loadViewer() {
      if (window.TrajectoryView) return Promise.resolve();
      if (viewerLoading) return viewerLoading;
      viewerLoading = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "figures/trajectory.js?v=21";
        script.onload = () => window.TrajectoryView ? resolve() : reject(new Error("Replay renderer unavailable"));
        script.onerror = () => { script.remove(); reject(new Error("Replay renderer could not be loaded")); };
        document.head.appendChild(script);
      }).catch((error) => { viewerLoading = null; throw error; });
      return viewerLoading;
    }
    function prepare(index) {
      const video = clips[index];
      video.preload = "auto";
      video.loop = !automatic;
      if (!video.getAttribute("src")) {
        video.src = compactVideo && video.dataset.mobileSrc ? video.dataset.mobileSrc : video.dataset.src;
        video.load();
      }
      return video;
    }
    function cleanup(keepNext = false) {
      clips.forEach((video, index) => {
        if (index === current || index === pending || (keepNext && index === (current + 1) % clips.length)) return;
        video.pause();
        if (video.getAttribute("src")) { video.removeAttribute("src"); video.classList.remove("is-ready"); video.preload = "none"; video.load(); }
      });
    }
    function warmNext() {
      clearTimeout(warmTimer);
      const video = active();
      if (!automatic || !visible() || !playbackRunning || !mediaAllowed || buffering || conserveData) return;
      const duration = Number.isFinite(video.duration) ? video.duration : scenes[current].seconds;
      warmTimer = setTimeout(() => {
        if (automatic && playbackRunning && visible()) prepare((current + 1) % clips.length);
      }, Math.max(0, (duration - video.currentTime - 5) * 1000));
    }
    function updateControls() {
      toggles.forEach((toggle) => {
        toggle.textContent = automatic ? "Ⅱ" : "▶";
        toggle.setAttribute("aria-label", automatic ? "Pause automatic switching" : "Resume automatic switching");
        toggle.setAttribute("aria-pressed", String(!automatic));
      });
      clips.forEach((video) => { video.loop = !automatic; });
    }
    function setAutomatic(enabled) {
      automatic = enabled;
      updateControls();
      if (!enabled) {
        clearTimeout(warmTimer);
        if (pending !== null) { ++request; const cancelled = pending; pending = null; clips[cancelled].pause(); }
        cleanup();
        if (active().ended && playbackRunning && visible()) { active().currentTime = 0; playVideo(active()); }
      }
      else if (active().ended) { showSlide(current + 1); return; }
      warmNext();
    }

    // A fixed projection is built once per episode/orbit, not on every frame.
    function buildRoute(svg, spatial) {
      const ep = episode();
      if (!ep) return null;
      const aircraft = [], target = [];
      for (let i = 0; i < ep.phase.length; i++) {
        aircraft.push({ x: ep.uav[i * 5], y: ep.uav[i * 5 + 1], z: ep.uav[i * 5 + 2], yaw:ep.uav[i * 5 + 3], pitch:ep.uav[i * 5 + 4] });
        target.push({ x: ep.target[i * 3], y: ep.target[i * 3 + 1], z: ep.target[i * 3 + 2] });
      }
      const points = aircraft.concat(target);
      const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
      const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      let xx = 0, yy = 0, xy = 0;
      points.forEach((p) => { const x = p.x - cx, y = p.y - cy; xx += x*x; yy += y*y; xy += x*y; });
      const mapAngle = Math.atan2(2*xy, xx-yy) / 2;
      const raw = (p) => {
        const x = p.x - cx, y = p.y - cy;
        return spatial ? { x: x * Math.cos(azimuth) - y * Math.sin(azimuth),
          y: (x * Math.sin(azimuth) + y * Math.cos(azimuth)) * Math.sin(tilt) - p.z * Math.cos(tilt) }
          : { x:x*Math.cos(mapAngle)+y*Math.sin(mapAngle), y:-x*Math.sin(mapAngle)+y*Math.cos(mapAngle) };
      };
      const extent = points.map(raw);
      if (spatial) aircraft.forEach(pose => cameraCorners(pose,ep).forEach(corner => extent.push(raw(corner))));
      const x0 = Math.min(...extent.map(p => p.x)), x1 = Math.max(...extent.map(p => p.x));
      const y0 = Math.min(...extent.map(p => p.y)), y1 = Math.max(...extent.map(p => p.y));
      const width = spatial ? 400 : 240, height = spatial ? 360 : 100;
      const scale = Math.min((width - (spatial ? 72 : 26)) / Math.max(1, x1 - x0), (height - (spatial ? 100 : 22)) / Math.max(1, y1 - y0));
      const project = (p) => { const q = raw(p); return { x: width / 2 + (q.x - (x0 + x1) / 2) * scale, y: height / 2 + (q.y - (y0 + y1) / 2) * scale }; };
      const ap = aircraft.map(project), tp = target.map(project);
      let grid = "";
      if (spatial) {
        for (let i = 0; i <= 6; i++) {
          const x = minX + (maxX - minX) * i / 6, y = minY + (maxY - minY) * i / 6;
          grid += path([project({x, y:minY, z:0}), project({x, y:maxY, z:0})]) + " ";
          grid += path([project({x:minX, y, z:0}), project({x:maxX, y, z:0})]) + " ";
        }
      }
      svg.innerHTML = '<path d="' + grid + '" stroke="#739db4" stroke-opacity=".16" stroke-width=".65" fill="none"/>' +
        '<path d="' + path(tp) + '" stroke="#fa6b98" stroke-opacity=".33" stroke-width="1" stroke-dasharray="3 4" fill="none"/>' +
        '<path d="' + path(ap) + '" stroke="#71d8da" stroke-opacity=".18" stroke-width="' + (spatial ? 2 : 1.3) + '" fill="none"/>' +
        '<path class="route-progress" d="' + path(ap) + '" pathLength="100" stroke="#74e4d6" stroke-width="' + (spatial ? 2.2 : 1.5) + '" stroke-linecap="round" fill="none" stroke-dasharray="100" stroke-dashoffset="100"/>' +
        (spatial ? '<path class="route-frustum" d="" stroke="#71e1cd" stroke-opacity=".38" stroke-width=".8" fill="#71e1cd0d"/><path class="route-sightline" d="" stroke="#fa6b98" stroke-opacity=".4" stroke-dasharray="3 4" stroke-width=".8" fill="none"/><path class="route-height" d="" stroke="#74e4d6" stroke-opacity=".32" stroke-dasharray="3 4" fill="none"/>' : '') +
        '<circle cx="' + ap[0].x + '" cy="' + ap[0].y + '" r="2" fill="#8aabba"/>' +
        '<g class="route-target"><circle r="' + (spatial ? 7 : 4) + '" fill="#fa6b981c" stroke="#fa6b9877"/><circle r="2.3" fill="#fa6b98"/></g>' +
        '<g class="route-aircraft">' + (spatial ? '<circle r="12" fill="#63ead01c" stroke="#72e6d13d"/><path d="M-5 -5 5 5M-5 5 5 -5" stroke="#b8fff3" stroke-width="1.6"/><g fill="#12394a" stroke="#b8fff3" stroke-width="1.1"><circle cx="-5" cy="-5" r="3"/><circle cx="5" cy="-5" r="3"/><circle cx="-5" cy="5" r="3"/><circle cx="5" cy="5" r="3"/></g>' : '<circle r="6" fill="#6ee8d122" stroke="#6ee8d15c"/><circle r="2.8" fill="#c9fff3"/>') + '</g>';
      const distances = [0];
      for (let i = 1; i < ap.length; i++) distances[i] = distances[i - 1] + Math.hypot(ap[i].x - ap[i - 1].x, ap[i].y - ap[i - 1].y);
      return { svg, project, distances, progress:svg.querySelector('.route-progress'), aircraft:svg.querySelector('.route-aircraft'), target:svg.querySelector('.route-target'), height:svg.querySelector('.route-height'), frustum:svg.querySelector('.route-frustum'), sightline:svg.querySelector('.route-sightline') };
    }
    function updateRoute(route, pose) {
      if (!route) return;
      const p = route.project(pose), target = route.project({x:pose.tx,y:pose.ty,z:pose.tz});
      route.aircraft.setAttribute("transform", `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
      route.target.setAttribute("transform", `translate(${target.x.toFixed(2)} ${target.y.toFixed(2)})`);
      const i = Math.floor(pose.frame), j = Math.min(route.distances.length - 1, i + 1), u = pose.frame - i;
      const distance = route.distances[i] * (1 - u) + route.distances[j] * u;
      route.progress.setAttribute("stroke-dashoffset", String(100 * (1 - distance / (route.distances.at(-1) || 1))));
      if (route.height) {
        route.height.setAttribute("d", path([p,route.project({...pose,z:0})]));
        const ep = episode(), phase = ep.phase[Math.round(pose.frame)];
        route.sightline.setAttribute("d", "AKLR".includes(phase) ? path([p,target]) : "");
        const corners = cameraCorners(pose,ep).map(route.project);
        route.frustum.setAttribute("d",path([...corners,corners[0]])+" "+corners.map(c=>path([p,c])).join(" "));
      }
    }
    function renderScene() {
      const scene = scenes[current];
      text("mission-count", String(current + 1).padStart(2,"0") + " / " + String(scenes.length).padStart(2,"0"));
      text("mission-name", scene.label); text("mission-episode", "EPISODE " + scene.ep);
      text("console-count", String(current + 1).padStart(2,"0")); text("scene-label", scene.label);
      text("console-episode", "EPISODE " + scene.ep + " · RECORDED FLIGHT");
      heroDots.concat(sceneDots).forEach((dot, i) => {
        const selected = i % scenes.length === current;
        dot.classList.toggle("is-active", selected); dot.setAttribute("aria-pressed",String(selected));
      });
      if (pack) {
        azimuth = -0.65; tilt = 0.68;
        miniRoute = buildRoute(el("mission-mini"), false);
        spatialRoute = trajectoryVisible ? buildRoute(el("mission-spatial"), true) : null;
      }
      const poster = active().dataset.poster;
      if (poster) {
        const cover = el("mission-cover");
        cover.srcset = poster + "-640.webp 640w, " + poster + "-1280.webp 1280w";
        cover.src = poster + "-1280.webp";
        el("traj-poster").srcset = cover.srcset;
        el("traj-poster").src = poster + "-1280.webp";
      }
      if (!active().classList.contains("is-ready")) document.querySelector(".traj-viewport").classList.remove("has-frame");
      mediaStatus();
      updateVisuals(true);
    }
    function revealReplay() {
      const video = active();
      if (!viewerBooted || video.readyState < 2) return;
      // The renderer's resize/draw callbacks are queued first, so the poster
      // disappears only after the shared video has a frame on the canvas.
      cancelAnimationFrame(replayRAF);
      replayRAF = requestAnimationFrame(() => {
        replayRAF = 0;
        if (trajectoryVisible && video === active() && viewerScene === current && video.readyState >= 2)
          document.querySelector(".traj-viewport").classList.add("has-frame");
      });
    }
    function showTrajectory() {
      if (!pack || !trajectoryVisible || document.hidden) return;
      if (!spatialRoute) { spatialRoute = buildRoute(el("mission-spatial"),true);updateVisuals(true); }
      if (!window.TrajectoryView) {
        el("traj-stage").setAttribute("aria-busy","true");
        loadViewer().then(showTrajectory).catch(() => {
          text("traj-frame-caption","The replay controls could not be loaded. You can retry below.");
          el("traj-retry").hidden = false;
          el("traj-stage").setAttribute("aria-busy","false");
        });
        return;
      }
      TrajectoryView.attachVideo(active());
      if (!viewerBooted) { TrajectoryView.boot(pack); viewerBooted = true; }
      TrajectoryView.setVisible(true);
      if (viewerScene !== current) {
        const scene = scenes[current];
        TrajectoryView.show(scene.ep, scene.clip, { episode_index:scene.ep, town:scene.town });
        viewerScene = current;
      }
      ["traj-play","traj-reset","traj-time"].forEach((id) => { el(id).disabled = false; });
      el("traj-retry").hidden = true;
      el("traj-stage").setAttribute("aria-busy","false");
      revealReplay();
    }
    function updateVisuals(force = false) {
      const ep = episode();
      if (!ep) return;
      const time = clamp(active().currentTime || 0, 0, (ep.phase.length - 1) * ep.dt);
      const pose = sample(time / ep.dt);
      if (heroVisible || force) updateRoute(miniRoute, pose);
      if (trajectoryVisible || force) updateRoute(spatialRoute, pose);
      if (heroVisible || force) el("mission-progress").style.transform = "scaleX(" + time / ((ep.phase.length - 1) * ep.dt || 1) + ")";
      if (!force && performance.now() - lastReadout < 100) return;
      lastReadout = performance.now();
      const phase = PHASES[ep.phase[Math.round(pose.frame)]] || PHASES.O;
      ["mission-phase", "console-phase"].forEach((id) => { text(id,phase[0]);el(id).style.setProperty("--phase-color",phase[1]); });
      text("mission-time",clock(time)); text("mission-altitude",pose.z.toFixed(1) + " m");
      text("mission-range",Math.hypot(pose.tx-pose.x,pose.ty-pose.y,pose.tz-pose.z).toFixed(1) + " m");
    }
    function hudPump(timestamp) {
      hudRAF = 0;
      if (!visible()) return;
      if (timestamp - lastFrame >= 1000 / 30 - 1) { lastFrame = timestamp;updateVisuals(); }
      if (!active().paused && !active().ended) hudRAF = requestAnimationFrame(hudPump);
    }
    function ensureHUD() {
      if (visible() && !hudRAF) hudRAF = requestAnimationFrame(hudPump);
    }
    function syncVisibility() {
      clearTimeout(warmTimer);
      if (!trajectoryVisible || document.hidden) { cancelAnimationFrame(replayRAF); replayRAF = 0; }
      clips.forEach((video, index) => { if (index !== current || !visible()) video.pause(); });
      if (viewerBooted) TrajectoryView.setVisible(trajectoryVisible && !document.hidden);
      if (visible()) {
        showTrajectory();
        if (mediaAllowed && playbackRunning) playVideo(prepare(current));
        ensureHUD(); warmNext();
      } else { cancelAnimationFrame(hudRAF); hudRAF = 0; }
      mediaStatus();
    }
    async function showSlide(index) {
      const next = (index + scenes.length) % scenes.length;
      if (next === current && !active().ended) return;
      const ticket = ++request;
      playbackFailed = false;
      pending = next;
      clearTimeout(warmTimer);
      const previous = active(), incoming = clips[next];
      mediaAllowed = true;
      if (incoming.getAttribute("src")) incoming.currentTime = 0;
      // Preserve the outgoing frame until the new media actually starts.
      if (playbackRunning && visible()) { prepare(next); await playVideo(incoming); }
      if (ticket !== request) { if (next !== current && pending !== next) incoming.pause(); return; }
      current = next; pending = null; buffering = false;
      playbackFailed = playbackFailed || Boolean(incoming.error);
      previous.classList.remove("is-active"); incoming.classList.add("is-active");
      // The trajectory is attached to this exact element, never a second decoder.
      if (viewerBooted) TrajectoryView.attachVideo(incoming);
      renderScene(); showTrajectory();
      if (!visible() || !playbackRunning) incoming.pause();
      ensureHUD();
      setTimeout(() => { if (ticket === request) { cleanup(); warmNext(); } }, motionOK ? 1050 : 0);
    }

    clips.forEach((video) => {
      video.addEventListener("loadedmetadata", () => { if (video === active()) warmNext(); });
      video.addEventListener("play", () => { if (video === active()) { ensureHUD(); warmNext(); mediaStatus(); } });
      video.addEventListener("seeked", () => { if (video === active()) { updateVisuals(true); warmNext(); mediaStatus(); } });
      video.addEventListener("loadeddata", () => {
        video.classList.add("is-ready");
        if (video === active()) { updateVisuals(true); mediaStatus(); revealReplay(); }
      });
      ["playing","waiting","seeking","pause","error"].forEach((event) => {
        video.addEventListener(event, () => {
          if (video === active()) {
            if (event === "error") playbackFailed = true;
            if (event === "waiting") { buffering = true; clearTimeout(warmTimer); }
            if (event === "playing" || event === "pause") buffering = false;
            if (event === "playing") warmNext();
            mediaStatus();
          }
        });
      });
      video.addEventListener("ended", () => { if (video === active() && automatic && visible()) showSlide(current + 1); });
    });
    document.querySelector(".carousel-prev").addEventListener("click", () => showSlide(current - 1));
    document.querySelector(".carousel-next").addEventListener("click", () => showSlide(current + 1));
    document.querySelector(".scene-prev").addEventListener("click", () => showSlide(current - 1));
    document.querySelector(".scene-next").addEventListener("click", () => showSlide(current + 1));
    heroDots.forEach((dot, i) => dot.addEventListener("click", () => showSlide(i)));
    sceneDots.forEach((dot, i) => dot.addEventListener("click", () => showSlide(i)));
    toggles.forEach((toggle) => toggle.addEventListener("click", () => setAutomatic(!automatic)));
    el("traj-stage").addEventListener("pointerdown", (event) => { if (event.target.closest("canvas,svg,button,input,.traj-phasebar")) setAutomatic(false); });
    el("traj-time").addEventListener("input", () => { setAutomatic(false); updateVisuals(true); });
    document.addEventListener("missionplaybackchange", (event) => {
      playbackRunning = event.detail.playing;
      if (!playbackRunning) { clearTimeout(warmTimer); updateVisuals(true); }
      else { warmNext(); ensureHUD(); }
      mediaStatus();
    });
    el("traj-play").addEventListener("click", () => { mediaAllowed = true; prepare(current); });
    el("traj-retry").addEventListener("click", () => {
      el("traj-retry").hidden = true;
      text("traj-frame-caption","Loading replay controls…");
      showTrajectory();
    });
    el("mission-start").addEventListener("click", () => {
      mediaAllowed = true; playbackRunning = true; playbackFailed = false;
      const video = prepare(current);
      if (video.error) video.load();
      playVideo(video); mediaStatus(); warmNext();
    });
    const spatial = el("mission-spatial");
    spatial.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !pack) return;
      setAutomatic(false);
      spatial.setPointerCapture(event.pointerId);
      orbitDrag = { id:event.pointerId,x:event.clientX,y:event.clientY,az:azimuth,tilt };
      spatial.classList.add("dragging");
    });
    spatial.addEventListener("pointermove", (event) => {
      if (!orbitDrag || event.pointerId !== orbitDrag.id) return;
      azimuth = orbitDrag.az + (event.clientX-orbitDrag.x) * .009;
      tilt = clamp(orbitDrag.tilt+(event.clientY-orbitDrag.y)*.006,.18,1.3);
      spatialRoute = buildRoute(spatial,true); updateVisuals(true);
    });
    const endOrbit = () => { orbitDrag = null; spatial.classList.remove("dragging"); };
    spatial.addEventListener("pointerup",endOrbit); spatial.addEventListener("pointercancel",endOrbit);
    el("traj-reset").addEventListener("click", () => { azimuth=-.65;tilt=.68;spatialRoute=buildRoute(spatial,true);updateVisuals(true); });
    document.addEventListener("visibilitychange",syncVisibility);
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const on = entry.isIntersecting && entry.intersectionRatio >= .01;
          if (entry.target.matches(".hero")) heroVisible=on; else trajectoryVisible=on;
        });
        syncVisibility();
      },{threshold:.01});
      observer.observe(document.querySelector(".hero"));observer.observe(document.querySelector(".mission-views"));
      const rendererObserver = new IntersectionObserver((entries, prefetchObserver) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        prefetchObserver.disconnect();
        loadViewer().catch(() => {});
      },{rootMargin:"200px"});
      rendererObserver.observe(document.querySelector(".mission-views"));
    } else { heroVisible=trajectoryVisible=true;syncVisibility(); }
    updateControls();renderScene();
    const beginMedia = () => {
      if (mediaAllowed || startupQueued) return;
      startupQueued = true;
      requestAnimationFrame(() => requestAnimationFrame(() => { mediaAllowed = true; syncVisibility(); }));
    };
    const cover = el("mission-cover");
    cover.addEventListener("load",beginMedia,{once:true});
    cover.addEventListener("error",beginMedia,{once:true});
    if (cover.complete && cover.naturalWidth) beginMedia();
    // A failed poster request must not prevent playback or manual controls.
    setTimeout(beginMedia,1500);
    fetch("figures/scenes.json?v=14")
      .then((response) => { if (!response.ok) throw new Error("Trajectory data could not be loaded");return response.json(); })
      .then((data) => { pack=data;renderScene();showTrajectory();ensureHUD(); })
      .catch((error) => {
        text("mission-phase","FLIGHT REPLAY");text("scene-label","The trajectory viewer could not be loaded. Please refresh to try again.");
        el("traj-stage").hidden=true;document.querySelector(".scene-nav").hidden=true;
        console.error(error);
      });
  }
  window.AerialMission = { start };
})();
