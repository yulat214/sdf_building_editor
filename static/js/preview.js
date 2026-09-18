import * as THREE from "three";
import { OrbitControls } from "/static/vendor/three/controls/OrbitControls.js";
import { OBJLoader } from "/static/vendor/three/loaders/OBJLoader.js";
import { MTLLoader } from "/static/vendor/three/loaders/MTLLoader.js";
import { ColladaLoader } from "/static/vendor/three/loaders/ColladaLoader.js";

// building_editorの2Dキャンバス(walls/doors/objects)を、読み取り専用の3Dシーンとして
// 都度作り直して表示するプレビュー。export.jsのSDF/WBT生成と同じ座標の考え方(world Z-up、
// yawはZ軸回りの回転)をそのまま踏襲する。

const WALL_COLOR = 0xcccccc;
const DOOR_COLOR = 0xcc8c40;
const DEFAULT_OBJECT_COLOR = 0x9a9a9a;
const FALLBACK_BOX_COLOR = 0x5fb0ff;
const FALLBACK_BOX_HEIGHT = 0.5;

let scene, camera, renderer, controls;
let animationHandle = null;
const disposables = []; // このプレビューで作った geometry/material/texture をまとめて破棄する

function segmentGeometry(seg) {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  return {
    length: Math.hypot(dx, dy),
    yaw: Math.atan2(dy, dx),
    cx: (seg.x1 + seg.x2) / 2,
    cy: (seg.y1 + seg.y2) / 2,
  };
}

function track(x) {
  disposables.push(x);
  return x;
}

function addSegmentBox(seg, height, colorHex) {
  const { length, yaw, cx, cy } = segmentGeometry(seg);
  const geometry = track(new THREE.BoxGeometry(length, seg.thickness, height));
  const material = track(new THREE.MeshStandardMaterial({ color: colorHex }));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(cx, cy, height / 2);
  mesh.rotation.z = yaw;
  scene.add(mesh);
}

function addFallbackBox(obj) {
  const fp = obj.footprint || { width: 0.4, depth: 0.4 };
  const geometry = track(
    new THREE.BoxGeometry(fp.width, fp.depth, FALLBACK_BOX_HEIGHT)
  );
  const material = track(
    new THREE.MeshStandardMaterial({
      color: FALLBACK_BOX_COLOR,
      transparent: true,
      opacity: 0.5,
    })
  );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(obj.x, obj.y, (obj.z || 0) + FALLBACK_BOX_HEIGHT / 2);
  mesh.rotation.z = obj.yaw;
  scene.add(mesh);
}

function applyGroupOrientation(group, obj) {
  // メッシュファイルは元の縮尺のまま(mm単位など)保存されていることがあり、
  // obj.scale(model.sdfの<mesh><scale>等から検出したもの)を掛けて実寸に直す。
  // footprint.z_offset側は既にこのscaleを反映済みの値(main.py側でscale適用後)なので、
  // 描画スケールと位置の両方に同じscaleが効くようにこの順で設定する。
  // ColladaLoaderは<asset><unit meter="..."> を読んでscene.scaleに単位変換スケールを
  // 既に設定していることがある(例: センチメートル単位のDAEはscale=0.01)ため、
  // set ではなく既存スケールに乗算する(setで上書きすると単位変換が消えて100倍等の
  // サイズになる。OneStageROSのaddWorldModelと同じ考え方)。
  const [sx, sy, sz] = obj.scale || [1, 1, 1];
  group.scale.x *= sx;
  group.scale.y *= sy;
  group.scale.z *= sz;

  // OBJのv行はそのままworldの(x,y,z)として扱う(WBT/SDFのMesh参照と同じ解釈)。
  // メッシュのローカル原点が底面にあるとは限らない(中心にある/オフセットがある等)ため、
  // footprint.z_offset(= -min_z*scale、メッシュ内で計算済み)で底面をちょうど置いた高さに合わせ、
  // さらにobj.z(机の上などに置いた場合の底上げ、既定0=床)を足す。
  const zOffset = (obj.z || 0) + ((obj.footprint && obj.footprint.z_offset) || 0);
  group.position.set(obj.x, obj.y, zOffset);
  group.rotation.z = obj.yaw;
  scene.add(group);
}

