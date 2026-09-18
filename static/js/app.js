(() => {
  const canvas = document.getElementById("editor-canvas");
  const ctx = canvas.getContext("2d");
  const gridSizeInput = document.getElementById("grid-size");
  const wallThicknessInput = document.getElementById("wall-thickness");
  const wallHeightInput = document.getElementById("wall-height");
  const doorHeightInput = document.getElementById("door-height");
  const drawModeWallRadio = document.getElementById("draw-mode-wall");
  const drawModeDoorRadio = document.getElementById("draw-mode-door");
  const objectRotationInput = document.getElementById("object-rotation");
  const objectHeightInput = document.getElementById("object-height");
  const robotBtn = document.getElementById("robot-btn");
  const clearBtn = document.getElementById("clear-btn");
  const previewBtn = document.getElementById("preview-btn");
  const previewModal = document.getElementById("preview-modal");
  const previewCloseBtn = document.getElementById("preview-close-btn");
  const exportBtn = document.getElementById("export-btn");
  const exportMenu = document.getElementById("export-menu");
  const exportSdfItem = document.getElementById("export-sdf-item");
  const exportWbtItem = document.getElementById("export-wbt-item");
  const exportBothItem = document.getElementById("export-both-item");
  const statusText = document.getElementById("status-text");
  const catalogSearch = document.getElementById("catalog-search");
  const catalogList = document.getElementById("catalog-list");
  const catalogPreview = document.getElementById("catalog-preview");
  const catalogPreviewImg = document.getElementById("catalog-preview-img");
  const catalogPreviewName = document.getElementById("catalog-preview-name");
  const catalogPreviewCategory = document.getElementById("catalog-preview-category");
  const catalogPreviewStatus = document.getElementById("catalog-preview-status");
  const catalogPlaceBtn = document.getElementById("catalog-place-btn");
  const catalogCacheBtn = document.getElementById("catalog-cache-btn");

  const PIXELS_PER_METER = 50; // zoom=1のときの基準倍率。実際の描画は pixelsPerMeter() を使う
  const OBJECT_COLOR = "#7ed07e";
  const SELECTED_COLOR = "#e05f5f";
  const ROBOT_COLOR = "#5fd0e0";
  const ROBOT_GHOST_COLOR = "#5fb0ff";
  const ROBOT_HIT_RADIUS_M = 0.25; // ロボット開始位置マーカーのクリック当たり判定半径
  const DEFAULT_GHOST_FOOTPRINT = { width: 0.4, depth: 0.4 };
  const HIT_SEGMENT_MARGIN = 0.1; // メートル。壁・ドアを掴みやすくするための追加マージン
  const HIT_OBJECT_DEFAULT = { width: 0.3, depth: 0.3 };
  const DRAG_THRESHOLD_M = 0.02; // これ以上動いたら「ドラッグした」とみなす
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 10;
  const ENDPOINT_SNAP_RADIUS_M = 0.2; // メートル。壁/ドアの端点への吸着半径

  // walls: array of straight-line segments in meters: {x1, y1, x2, y2, thickness}
  const walls = [];
  // doors: 見た目は壁と同じ線分だが、高さが低く別名で書き出される簡易プリミティブ
  // (壁と同じくカタログ取り込みではなく自前のプリミティブとして扱う)
  const doors = [];
  // objects: array of placed catalog objects: {id, name, x, y, z, yaw, meshPath, texturePaths, footprint}
  const objects = [];
  let nextObjectId = 1;
  let pendingStart = null; // {x, y} in meters, or null (wall drawing)
  let mouseWorld = { x: 0, y: 0 };
  let zoom = 1; // pixelsPerMeter = PIXELS_PER_METER * zoom
  let panX = 0; // ワールド座標系での視点オフセット(メートル)
  let panY = 0;
  let panDragState = null; // Shift+ドラッグでのパン操作中の状態

  let selectedItem = null; // { kind, index } 配置済みアイテムをクリックして選択中の状態(高さ編集用)

  // ロボットの開始位置(x, y, yaw)。1個だけ置ける特別なマーカーで、カタログオブジェクトとは別枠。
  // SDF出力では<model name="spawn">としてOneStageROSが認識する規約に、WBT出力では
  // Turtlebot3Limeノードの配置にそのまま使う。
  let robotPose = null; // {x, y, yaw} | null
  let robotPlacementArmed = false; // ロボット配置ボタンを押した直後、次のクリックで設置/移動する状態

  let catalog = [];
  let focusedEntry = null; // プレビュー枠に表示中のカタログentry(配置アームはしない)
  let selectedEntry = null; // catalog entry currently armed for placement
  let selectedEntryData = null; // 配置アーム中entryの取り込み結果(mesh_path/footprint等)
  let selectedEntryError = null;
  const importCache = new Map(); // name -> {data} | {error} 取り込み結果を使い回す

  let dragState = null; // {kind, index, grab, orig} 既存アイテムをドラッグ移動中
  let suppressNextClick = false; // ドラッグ操作の直後、その場でのclick(新規配置/壁描画)を止める

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    draw();
  }

  function origin() {
    return { x: canvas.width / 2, y: canvas.height / 2 };
  }

  function pixelsPerMeter() {
    return PIXELS_PER_METER * zoom;
  }

  function worldToScreen(x, y) {
    const o = origin();
    const ppm = pixelsPerMeter();
    return { x: o.x + (x + panX) * ppm, y: o.y - (y + panY) * ppm };
  }

  function screenToWorld(sx, sy) {
    const o = origin();
    const ppm = pixelsPerMeter();
    return { x: (sx - o.x) / ppm - panX, y: -(sy - o.y) / ppm - panY };
  }

  function gridSize() {
    return Math.max(0.1, parseFloat(gridSizeInput.value) || 0.5);
  }

  function wallThickness() {
    return Math.max(0.01, parseFloat(wallThicknessInput.value) || 0.1);
  }

  function doorHeight() {
    return Math.max(0.1, parseFloat(doorHeightInput.value) || 2.0);
  }

  function drawMode() {
    return drawModeDoorRadio.checked ? "door" : "wall";
  }

  function objectRotationRad() {
    const deg = parseFloat(objectRotationInput.value) || 0;
    return (deg * Math.PI) / 180;
  }

  function objectHeight() {
    // 床からの高さ。机の天板の高さなどを入れておくと、その上に物を置ける。
    return parseFloat(objectHeightInput.value) || 0;
  }

  function snapPoint(p) {
    // グリッドスナップは廃止し、クリック位置そのままに配置する(自由配置のみ)。
    return p;
  }

  // --- 幾何ヘルパー(当たり判定用、すべてワールド座標系で計算する) ---

  function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function pointInRotatedRect(px, py, cx, cy, yaw, w, d) {
    const dx = px - cx;
    const dy = py - cy;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    return Math.abs(lx) <= w / 2 && Math.abs(ly) <= d / 2;
  }

  function arrayForKind(kind) {
    return kind === "object" ? objects : kind === "door" ? doors : walls;
  }

  function findStackBase(point) {
    // 配置しようとしている場所の直下に既存オブジェクトがあれば、その上面の高さを返す
    // (机の上に物を置きたい、というケースをクリック位置から自動推測する)。
    // 複数重なっている場合は一番上の面(topZが最大のもの)を採用する。
    let best = null;
    for (const o of objects) {
      const fp = o.footprint || HIT_OBJECT_DEFAULT;
      if (!pointInRotatedRect(point.x, point.y, o.x, o.y, o.yaw, fp.width, fp.depth)) continue;
      const topZ = (o.z || 0) + ((o.footprint && o.footprint.height) || 0);
      if (!best || topZ > best.topZ) best = { obj: o, topZ };
    }
    return best;
  }

  function findItemAt(point) {
    if (robotPose && Math.hypot(point.x - robotPose.x, point.y - robotPose.y) <= ROBOT_HIT_RADIUS_M) {
      return { kind: "robot" };
    }
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      const fp = o.footprint || HIT_OBJECT_DEFAULT;
      if (pointInRotatedRect(point.x, point.y, o.x, o.y, o.yaw, fp.width, fp.depth)) {
        return { kind: "object", index: i };
      }
    }
    for (let i = doors.length - 1; i >= 0; i--) {
      const d = doors[i];
      if (pointToSegmentDistance(point.x, point.y, d.x1, d.y1, d.x2, d.y2) <= d.thickness / 2 + HIT_SEGMENT_MARGIN) {
        return { kind: "door", index: i };
      }
    }
    for (let i = walls.length - 1; i >= 0; i--) {
      const w = walls[i];
      if (pointToSegmentDistance(point.x, point.y, w.x1, w.y1, w.x2, w.y2) <= w.thickness / 2 + HIT_SEGMENT_MARGIN) {
        return { kind: "wall", index: i };
      }
    }
    return null;
  }

  function itemLabel(kind, item) {
    if (kind === "object") return item.name;
    if (kind === "robot") return "ロボット開始位置";
    return kind === "door" ? "ドア" : "壁";
  }

  // --- 描画 ---

  function drawGrid() {
    const g = gridSize();
    const stepPx = g * pixelsPerMeter();
    if (stepPx < 3) return; // ズームアウトしすぎて詰まる場合は間引く代わりに省略する

    // ワールド原点(0,0)の画面上の位置を基準に、パン・ズームしても格子がずれないようにする。
    const originScreen = worldToScreen(0, 0);
    const startX = ((originScreen.x % stepPx) + stepPx) % stepPx;
    const startY = ((originScreen.y % stepPx) + stepPx) % stepPx;

    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 1;

    ctx.beginPath();
    for (let x = startX; x < canvas.width; x += stepPx) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
    }
    for (let y = startY; y < canvas.height; y += stepPx) {
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
    }
    ctx.stroke();

    // axes through world origin
    ctx.strokeStyle = "#4a4a4a";
    ctx.beginPath();
    ctx.moveTo(originScreen.x, 0);
    ctx.lineTo(originScreen.x, canvas.height);
    ctx.moveTo(0, originScreen.y);
    ctx.lineTo(canvas.width, originScreen.y);
    ctx.stroke();
  }

  function drawWall(x1, y1, x2, y2, thickness, color) {
    const p1 = worldToScreen(x1, y1);
    const p2 = worldToScreen(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, thickness * pixelsPerMeter());
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  // 正面(yaw=0方向)を示す矢印。線だけだと目立たず向きが分かりにくいため、
  // 先端に三角形の矢じりを付けて正面がひと目で分かるようにする。
  function drawHeadingArrow(p, yaw, length, color, lineWidth) {
    const tipX = p.x + Math.cos(-yaw) * length;
    const tipY = p.y + Math.sin(-yaw) * length;
    const angle = Math.atan2(tipY - p.y, tipX - p.x);
    const headLen = Math.max(7, length * 0.4);

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    const leftX = tipX - headLen * Math.cos(angle - Math.PI / 6);
    const leftY = tipY - headLen * Math.sin(angle - Math.PI / 6);
    const rightX = tipX - headLen * Math.cos(angle + Math.PI / 6);
    const rightY = tipY - headLen * Math.sin(angle + Math.PI / 6);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(leftX, leftY);
    ctx.lineTo(rightX, rightY);
    ctx.closePath();
    ctx.fill();
  }

  function drawObject(obj, index) {
    const isSelected = selectedItem && selectedItem.kind === "object" && selectedItem.index === index;
    const color = isSelected ? SELECTED_COLOR : OBJECT_COLOR;
    const p = worldToScreen(obj.x, obj.y);
    let headingLength = 16;

    if (obj.footprint) {
      // メッシュのバウンディングボックス(実寸)を、配置位置中心・yaw回転で矩形表示する。
      // .stl等footprintが取れない形式は下のフォールバック(固定サイズの点)になる。
      const w = obj.footprint.width * pixelsPerMeter();
      const d = obj.footprint.depth * pixelsPerMeter();
      headingLength = Math.max(w, d) / 2 + 10; // 矢印の先端が枠からはみ出て見えるように
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-obj.yaw);
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.strokeRect(-w / 2, -d / 2, w, d);
      ctx.fillStyle = color + "40"; // 半透明塗りつぶし
      ctx.fillRect(-w / 2, -d / 2, w, d);
      ctx.restore();
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    drawHeadingArrow(p, obj.yaw, headingLength, color, isSelected ? 2.5 : 1.5);

    ctx.fillStyle = "#e0e0e0";
    ctx.font = "11px sans-serif";
    const label = obj.z ? `${obj.name} (z=${obj.z.toFixed(2)}m)` : obj.name;
    ctx.fillText(label, p.x + 8, p.y - 8);
  }

  function drawRobotPose() {
    if (!robotPose) return;
    const isSelected = selectedItem && selectedItem.kind === "robot";
    const color = isSelected ? SELECTED_COLOR : ROBOT_COLOR;
    const p = worldToScreen(robotPose.x, robotPose.y);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fill();

    // 正面を示す矢印(オブジェクトより長めにして、ロボットの初期姿勢と分かるようにする)
    drawHeadingArrow(p, robotPose.yaw, 26, color, 2.5);

    ctx.fillStyle = "#e0e0e0";
    ctx.font = "11px sans-serif";
    ctx.fillText("ロボット開始位置", p.x + 10, p.y - 10);
  }

  function drawRobotGhost() {
    if (!robotPlacementArmed) return;
    const point = snapPoint(mouseWorld);
    const p = worldToScreen(point.x, point.y);
    const yaw = objectRotationRad();

    ctx.save();
    ctx.strokeStyle = ROBOT_GHOST_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    drawHeadingArrow(p, yaw, 26, ROBOT_GHOST_COLOR, 1.5);
  }

  function drawObjectGhost() {
    // カタログでオブジェクトを選択中、配置前にキャンバス上でカーソルに枠を追従させる。
    // 実寸(footprint)が取得できるまでは既定サイズの枠で代用する。
    if (!selectedEntry) return;
    const point = snapPoint(mouseWorld);
    const p = worldToScreen(point.x, point.y);
    const yaw = objectRotationRad();
    const fp = (selectedEntryData && selectedEntryData.footprint) || DEFAULT_GHOST_FOOTPRINT;
    const w = fp.width * pixelsPerMeter();
    const d = fp.depth * pixelsPerMeter();

    const ghostColor = selectedEntryError ? "#e05f5f" : "#5fb0ff";
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-yaw);
    ctx.strokeStyle = ghostColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(-w / 2, -d / 2, w, d);
    ctx.setLineDash([]);
    ctx.restore();

    drawHeadingArrow(p, yaw, Math.max(w, d) / 2 + 10, ghostColor, 1.5);
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid();

    // 壁・ドアは「選択」の対象にしない(クリック=新しい壁/ドアの描画開始、角には吸着する)ため、
    // ハイライトも無い。選択状態を持つのはオブジェクトのみ。
    for (const w of walls) {
      drawWall(w.x1, w.y1, w.x2, w.y2, w.thickness, "#e0e0e0");
    }
    for (const d of doors) {
      drawWall(d.x1, d.y1, d.x2, d.y2, d.thickness, "#e0a95f");
    }
    objects.forEach((o, i) => drawObject(o, i));
    drawRobotPose();

    if (pendingStart) {
      const end = findNearestEndpoint(mouseWorld) || snapPoint(mouseWorld);
      const previewColor = drawMode() === "door" ? "#e0a95f" : "#5fb0ff";
      ctx.setLineDash([6, 4]);
      drawWall(pendingStart.x, pendingStart.y, end.x, end.y, wallThickness(), previewColor);
      ctx.setLineDash([]);

      const p1 = worldToScreen(pendingStart.x, pendingStart.y);
      ctx.fillStyle = previewColor;
      ctx.beginPath();
      ctx.arc(p1.x, p1.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    drawObjectGhost();
    drawRobotGhost();
  }

  // --- Catalog ---

  // ownerが異なると同名の可能性があるため、カタログentryの同一性はowner+nameで判定する。
  function entryKey(entry) {
    return `${entry.owner}/${entry.name}`;
  }

  function renderCatalog(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    catalogList.innerHTML = "";
    const filtered = !q
      ? catalog
      : catalog.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            e.category.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q)
        );

    for (const entry of filtered) {
      const item = document.createElement("div");
      item.className = "catalog-item";
      if (selectedEntry && entryKey(selectedEntry) === entryKey(entry)) {
        item.classList.add("selected");
      } else if (focusedEntry && entryKey(focusedEntry) === entryKey(entry)) {
        item.classList.add("focused");
      }

      const thumb = document.createElement("img");
      thumb.className = "catalog-item-thumb";
      thumb.loading = "lazy";
      thumb.alt = "";
      thumb.src = entry.icon_url;
      // サムネイルの取得に失敗した個体もあるため、読み込み失敗時は枠だけ残して
      // テキスト側で判別できるようにする。
      thumb.addEventListener("error", () => {
        thumb.classList.add("catalog-item-thumb-missing");
      });

      const info = document.createElement("span");
      info.className = "catalog-item-info";
      const nameEl = document.createElement("span");
      nameEl.className = "catalog-item-name";
      nameEl.textContent = entry.name;
      const catEl = document.createElement("span");
      catEl.className = "catalog-item-category";
      catEl.textContent = entry.category;
      info.appendChild(nameEl);
      info.appendChild(catEl);
      if (entry.cached) {
        const badge = document.createElement("span");
        badge.className = "catalog-item-cached";
        badge.textContent = "取り込み済み";
        badge.title = "サーバーに実体を取り込み済み。他ツールからも配置できます。";
        info.appendChild(badge);
      }

      item.appendChild(thumb);
      item.appendChild(info);
      item.addEventListener("click", () => focusCatalogEntry(entry));
      catalogList.appendChild(item);
    }
  }

  // カタログ項目を1クリック: プレビュー枠に画像を出すだけ。
  // サーバーへの取り込み(ダウンロード)はしない ─ 実体を落とすのは
  // 「ワールドに配置」または「ライブラリに追加」を押したときだけ。
  function focusCatalogEntry(entry) {
    if (focusedEntry && entryKey(focusedEntry) === entryKey(entry)) {
      clearFocus();
      return;
    }
    focusedEntry = entry;
    catalogPreview.hidden = false;
    catalogPreviewImg.src = entry.icon_url;
    catalogPreviewImg.style.visibility = "visible";
    catalogPreviewImg.onerror = () => {
      catalogPreviewImg.style.visibility = "hidden";
    };
    catalogPreviewName.textContent = entry.name;
    catalogPreviewCategory.textContent = entry.category;
    catalogPreviewStatus.textContent = "";
    updatePreviewButtons();
    renderCatalog(catalogSearch.value);
  }

  function clearFocus() {
    focusedEntry = null;
    catalogPreview.hidden = true;
    renderCatalog(catalogSearch.value);
  }

  function updatePreviewButtons() {
    const cached = !!(focusedEntry && focusedEntry.cached);
    catalogCacheBtn.disabled = cached;
    catalogCacheBtn.textContent = cached ? "ライブラリに追加済み" : "ライブラリに追加";
  }

  function setPreviewStatus(entry, text) {
    if (focusedEntry && entryKey(focusedEntry) === entryKey(entry)) {
      catalogPreviewStatus.textContent = text;
    }
  }

  // サーバーへの取り込み(idempotent)。結果は importCache に保持して使い回す。
  async function ensureImport(entry) {
    const hit = importCache.get(entryKey(entry));
    if (hit) return hit;
    setPreviewStatus(entry, "取り込み中…");
    let result;
    try {
      const res = await fetch("/api/objects/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: entry.owner, name: entry.name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "import failed");
      result = { data };
      importCache.set(entryKey(entry), result); // 成功時のみ保持(失敗は毎回リトライさせる)
      entry.cached = true;
      renderCatalog(catalogSearch.value);
      updatePreviewButtons();
      setPreviewStatus(entry, "");
    } catch (e) {
      result = { error: e.message || String(e) };
      setPreviewStatus(entry, `読み込み失敗: ${result.error}`);
    }
    return result;
  }

  async function armPlacementFromPreview() {
    const entry = focusedEntry;
    if (!entry) return;
    setPreviewStatus(entry, "取り込み中…");
    const r = await ensureImport(entry);
    if (!focusedEntry || entryKey(focusedEntry) !== entryKey(entry)) return;
    if (r.error) return;
    selectedEntry = entry;
    selectedEntryData = r.data;
    selectedEntryError = null;
    pendingStart = null;
    robotPlacementArmed = false;
    deselectItem();
    catalogPreviewStatus.textContent = "キャンバスをクリックして配置 (Escで解除)";
    renderCatalog(catalogSearch.value);
    draw();
  }

  async function cacheFromPreview() {
    const entry = focusedEntry;
    if (!entry) return;
    setPreviewStatus(entry, "取り込み中…");
    const r = await ensureImport(entry);
    if (!focusedEntry || entryKey(focusedEntry) !== entryKey(entry)) return;
    if (!r.error) setPreviewStatus(entry, "ライブラリに追加しました");
  }

  function placeObject(point) {
    if (!selectedEntryData) return;
    // 置こうとしている場所に既存オブジェクトがあれば、その上面に自動で乗せる
    // (机の上に物を置きたい、というのをクリック位置から推測する)。
    // 「配置の高さ」入力は、その上面からのさらなる上乗せ(既定0)として使う。
    const stackBase = findStackBase(point);
    const z = (stackBase ? stackBase.topZ : 0) + objectHeight();
    const obj = {
      id: nextObjectId++,
      name: selectedEntry.name,
      x: point.x,
      y: point.y,
      z,
      yaw: objectRotationRad(),
      meshPath: selectedEntryData.mesh_path,
      meshUrl: selectedEntryData.mesh_url || null,
      mtlUrl: selectedEntryData.mtl_url || null,
      texturePaths: selectedEntryData.texture_paths || [],
      textureUrls: selectedEntryData.texture_urls || [],
      footprint: selectedEntryData.footprint || null,
      // mtl/テクスチャが無いメッシュ用のフォールバック単色([r,g,b] 0-1、無ければnull=既定の灰色)。
      baseColor: selectedEntryData.base_color || null,
      // メッシュファイル自体は元の縮尺のまま保存されている(mm単位など)ことがあり、
      // 実寸に直すための倍率。3Dプレビュー・SDF/WBTエクスポートどちらでも使う。
      scale: selectedEntryData.scale || [1, 1, 1],
    };
    objects.push(obj);
    const sizeText = obj.footprint
      ? ` (幅${obj.footprint.width.toFixed(2)}×奥${obj.footprint.depth.toFixed(2)}×高${(obj.footprint.height || 0).toFixed(2)}m)`
      : "";
    const placeText = stackBase
      ? ` / 「${stackBase.obj.name}」の上に配置(高さ${z.toFixed(2)}m)`
      : obj.z
      ? ` / 高さ${obj.z.toFixed(2)}mに配置`
      : "";
    statusText.textContent = `「${obj.name}」を配置しました${sizeText}${placeText}`;

    // 要望: 1回置いたら配置アームは解除する。プレビュー枠は残すので、同じ物を続けて
    // 置きたい場合は「ワールドに配置」をもう一度押せばよい。
    selectedEntry = null;
    selectedEntryData = null;
    selectedEntryError = null;
    if (focusedEntry) {
      catalogPreviewStatus.textContent = "配置しました";
    }
    renderCatalog(catalogSearch.value);
    draw();
  }

  function selectItem(hit) {
    selectedItem = hit; // { kind: "object", index } または { kind: "robot" }
    if (hit.kind === "robot") {
      objectRotationInput.value = Math.round((robotPose.yaw * 180) / Math.PI);
      statusText.textContent = "ロボット開始位置を選択中(回転を編集できます / スクロールでも回転 / ドラッグで移動)";
    } else {
      const obj = objects[hit.index];
      objectHeightInput.value = (obj.z || 0).toFixed(2);
      objectRotationInput.value = Math.round((obj.yaw * 180) / Math.PI);
      statusText.textContent = `「${obj.name}」を選択中(高さ・回転を編集できます / スクロールでも回転 / 他をクリックすると選択解除)`;
    }
    draw();
  }

  function deselectItem() {
    if (!selectedItem) return;
    selectedItem = null;
    objectHeightInput.value = "0";
    draw();
  }

  function findNearestEndpoint(point) {
    // 壁・ドアの端点(角)にクリック位置が近ければ、そこに吸着させる。
    // これにより新しい壁を既存の角からきっちり生やせる(=壁/ドアには「選択」を
    // 割り当てず、クリックは常に新規の壁/ドア描画として扱うのと対になる挙動)。
    let best = null;
    let bestDist = ENDPOINT_SNAP_RADIUS_M;
    for (const seg of [...walls, ...doors]) {
      for (const [ex, ey] of [
        [seg.x1, seg.y1],
        [seg.x2, seg.y2],
      ]) {
        const dist = Math.hypot(point.x - ex, point.y - ey);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x: ex, y: ey };
        }
      }
    }
    return best;
  }

  function handleClick(evt) {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const raw = screenToWorld(evt.clientX - rect.left, evt.clientY - rect.top);
    const point = findNearestEndpoint(raw) || snapPoint(raw);

    if (robotPlacementArmed) {
      robotPose = { x: point.x, y: point.y, yaw: objectRotationRad() };
      robotPlacementArmed = false;
      statusText.textContent = "ロボット開始位置を設置しました(ドラッグで移動・スクロールで回転できます)";
      draw();
      return;
    }

    if (selectedEntry) {
      if (!selectedEntryData) {
        statusText.textContent = selectedEntryError
          ? `「${selectedEntry.name}」は読み込みに失敗しています。カタログから選び直してください。`
          : `「${selectedEntry.name}」を読み込み中です。少し待ってからクリックしてください。`;
        return;
      }
      placeObject(point);
      return;
    }

    if (!pendingStart) {
      // 壁描画の1点目を確定する前のクリックは、オブジェクトへのクリック選択として扱う
      // (2点目確定クリックの邪魔をしないよう、壁描画の途中では行わない)。壁・ドアは
      // 選択の対象にせず、常に新しい壁/ドアの描画開始として扱う(角から生やせるように)。
      const hit = findItemAt(raw);
      if (hit && (hit.kind === "object" || hit.kind === "robot")) {
        const same =
          selectedItem &&
          selectedItem.kind === hit.kind &&
          (hit.kind === "robot" || selectedItem.index === hit.index);
        if (same) {
          deselectItem();
        } else {
          selectItem(hit);
        }
        return;
      }
      deselectItem();
    }

    const mode = drawMode();
    const label = mode === "door" ? "ドア" : "壁";

    if (!pendingStart) {
      pendingStart = point;
      statusText.textContent = `もう一度クリックで${label}の終点を確定 (Escでキャンセル)`;
    } else {
      if (point.x !== pendingStart.x || point.y !== pendingStart.y) {
        const segment = {
          x1: pendingStart.x,
          y1: pendingStart.y,
          x2: point.x,
          y2: point.y,
          thickness: wallThickness(),
        };
        if (mode === "door") {
          doors.push(segment);
        } else {
          walls.push(segment);
        }
      }
      pendingStart = null;
      statusText.textContent = `壁: ${walls.length}本 / ドア: ${doors.length}個 / クリックで${label}の始点、もう一度クリックで終点`;
    }
    draw();
  }

  function handleMouseDown(evt) {
    if (evt.button !== 0) return; // 左クリックのみ

    if (evt.shiftKey) {
      // Shift+ドラッグでパン(視点移動)。配置中/壁描画中でも優先する。
      const rect = canvas.getBoundingClientRect();
      panDragState = {
        startX: evt.clientX - rect.left,
        startY: evt.clientY - rect.top,
        startPanX: panX,
        startPanY: panY,
      };
      suppressNextClick = true; // Shiftを押しての操作は配置/壁描画のクリックとして扱わない
      canvas.style.cursor = "grabbing";
      return;
    }

    if (selectedEntry || pendingStart || robotPlacementArmed) return; // 配置中/壁描画中はドラッグ移動を扱わない

    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(evt.clientX - rect.left, evt.clientY - rect.top);
    const hit = findItemAt(world);
    if (!hit) return;

    if (hit.kind === "robot") {
      dragState = { kind: "robot", grab: world, orig: { x: robotPose.x, y: robotPose.y } };
      return;
    }

    const item = arrayForKind(hit.kind)[hit.index];
    dragState = {
      kind: hit.kind,
      index: hit.index,
      grab: world,
      orig:
        hit.kind === "object"
          ? { x: item.x, y: item.y }
          : { x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2 },
    };
  }

  function handleMouseMove(evt) {
    const rect = canvas.getBoundingClientRect();
    mouseWorld = screenToWorld(evt.clientX - rect.left, evt.clientY - rect.top);

    if (panDragState) {
      const curX = evt.clientX - rect.left;
      const curY = evt.clientY - rect.top;
      const ppm = pixelsPerMeter();
      panX = panDragState.startPanX + (curX - panDragState.startX) / ppm;
      panY = panDragState.startPanY - (curY - panDragState.startY) / ppm;
      draw();
      return;
    }

    if (dragState) {
      const dx = mouseWorld.x - dragState.grab.x;
      const dy = mouseWorld.y - dragState.grab.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_M) {
        suppressNextClick = true; // 実際に動かした場合だけ、この後のclickでの新規配置/壁描画を止める
      }
      if (dragState.kind === "robot") {
        const snapped = snapPoint({ x: dragState.orig.x + dx, y: dragState.orig.y + dy });
        robotPose.x = snapped.x;
        robotPose.y = snapped.y;
        draw();
        return;
      }
      const item = arrayForKind(dragState.kind)[dragState.index];
      if (dragState.kind === "object") {
        const snapped = snapPoint({ x: dragState.orig.x + dx, y: dragState.orig.y + dy });
        item.x = snapped.x;
        item.y = snapped.y;
      } else {
        item.x1 = dragState.orig.x1 + dx;
        item.y1 = dragState.orig.y1 + dy;
        item.x2 = dragState.orig.x2 + dx;
        item.y2 = dragState.orig.y2 + dy;
      }
      draw();
      return;
    }

    if (selectedEntry) {
      if (selectedEntryData) {
        const stackBase = findStackBase(snapPoint(mouseWorld));
        catalogPreviewStatus.textContent = stackBase
          ? `「${stackBase.obj.name}」の上に配置: クリックで確定 (Escで解除)`
          : `クリックして配置 (Escで解除)`;
      }
      draw();
    } else if (robotPlacementArmed) {
      statusText.textContent = "クリックでロボット開始位置を配置 (Escでキャンセル・スクロールで回転)";
      draw();
    } else if (pendingStart) {
      draw();
    }
  }

  function handleMouseUp() {
    dragState = null;
    if (panDragState) {
      panDragState = null;
      canvas.style.cursor = "crosshair";
    }
  }

  function handleWheel(evt) {
    evt.preventDefault();

    if (selectedEntry || robotPlacementArmed) {
      // OneStageROS(RobotBuilder)と同じ挙動: 配置中はスクロールで回転する。
      let rad = objectRotationRad() - evt.deltaY * 0.004;
      objectRotationInput.value = Math.round((rad * 180) / Math.PI);
      draw();
      return;
    }

    if (selectedItem && selectedItem.kind === "object") {
      // 配置中と同様、選択済みオブジェクトもスクロールでその場で回転できるようにする。
      const obj = objects[selectedItem.index];
      obj.yaw -= evt.deltaY * 0.004;
      objectRotationInput.value = Math.round((obj.yaw * 180) / Math.PI);
      draw();
      return;
    }

    if (selectedItem && selectedItem.kind === "robot") {
      robotPose.yaw -= evt.deltaY * 0.004;
      objectRotationInput.value = Math.round((robotPose.yaw * 180) / Math.PI);
      draw();
      return;
    }

    // それ以外は常にズーム(カーソル位置を中心に拡大縮小する)。
    const rect = canvas.getBoundingClientRect();
    const sx = evt.clientX - rect.left;
    const sy = evt.clientY - rect.top;
    const worldBefore = screenToWorld(sx, sy);

    const factor = Math.exp(-evt.deltaY * 0.001);
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));

    // カーソル位置のワールド座標がズーム前後で画面上の同じ位置に留まるようパンを補正する。
    const worldAfter = screenToWorld(sx, sy);
    panX += worldAfter.x - worldBefore.x;
    panY += worldAfter.y - worldBefore.y;

    draw();
  }

  function handleContextMenu(evt) {
    evt.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(evt.clientX - rect.left, evt.clientY - rect.top);
    const hit = findItemAt(world);
    if (!hit) return;

    if (hit.kind === "robot") {
      robotPose = null;
      deselectItem();
      statusText.textContent = "ロボット開始位置を削除しました";
      draw();
      return;
    }

    const arr = arrayForKind(hit.kind);
    const removed = arr.splice(hit.index, 1)[0];
    // 削除で配列の添字がずれるため、選択中のインデックスが指す先が変わってしまう。
    // どのアイテムを消しても選択状態は一律クリアする(安全側に倒す)。
    deselectItem();
    statusText.textContent = `${itemLabel(hit.kind, removed)}を削除しました`;
    draw();
  }

  function closePreview() {
    if (previewModal.hidden) return;
    previewModal.hidden = true;
    if (window.BuildingEditorPreview) window.BuildingEditorPreview.close();
  }

  function openPreview() {
    if (!window.BuildingEditorPreview) {
      statusText.textContent = "3Dプレビューの読み込みに失敗しています(preview.js)。";
      return;
    }
    previewModal.hidden = false;
    window.BuildingEditorPreview.open(walls, doors, objects, {
      wallHeight: Math.max(0.1, parseFloat(wallHeightInput.value) || 2.5),
      doorHeight: doorHeight(),
    });
  }

  function handleKeyDown(evt) {
    if (evt.key !== "Escape") return;
    if (!exportMenu.hidden) {
      closeExportMenu();
    } else if (!previewModal.hidden) {
      closePreview();
    } else if (dragState) {
      if (dragState.kind === "robot") {
        robotPose.x = dragState.orig.x;
        robotPose.y = dragState.orig.y;
      } else {
        const item = arrayForKind(dragState.kind)[dragState.index];
        Object.assign(item, dragState.orig);
      }
      dragState = null;
      draw();
    } else if (robotPlacementArmed) {
      robotPlacementArmed = false;
      statusText.textContent = "キャンセルしました";
      draw();
    } else if (selectedEntry) {
      selectedEntry = null;
      selectedEntryData = null;
      selectedEntryError = null;
      if (focusedEntry) catalogPreviewStatus.textContent = "";
      renderCatalog(catalogSearch.value);
      draw();
    } else if (focusedEntry) {
      clearFocus();
    } else if (pendingStart) {
      pendingStart = null;
      statusText.textContent = "キャンセルしました / クリックで壁の始点";
      draw();
    } else if (selectedItem) {
      deselectItem();
    }
  }

  function cancelPending() {
    pendingStart = null;
    draw();
  }

  async function loadCatalog() {
    try {
      const res = await fetch("/api/catalog");
      if (!res.ok) throw new Error("failed to load catalog");
      catalog = await res.json();
      renderCatalog("");
      statusText.textContent = `オブジェクトカタログ: ${catalog.length}件`;
    } catch (e) {
      statusText.textContent = `カタログの読み込みに失敗しました: ${e}`;
    }
  }

  window.addEventListener("resize", resizeCanvas);
  canvas.addEventListener("click", handleClick);
  canvas.addEventListener("mousedown", handleMouseDown);
  canvas.addEventListener("mousemove", handleMouseMove);
  canvas.addEventListener("mouseup", handleMouseUp);
  canvas.addEventListener("contextmenu", handleContextMenu);
  canvas.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("keydown", handleKeyDown);
  gridSizeInput.addEventListener("change", draw);
  catalogSearch.addEventListener("input", () => renderCatalog(catalogSearch.value));
  catalogPlaceBtn.addEventListener("click", armPlacementFromPreview);
  catalogCacheBtn.addEventListener("click", cacheFromPreview);
  previewBtn.addEventListener("click", openPreview);
  previewCloseBtn.addEventListener("click", closePreview);
  drawModeWallRadio.addEventListener("change", cancelPending);
  drawModeDoorRadio.addEventListener("change", cancelPending);
  objectHeightInput.addEventListener("input", () => {
    // オブジェクトを選択中はこの欄がそのオブジェクトの高さそのものを表す(置いてから高さを決めたい、に対応)。
    // 何も選択していなければ、従来通り次に配置するオブジェクトの上乗せ分として使われる。
    if (selectedItem && selectedItem.kind === "object") {
      const obj = objects[selectedItem.index];
      obj.z = parseFloat(objectHeightInput.value) || 0;
      draw();
    }
  });
  objectRotationInput.addEventListener("input", () => {
    // 同様に、オブジェクト/ロボット選択中はこの欄がその向きそのものを表す。
    if (selectedItem && selectedItem.kind === "object") {
      const obj = objects[selectedItem.index];
      obj.yaw = objectRotationRad();
      draw();
    } else if (selectedItem && selectedItem.kind === "robot") {
      robotPose.yaw = objectRotationRad();
      draw();
    }
  });

  robotBtn.addEventListener("click", () => {
    robotPlacementArmed = true;
    selectedEntry = null;
    selectedEntryData = null;
    selectedEntryError = null;
    pendingStart = null;
    deselectItem();
    statusText.textContent = "クリックでロボット開始位置を配置 (Escでキャンセル・スクロールで回転)";
    renderCatalog(catalogSearch.value);
    draw();
  });

  clearBtn.addEventListener("click", () => {
    walls.length = 0;
    doors.length = 0;
    objects.length = 0;
    robotPose = null;
    robotPlacementArmed = false;
    pendingStart = null;
    selectedItem = null;
    objectHeightInput.value = "0";
    statusText.textContent = "クリアしました / クリックで壁の始点";
    draw();
  });

  function hasAnythingToExport() {
    return walls.length > 0 || doors.length > 0 || objects.length > 0;
  }

  function exportOptions() {
    return {
      wallHeight: Math.max(0.1, parseFloat(wallHeightInput.value) || 2.5),
      doorHeight: doorHeight(),
      robotPose,
    };
  }

  function summaryText() {
    return `壁 ${walls.length}本 / ドア ${doors.length}個 / オブジェクト ${objects.length}件`;
  }

  function closeExportMenu() {
    exportMenu.hidden = true;
  }

  exportBtn.addEventListener("click", (evt) => {
    evt.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });

  document.addEventListener("click", () => closeExportMenu());
  exportMenu.addEventListener("click", (evt) => evt.stopPropagation());

  exportSdfItem.addEventListener("click", () => {
    closeExportMenu();
    if (!hasAnythingToExport()) {
      statusText.textContent = "壁もドアもオブジェクトもありません。先に配置してください。";
      return;
    }
    const sdf = window.BuildingEditorExport.wallsToSDF(walls, doors, objects, exportOptions());
    window.BuildingEditorExport.downloadSDF(sdf, "building.sdf");
    statusText.textContent = `SDFをダウンロードしました (${summaryText()})`;
  });

  exportWbtItem.addEventListener("click", () => {
    closeExportMenu();
    if (!hasAnythingToExport()) {
      statusText.textContent = "壁もドアもオブジェクトもありません。先に配置してください。";
      return;
    }
    const wbt = window.BuildingEditorExport.wallsToWBT(walls, doors, objects, exportOptions());
    window.BuildingEditorExport.downloadWBT(wbt, "building.wbt");
    statusText.textContent = `Webots(.wbt)をダウンロードしました (${summaryText()})`;
  });

  exportBothItem.addEventListener("click", () => {
    closeExportMenu();
    if (!hasAnythingToExport()) {
      statusText.textContent = "壁もドアもオブジェクトもありません。先に配置してください。";
      return;
    }
    const options = exportOptions();
    const sdf = window.BuildingEditorExport.wallsToSDF(walls, doors, objects, options);
    const wbt = window.BuildingEditorExport.wallsToWBT(walls, doors, objects, options);
    window.BuildingEditorExport.downloadZip(
      [
        { name: "building.sdf", text: sdf },
        { name: "building.wbt", text: wbt },
      ],
      "building.zip"
    );
    statusText.textContent = `SDF+Webotsをzipでダウンロードしました (${summaryText()})`;
  });

  resizeCanvas();
  loadCatalog();
})();
