(() => {
  const canvas = document.getElementById("editor-canvas");
  const ctx = canvas.getContext("2d");
  const snapToggle = document.getElementById("snap-toggle");
  const gridSizeInput = document.getElementById("grid-size");
  const wallThicknessInput = document.getElementById("wall-thickness");
  const wallHeightInput = document.getElementById("wall-height");
  const clearBtn = document.getElementById("clear-btn");
  const exportBtn = document.getElementById("export-btn");
  const exportWbtBtn = document.getElementById("export-wbt-btn");
  const statusText = document.getElementById("status-text");

  const PIXELS_PER_METER = 50;

  // walls: array of straight-line segments in meters: {x1, y1, x2, y2, thickness}
  const walls = [];
  let pendingStart = null; // {x, y} in meters, or null
  let mouseWorld = { x: 0, y: 0 };

  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    draw();
  }

  function origin() {
    return { x: canvas.width / 2, y: canvas.height / 2 };
  }

  function worldToScreen(x, y) {
    const o = origin();
    return { x: o.x + x * PIXELS_PER_METER, y: o.y - y * PIXELS_PER_METER };
  }

  function screenToWorld(sx, sy) {
    const o = origin();
    return { x: (sx - o.x) / PIXELS_PER_METER, y: -(sy - o.y) / PIXELS_PER_METER };
  }

  function gridSize() {
    return Math.max(0.1, parseFloat(gridSizeInput.value) || 0.5);
  }

  function wallThickness() {
    return Math.max(0.01, parseFloat(wallThicknessInput.value) || 0.1);
  }

  function snapPoint(p) {
    if (!snapToggle.checked) return p;
    const g = gridSize();
    return {
      x: Math.round(p.x / g) * g,
      y: Math.round(p.y / g) * g,
    };
  }

  function drawGrid() {
    const g = gridSize();
    const stepPx = g * PIXELS_PER_METER;
    if (stepPx < 4) return;

    const o = origin();
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let x = o.x % stepPx; x < canvas.width; x += stepPx) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
    }
    for (let y = o.y % stepPx; y < canvas.height; y += stepPx) {
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
    }
    ctx.stroke();

    // axes through origin
    ctx.strokeStyle = "#4a4a4a";
    ctx.beginPath();
    ctx.moveTo(o.x, 0);
    ctx.lineTo(o.x, canvas.height);
    ctx.moveTo(0, o.y);
    ctx.lineTo(canvas.width, o.y);
    ctx.stroke();
  }

  function drawWall(x1, y1, x2, y2, thickness, color) {
    const p1 = worldToScreen(x1, y1);
    const p2 = worldToScreen(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, thickness * PIXELS_PER_METER);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();

    for (const w of walls) {
      drawWall(w.x1, w.y1, w.x2, w.y2, w.thickness, "#e0e0e0");
    }

    if (pendingStart) {
      const end = snapPoint(mouseWorld);
      ctx.setLineDash([6, 4]);
      drawWall(pendingStart.x, pendingStart.y, end.x, end.y, wallThickness(), "#5fb0ff");
      ctx.setLineDash([]);

      const p1 = worldToScreen(pendingStart.x, pendingStart.y);
      ctx.fillStyle = "#5fb0ff";
      ctx.beginPath();
      ctx.arc(p1.x, p1.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function handleClick(evt) {
    const rect = canvas.getBoundingClientRect();
    const raw = screenToWorld(evt.clientX - rect.left, evt.clientY - rect.top);
    const point = snapPoint(raw);

    if (!pendingStart) {
      pendingStart = point;
      statusText.textContent = "もう一度クリックで壁の終点を確定 (Escでキャンセル)";
    } else {
      if (point.x !== pendingStart.x || point.y !== pendingStart.y) {
        walls.push({
          x1: pendingStart.x,
          y1: pendingStart.y,
          x2: point.x,
          y2: point.y,
          thickness: wallThickness(),
        });
      }
      pendingStart = null;
      statusText.textContent = `壁: ${walls.length}本 / クリックで壁の始点、もう一度クリックで終点`;
    }
    draw();
  }

  function handleMouseMove(evt) {
    const rect = canvas.getBoundingClientRect();
    mouseWorld = screenToWorld(evt.clientX - rect.left, evt.clientY - rect.top);
    if (pendingStart) draw();
  }

  function handleKeyDown(evt) {
    if (evt.key === "Escape" && pendingStart) {
      pendingStart = null;
      statusText.textContent = "キャンセルしました / クリックで壁の始点";
      draw();
    }
  }

  window.addEventListener("resize", resizeCanvas);
  canvas.addEventListener("click", handleClick);
  canvas.addEventListener("mousemove", handleMouseMove);
  window.addEventListener("keydown", handleKeyDown);
  gridSizeInput.addEventListener("change", draw);
  snapToggle.addEventListener("change", draw);
  clearBtn.addEventListener("click", () => {
    walls.length = 0;
    pendingStart = null;
    statusText.textContent = "クリアしました / クリックで壁の始点";
    draw();
  });

  exportBtn.addEventListener("click", () => {
    if (walls.length === 0) {
      statusText.textContent = "壁がありません。先に壁を描いてください。";
      return;
    }
    const wallHeight = Math.max(0.1, parseFloat(wallHeightInput.value) || 2.5);
    const sdf = window.BuildingEditorExport.wallsToSDF(walls, { wallHeight });
    window.BuildingEditorExport.downloadSDF(sdf, "building.sdf");
    statusText.textContent = `SDFをダウンロードしました (壁 ${walls.length}本)`;
  });

  exportWbtBtn.addEventListener("click", () => {
    if (walls.length === 0) {
      statusText.textContent = "壁がありません。先に壁を描いてください。";
      return;
    }
    const wallHeight = Math.max(0.1, parseFloat(wallHeightInput.value) || 2.5);
    const wbt = window.BuildingEditorExport.wallsToWBT(walls, { wallHeight });
    window.BuildingEditorExport.downloadWBT(wbt, "building.wbt");
    statusText.textContent = `Webots(.wbt)をダウンロードしました (壁 ${walls.length}本)`;
  });

  resizeCanvas();
})();
