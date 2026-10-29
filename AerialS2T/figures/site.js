// Native lazy loading can still fetch figures several screens away. Load a
// responsive source only as its reserved layout box approaches the viewport.
(function () {
  function loadFigure(picture) {
    const image = picture.querySelector("img");
    const loaded = () => {
      if (!image.currentSrc || image.currentSrc.startsWith("data:")) return;
      picture.classList.add("is-loaded");
      image.removeEventListener("load",loaded);
    };
    image.addEventListener("load",loaded);
    image.addEventListener("error", () => {
      // Original PNGs remain available as a fallback to the optimized format.
      picture.querySelectorAll("source").forEach(source => source.removeAttribute("srcset"));
      picture.classList.add("figure-error");
      if (image.src !== new URL(image.dataset.src,document.baseURI).href) image.src = image.dataset.src;
    },{once:true});
    picture.querySelectorAll("source[data-srcset]").forEach(source => { source.srcset = source.dataset.srcset; });
    image.src = image.dataset.src;
  }
  const figures = document.querySelectorAll(".figure-media");
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        loadFigure(entry.target);
      });
    },{rootMargin:"200px"});
    figures.forEach(figure => observer.observe(figure));
  } else figures.forEach(loadFigure);
})();

    const SCENES = [
      { ep: 817, town: "Town01", label: "Town01 · Van", clip: "fly_01_town01.mp4?v=1", seconds: 43 },
      { ep: 515, town: "Town03", label: "Town03 · Bicycle", clip: "fly_02_town03.mp4?v=1", seconds: 38 },
      { ep: 5867, town: "Town04", label: "Town04 · Adult", clip: "fly_03_town04.mp4?v=2", seconds: 41 },
      { ep: 9440, town: "Town05", label: "Town05 · Car", clip: "fly_04_town05.mp4?v=1", seconds: 40 },
      { ep: 9556, town: "Town07", label: "Town07 · Motorcycle", clip: "fly_05_town07.mp4?v=2", seconds: 42 },
      { ep: 9419, town: "Town10HD", label: "Town10HD · Teenager", clip: "fly_06_town10.mp4?v=1", seconds: 40 }
    ];
    AerialMission.start(SCENES);

    let viewerData = null;
    let viewerCategory = null;
    let viewerItem = null;

    function renderViewerTabs() {
      const bar = document.getElementById("viewer-tabs");
      bar.innerHTML = "";
      viewerData.order.forEach((key) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = viewerData.categories[key].label;
        btn.className = key === viewerCategory ? "active" : "";
        btn.addEventListener("click", () => showViewerCategory(key, true));
        bar.appendChild(btn);
      });
    }

    function showViewerCategory(key, openFirst) {
      viewerCategory = key;
      renderViewerTabs();
      const row = document.getElementById("viewer-thumbs");
      row.innerHTML = "";
      const items = viewerData.categories[key].items.slice(0, 7);
      items.forEach((item, index) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = item.id === viewerItem ? "selected" : "";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.src = item.thumb;
        img.alt = item.record.task_instruction;
        btn.appendChild(img);
        btn.addEventListener("click", () => showViewerDetail(item, true));
        row.appendChild(btn);
        if (openFirst && index === 0) showViewerDetail(item, false);
      });
    }

    function showViewerDetail(item, scroll) {
      viewerItem = item.id;
      document.querySelectorAll("#viewer-thumbs button").forEach((btn, i) => {
        const current = viewerData.categories[viewerCategory].items[i];
        btn.classList.toggle("selected", current && current.id === item.id);
      });
      const photos = document.getElementById("viewer-photos");
      photos.innerHTML = "";
      item.images.forEach((frame) => {
        const fig = document.createElement("figure");
        const img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.src = frame.src;
        img.alt = frame.label;
        const cap = document.createElement("figcaption");
        cap.textContent = frame.label;
        fig.appendChild(img);
        fig.appendChild(cap);
        photos.appendChild(fig);
      });
      document.getElementById("viewer-record").textContent = JSON.stringify(item.record, null, 2);
      const card = document.getElementById("viewer-detail");
      card.classList.add("open");
      if (scroll) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    function loadDatasetViewer() {
      fetch("figures/viewer/data.json")
        .then((res) => { if (!res.ok) throw new Error("Dataset could not be loaded"); return res.json(); })
        .then((data) => {
          viewerData = data;
          showViewerCategory(data.order[0], true);
        })
        .catch(() => {
          const hint = document.querySelector(".viewer-hint");
          if (hint) hint.textContent = "Dataset viewer is still loading.";
        });
    }
    if ("IntersectionObserver" in window) {
      const datasetObserver = new IntersectionObserver((entries, observer) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        loadDatasetViewer();
      }, { rootMargin: "300px" });
      datasetObserver.observe(document.getElementById("dataset"));
    } else loadDatasetViewer();