function forceDoubleSide(material) {
  if (Array.isArray(material)) {
    material.forEach(forceDoubleSide);
  } else if (material) {
    material.side = THREE.DoubleSide;
  }
}

function fixBrokenDaeTransparency(material) {
  // FBX由来のCOLLADA変換ツールで書き出された.daeには、<transparent>タグ無しで
  // <transparency>0</transparency>だけを持つ個体がある(実例: OpenRobotics/Armchair)。
  // ColladaLoaderはCOLLADA仕様通りに「不透明色(白,alpha=1) × transparency(0)」として
  // 解釈し、opacity=0(完全に透明=見えない)にしてしまう。エクスポータ側の意図はほぼ
  // 確実に「透明度0%=不透明」なので、opacityがちょうど0のケースは不透明に戻す
  // (ガラス等の意図的な半透明はopacityが0にはならないため誤爆しない)。
  if (Array.isArray(material)) {
    material.forEach(fixBrokenDaeTransparency);
  } else if (material && material.transparent && material.opacity === 0) {
    material.opacity = 1;
    material.transparent = false;
  }
}

function loadObjMesh(obj) {
  const finish = (group) => {
    group.traverse((child) => {
      if (child.isMesh) {
        track(child.geometry);
        if (!obj.mtlUrl && !(obj.textureUrls && obj.textureUrls.length)) {
          // mtl/テクスチャが無い場合、proto側にbaseColorが見つかっていればそれを使う
          // (無地の灰色より実物に近い色になる)。無ければ既定の灰色にフォールバックする。
          const color = obj.baseColor
            ? new THREE.Color(obj.baseColor[0], obj.baseColor[1], obj.baseColor[2])
            : DEFAULT_OBJECT_COLOR;
          child.material = track(new THREE.MeshStandardMaterial({ color }));
        }
        // 片面しかモデリングされていないメッシュがあり、見る角度によって
        // 「一部が透けて奥が見える」ように見えることがあるため、常に両面描画にする。
        forceDoubleSide(child.material);
      }
    });

    if (!obj.mtlUrl && obj.textureUrls && obj.textureUrls.length) {
      const texLoader = new THREE.TextureLoader();
      texLoader.load(obj.textureUrls[0], (texture) => {
        track(texture);
        const material = track(
          new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide })
        );
        group.traverse((child) => {
          if (child.isMesh) child.material = material;
        });
      });
    }

    applyGroupOrientation(group, obj);
  };

  const objLoader = new OBJLoader();
  if (obj.mtlUrl) {
    new MTLLoader().load(
      obj.mtlUrl,
      (materials) => {
        materials.preload();
        objLoader.setMaterials(materials);
        objLoader.load(obj.meshUrl, finish, undefined, () => addFallbackBox(obj));
      },
      undefined,
      () => {
        // mtl自体の取得に失敗しても、メッシュだけは表示できるようにする
        objLoader.load(obj.meshUrl, finish, undefined, () => addFallbackBox(obj));
      }
    );
  } else {
    objLoader.load(obj.meshUrl, finish, undefined, () => addFallbackBox(obj));
  }
}

function loadDaeMesh(obj) {
  // COLLADA(.dae)は材質・テクスチャ参照をファイル自身が持っているので、OBJのような
  // mtl/テクスチャの別扱いは不要(ColladaLoaderが同じディレクトリから解決する)。
  new ColladaLoader().load(
    obj.meshUrl,
    (result) => {
      const group = result.scene;
      // ColladaLoaderは<up_axis>がZ_UPのアセットに対し、three.jsの既定(Y-up)に合わせる
      // ため自動でX軸-90°回転を掛ける。building_editorの世界はSDF/Gazeboと同じZ-up前提
      // (壁・ドア・他オブジェクト全てZ-upで配置している)なので、この自動回転はむしろ
      // 有害(モデルが横倒しになり、床面や実寸footprintと噛み合わなくなる)。打ち消す。
      // (Y_UP/X_UPのアセットにはColladaLoaderは回転を掛けないため、この処理は無害)
      group.rotation.set(0, 0, 0);
      group.traverse((child) => {
        if (child.isMesh) {
          track(child.geometry);
          if (Array.isArray(child.material)) {
            child.material.forEach(track);
          } else if (child.material) {
            track(child.material);
          }
          // OBJ側と同じく、片面しかモデリングされていないメッシュ対策。
          forceDoubleSide(child.material);
          fixBrokenDaeTransparency(child.material);
        }
      });
      applyGroupOrientation(group, obj);
    },
    undefined,
    () => addFallbackBox(obj)
  );
}

function addObject(obj) {
  if (!obj.meshUrl) {
    addFallbackBox(obj);
    return;
  }
  const lower = obj.meshUrl.toLowerCase();
  if (lower.endsWith(".obj")) {
    loadObjMesh(obj);
  } else if (lower.endsWith(".dae")) {
    loadDaeMesh(obj);
  } else {
    // .stl等、現状のプレビューが対応していない形式は実寸ボックスで代替する。
    addFallbackBox(obj);
  }
}

function computeBounds(walls, doors, objects) {
  const xs = [];
  const ys = [];
  for (const s of [...walls, ...doors]) {
    xs.push(s.x1, s.x2);
    ys.push(s.y1, s.y2);
  }
  for (const o of objects) {
    xs.push(o.x);
    ys.push(o.y);
  }
  if (xs.length === 0) return { cx: 0, cy: 0, radius: 5 };
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const radius = Math.max(3, Math.hypot(maxX - minX, maxY - minY) / 2 + 2);
  return { cx, cy, radius };
}

function disposeScene() {
  for (const d of disposables) {
    if (d && typeof d.dispose === "function") d.dispose();
  }
  disposables.length = 0;
  if (scene) {
    while (scene.children.length) scene.remove(scene.children[0]);
  }
}

function animate() {
  animationHandle = requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function ensureInit(canvas) {
  if (renderer) return;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);

  camera = new THREE.PerspectiveCamera(55, 1, 0.05, 500);
  camera.up.set(0, 0, 1);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
}

function resizeToContainer(canvas) {
  const rect = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(rect.width, rect.height, false);
  camera.aspect = rect.width / Math.max(1, rect.height);
  camera.updateProjectionMatrix();
}

function open(walls, doors, objects, options) {
  const canvas = document.getElementById("preview-canvas");
  const { wallHeight = 2.5, doorHeight = 2.0 } = options || {};

  ensureInit(canvas);
  disposeScene();
  scene.add(new THREE.GridHelper(50, 50).rotateX(Math.PI / 2));
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8);
  sun.position.set(5, -8, 12);
  scene.add(sun);

  for (const w of walls) addSegmentBox(w, wallHeight, WALL_COLOR);
  for (const d of doors) addSegmentBox(d, doorHeight, DOOR_COLOR);
  for (const o of objects) addObject(o);

  const { cx, cy, radius } = computeBounds(walls, doors, objects);
  controls.target.set(cx, cy, 0);
  camera.position.set(cx + radius, cy - radius, radius * 0.8 + 1.5);
  camera.lookAt(cx, cy, 0);

  resizeToContainer(canvas);
  window.addEventListener("resize", () => resizeToContainer(canvas));

  if (!animationHandle) animate();
}

function close() {
  if (animationHandle) {
    cancelAnimationFrame(animationHandle);
    animationHandle = null;
  }
  disposeScene();
}

window.BuildingEditorPreview = { open, close };
