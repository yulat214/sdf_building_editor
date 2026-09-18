// Converts wall segments (meters) into an Ignition Gazebo world SDF string.
(() => {
  function segmentToModelXml(segment, index, height, options) {
    const { namePrefix = "wall", diffuse = "0.8 0.8 0.8 1" } = options || {};
    const dx = segment.x2 - segment.x1;
    const dy = segment.y2 - segment.y1;
    const length = Math.hypot(dx, dy);
    const yaw = Math.atan2(dy, dx);
    const cx = (segment.x1 + segment.x2) / 2;
    const cy = (segment.y1 + segment.y2) / 2;
    const cz = height / 2;

    return `    <model name="${namePrefix}_${index}">
      <static>true</static>
      <pose>${cx.toFixed(4)} ${cy.toFixed(4)} ${cz.toFixed(4)} 0 0 ${yaw.toFixed(6)}</pose>
      <link name="link">
        <collision name="collision">
          <geometry>
            <box>
              <size>${length.toFixed(4)} ${segment.thickness.toFixed(4)} ${height.toFixed(4)}</size>
            </box>
          </geometry>
        </collision>
        <visual name="visual">
          <geometry>
            <box>
              <size>${length.toFixed(4)} ${segment.thickness.toFixed(4)} ${height.toFixed(4)}</size>
            </box>
          </geometry>
          <material>
            <ambient>${diffuse}</ambient>
            <diffuse>${diffuse}</diffuse>
          </material>
        </visual>
      </link>
    </model>`;
  }

  function wallToModelXml(wall, index, wallHeight) {
    return segmentToModelXml(wall, index, wallHeight, { namePrefix: "wall" });
  }

  function doorToModelXml(door, index, doorHeight) {
    return segmentToModelXml(door, index, doorHeight, {
      namePrefix: "door",
      diffuse: "0.8 0.55 0.25 1",
    });
  }

  function xmlEscape(s) {
    return String(s).replace(/[<>&"']/g, (c) => ({
      "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
    }[c]));
  }

  function slugify(name) {
    return String(name).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "object";
  }

  function objectToModelXml(obj, index) {
    const [sx, sy, sz] = obj.scale || [1, 1, 1];
    // objの高さ(机の上などに置いた場合の底上げ)+ メッシュ自体のフットプリント上のz_offset
    // (メッシュのローカル原点が底面にあるとは限らないための補正)を両方足す。
    const z = (obj.z || 0) + ((obj.footprint && obj.footprint.z_offset) || 0);
    const hasTexture = obj.texturePaths && obj.texturePaths.length > 0;
    // .objが自前でmtllibを埋め込んでいる(=obj.mtlUrlがある)場合や、テクスチャがある場合は
    // メッシュ自身の色情報に任せ、material要素で上書きしない(パーツごとの色が潰れてしまうため)。
    // どちらも無ければbaseColorのフォールバック(無地の灰色よりは実物に近い)を明示する。
    const materialXml =
      obj.mtlUrl || hasTexture
        ? ""
        : (() => {
            const [br, bg, bb] = obj.baseColor || [0.8, 0.8, 0.8];
            return `          <material>
            <ambient>${br} ${bg} ${bb} 1</ambient>
            <diffuse>${br} ${bg} ${bb} 1</diffuse>
          </material>
`;
          })();
    return `    <model name="obj_${index}_${slugify(obj.name)}">
      <static>true</static>
      <pose>${obj.x.toFixed(4)} ${obj.y.toFixed(4)} ${z.toFixed(4)} 0 0 ${obj.yaw.toFixed(6)}</pose>
      <link name="link">
        <visual name="visual">
          <geometry>
            <mesh>
              <uri>file://${xmlEscape(obj.meshPath)}</uri>
              <scale>${sx} ${sy} ${sz}</scale>
            </mesh>
          </geometry>
${materialXml}        </visual>
      </link>
    </model>`;
  }

  // OneStageROS(assets-server.js)は<world>直下の name="spawn"(またはname="robot")の
  // モデルを「見た目を持たないロボット配置マーカー」として認識し、<pose>だけをロボットの
  // 初期姿勢として拾う(可視オブジェクトとしては描画しない、という既存の規約)。
  // building_editor側で改修することなく、この規約に沿ったモデルを出すだけで良い。
  function spawnModelXml(robotPose) {
    if (!robotPose) return "";
    return `    <model name="spawn">
      <static>true</static>
      <pose>${robotPose.x.toFixed(4)} ${robotPose.y.toFixed(4)} 0 0 0 ${robotPose.yaw.toFixed(6)}</pose>
    </model>
`;
  }

  function wallsToSDF(walls, doors, objects, options) {
    const { worldName = "building_editor_world", wallHeight = 2.5, doorHeight = 2.0, robotPose = null } = options || {};
    doors = doors || [];
    objects = objects || [];
    const wallModels = walls
      .map((w, i) => wallToModelXml(w, i, wallHeight))
      .join("\n");
    const doorModels = doors
      .map((d, i) => doorToModelXml(d, i, doorHeight))
      .join("\n");
    const objectModels = objects.map((o, i) => objectToModelXml(o, i)).join("\n");
    const spawnModel = spawnModelXml(robotPose);

    return `<?xml version="1.0" ?>
<sdf version="1.7">
  <world name="${worldName}">
    <physics name="1ms" type="ignored">
      <max_step_size>0.001</max_step_size>
      <real_time_factor>1.0</real_time_factor>
    </physics>
    <plugin filename="gz-sim-physics-system" name="gz::sim::systems::Physics"></plugin>
    <plugin filename="gz-sim-scene-broadcaster-system" name="gz::sim::systems::SceneBroadcaster"></plugin>
    <plugin filename="gz-sim-user-commands-system" name="gz::sim::systems::UserCommands"></plugin>
    <plugin filename="gz-sim-sensors-system" name="gz::sim::systems::Sensors">
      <render_engine>ogre2</render_engine>
    </plugin>

    <light type="directional" name="sun">
      <cast_shadows>true</cast_shadows>
      <pose>0 0 10 0 0 0</pose>
      <diffuse>0.8 0.8 0.8 1</diffuse>
      <specular>0.2 0.2 0.2 1</specular>
      <attenuation>
        <range>1000</range>
        <constant>0.9</constant>
        <linear>0.01</linear>
        <quadratic>0.001</quadratic>
      </attenuation>
      <direction>-0.5 0.1 -0.9</direction>
    </light>

    <model name="ground_plane">
      <static>true</static>
      <link name="link">
        <collision name="collision">
          <geometry>
            <plane>
              <normal>0 0 1</normal>
              <size>100 100</size>
            </plane>
          </geometry>
        </collision>
        <visual name="visual">
          <geometry>
            <plane>
              <normal>0 0 1</normal>
              <size>100 100</size>
            </plane>
          </geometry>
          <material>
            <ambient>0.8 0.8 0.8 1</ambient>
            <diffuse>0.8 0.8 0.8 1</diffuse>
          </material>
        </visual>
      </link>
    </model>

${wallModels}
${doorModels}
${objectModels}
${spawnModel}  </world>
</sdf>
`;
  }

  function downloadSDF(sdfText, filename) {
    const blob = new Blob([sdfText], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --- Webots (.wbt) export ---
  // SDF版と全く同じ x=x, y=y, z=height の意味で座標を書けるよう、
  // WorldInfo.coordinateSystem を明示的に "ENU"（Z-up。Webots R2022a以降で選択可能）に固定する。
  // 未検証: 実際にWebotsで読み込み、壁の位置・向き・高さがSDF版と一致するか確認すること。
  // ズレる場合はここの座標系解釈（ENUの軸の割り当て）を疑うこと。
  function segmentToSolidWbt(segment, index, height, options) {
    const { namePrefix = "wall", baseColor = "0.8 0.8 0.8" } = options || {};
    const dx = segment.x2 - segment.x1;
    const dy = segment.y2 - segment.y1;
    const length = Math.hypot(dx, dy);
    const yaw = Math.atan2(dy, dx);
    const cx = (segment.x1 + segment.x2) / 2;
    const cy = (segment.y1 + segment.y2) / 2;
    const cz = height / 2;

    return `  Solid {
    translation ${cx.toFixed(4)} ${cy.toFixed(4)} ${cz.toFixed(4)}
    rotation 0 0 1 ${yaw.toFixed(6)}
    name "${namePrefix}_${index}"
    children [
      Shape {
        appearance PBRAppearance {
          baseColor ${baseColor}
          roughness 1
          metalness 0
        }
        geometry Box {
          size ${length.toFixed(4)} ${segment.thickness.toFixed(4)} ${height.toFixed(4)}
        }
      }
    ]
    boundingObject Box {
      size ${length.toFixed(4)} ${segment.thickness.toFixed(4)} ${height.toFixed(4)}
    }
  }`;
  }

  function wallToSolidWbt(wall, index, wallHeight) {
    return segmentToSolidWbt(wall, index, wallHeight, { namePrefix: "wall" });
  }

  function doorToSolidWbt(door, index, doorHeight) {
    return segmentToSolidWbt(door, index, doorHeight, {
      namePrefix: "door",
      baseColor: "0.8 0.55 0.25",
    });
  }

  // 取り込んだメッシュの実サイズは分からないので、boundingObjectは実用上困らない
  // 固定サイズのBoxで簡易対応する(衝突判定の精度より、配置と見た目の再現を優先)。
  const OBJECT_BOUNDING_BOX_SIZE = 0.4;

  function objectToSolidWbt(obj, index) {
    const hasTexture = obj.texturePaths && obj.texturePaths.length > 0;
    // WebotsのMesh/ImageTextureのurlは file:// スキームを認識しない(SDFの<uri>とは別物)。
    // file://を付けると「絶対パスではない」と判定され、ワールドファイル自身のディレクトリを
    // 先頭にくっつけて相対パス解決しようとし、結果パスが壊れて読み込めなくなる
    // (実際にWebotsで確認: file:///root/objects/... を書いたら
    // "/root/practice_ws/worlds/file:/root/objects/..." のように誤って結合された)。
    // 素の絶対パス("/root/objects/...")のまま渡すのが正しい。
    // SDF/OneStageROS(three.js)は.objのmtllibや.daeの埋め込みマテリアルを自動で読むが、
    // WebotsのMeshノードはジオメトリのみを取り込み、mtllib/埋め込みマテリアルは一切読まない
    // (appearanceを明示しない限り既定の無地になる)。実際に確認済み: appearanceを省略した
    // オブジェクト(mtlUrlありのため省略していた)は軒並み真っ白になった。そのため
    // WBT側は mtlUrl の有無に関わらず、テクスチャがあれば必ず明示のappearanceを付ける。
    const appearanceLine = hasTexture
      ? `        appearance PBRAppearance {
          baseColorMap ImageTexture {
            url [ "${obj.texturePaths[0]}" ]
          }
          roughness 1
          metalness 0
        }
`
      : (() => {
          const [br, bg, bb] = obj.baseColor || [0.8, 0.8, 0.8];
          return `        appearance PBRAppearance {
          baseColor ${br} ${bg} ${bb}
          roughness 1
          metalness 0
        }
`;
        })();

    const [sx, sy, sz] = obj.scale || [1, 1, 1];
    // objの高さ(机の上などに置いた場合の底上げ)+ メッシュ自体のフットプリント上のz_offset
    // (メッシュのローカル原点が底面にあるとは限らないための補正)を両方足す。
    const z = (obj.z || 0) + ((obj.footprint && obj.footprint.z_offset) || 0);

    return `  Solid {
    translation ${obj.x.toFixed(4)} ${obj.y.toFixed(4)} ${z.toFixed(4)}
    rotation 0 0 1 ${obj.yaw.toFixed(6)}
    name "obj_${index}_${slugify(obj.name)}"
    children [
      Transform {
        scale ${sx} ${sy} ${sz}
        children [
          Shape {
${appearanceLine}            geometry Mesh {
              url [ "${obj.meshPath}" ]
            }
          }
        ]
      }
    ]
    boundingObject Box {
      size ${OBJECT_BOUNDING_BOX_SIZE} ${OBJECT_BOUNDING_BOX_SIZE} ${OBJECT_BOUNDING_BOX_SIZE}
    }
  }`;
  }

  // 固定100x100だと、小さな部屋1つだけの典型的なシーンでも床が巨大な平原のようになってしまう。
  // 壁・ドア・オブジェクトの配置範囲から、実際のシーンに見合ったサイズを決める。
  function computeWbtFloorSize(walls, doors, objects) {
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
    if (xs.length === 0) return 20; // 何も配置されていない場合の既定サイズ
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return Math.max(10, Math.ceil(span + 10)); // 周囲に5m程度の余白、最低10m四方
  }

  // turtlebot3_lime_webots は clone 先ごとにパスが変わり得るが、このツールを使う教室環境では
  // 固定なので、絶対パスで決め打ちする(相対パスだと保存先によって壊れるため。実際に確認済み)。
  const TURTLEBOT3_LIME_PROTO_PATH =
    "/root/webots_ws/src/turtlebot3_lime_webots/protos/Turtlebot3Lime.proto";

  function robotExternProto(robotPose) {
    if (!robotPose) return "";
    return `EXTERNPROTO "${TURTLEBOT3_LIME_PROTO_PATH}"\n`;
  }

  function robotNodeWbt(robotPose) {
    if (!robotPose) return "";
    // translationのzは turtlebot3_lime_test.wbt の実例(0 0 0.002)に合わせ、
    // 起動直後に床へめり込まないよう少し浮かせる。
    return `Turtlebot3Lime {
  translation ${robotPose.x.toFixed(4)} ${robotPose.y.toFixed(4)} 0.002
  rotation 0 0 1 ${robotPose.yaw.toFixed(6)}
  controller "<extern>"
  controllerArgs [
    ""
  ]
}
`;
  }

  function wallsToWBT(walls, doors, objects, options) {
    const { worldName = "building_editor_world", wallHeight = 2.5, doorHeight = 2.0, robotPose = null } = options || {};
    doors = doors || [];
    objects = objects || [];
    const wallSolids = walls.map((w, i) => wallToSolidWbt(w, i, wallHeight)).join("\n");
    const doorSolids = doors.map((d, i) => doorToSolidWbt(d, i, doorHeight)).join("\n");
    const objectSolids = objects.map((o, i) => objectToSolidWbt(o, i)).join("\n");
    const floorSize = computeWbtFloorSize(walls, doors, objects);
    const externProto = robotExternProto(robotPose);
    const robotNode = robotNodeWbt(robotPose);

    return `#VRML_SIM R2023b utf8
${externProto}
# building_editor から書き出したワールド。
# SDF版(building.sdf)と同一座標になるよう coordinateSystem を ENU(Z-up) に固定している。
# 要検証: Webotsで開いて壁の位置・向きがSDF版と一致するか確認すること。
#
# 背景・床は Webots公式カタログの PROTO(TexturedBackground/Floor 等)ではなく、
# あえて組み込みノード(Background/DirectionalLight/Plane)だけで組んでいる。理由は2つ:
#   1. 無地の背景にしたい(写実的な空のPROTOは今回不要)
#   2. PROTOを使うと EXTERNPROTO 宣言が必須になり(Webots R2022b以降)、
#      かつ実行時にraw.githubusercontent.comへネットワーク接続が必要になる。
#      壁・ドアと同じく、このツールの他の部分は完結性を優先しているので合わせる。

WorldInfo {
  coordinateSystem "ENU"
  title "${worldName}"
}
Viewpoint {
  orientation -0.3 0.3 0.9 1.7
  position -5 -5 8
}
Background {
  skyColor [ 0.6 0.6 0.6 ]
}
DirectionalLight {
  direction 0.3 -0.5 -0.6
  intensity 1.5
}
Solid {
  name "floor"
  children [
    Shape {
      appearance PBRAppearance {
        baseColor 0.85 0.85 0.85
        roughness 1
        metalness 0
      }
      geometry Plane {
        size ${floorSize} ${floorSize}
      }
    }
  ]
  boundingObject Plane {
    size ${floorSize} ${floorSize}
  }
}
${wallSolids}
${doorSolids}
${objectSolids}
${robotNode}`;
  }

  function downloadWBT(wbtText, filename) {
    const blob = new Blob([wbtText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --- 「両方(zip)」用の最小限のZIP書き出し ---
  // 外部ライブラリに頼らず、無圧縮(store方式)のZIPを直接組み立てる。
  // 中身はテキスト2ファイルだけなので圧縮の必要は薄く、CDN依存を増やさずに済む。
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makeZip(files) {
    // files: [{ name, text }]
    const encoder = new TextEncoder();
    const chunks = [];
    const centralChunks = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = encoder.encode(file.text);
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0, true);
      local.setUint16(8, 0, true); // method 0 = store(無圧縮)
      local.setUint16(10, 0, true);
      local.setUint16(12, 0, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);

      chunks.push(new Uint8Array(local.buffer), nameBytes, data);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, 0, true);
      central.setUint16(14, 0, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, data.length, true);
      central.setUint32(24, data.length, true);
      central.setUint16(28, nameBytes.length, true);
      central.setUint16(30, 0, true);
      central.setUint16(32, 0, true);
      central.setUint16(34, 0, true);
      central.setUint16(36, 0, true);
      central.setUint32(38, 0, true);
      central.setUint32(42, offset, true);

      centralChunks.push(new Uint8Array(central.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralStart = offset;
    const centralSize = centralChunks.reduce((sum, c) => sum + c.length, 0);

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralStart, true);
    end.setUint16(20, 0, true);

    return new Blob([...chunks, ...centralChunks, new Uint8Array(end.buffer)], {
      type: "application/zip",
    });
  }

  function downloadZip(files, filename) {
    const blob = makeZip(files);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  window.BuildingEditorExport = {
    wallsToSDF,
    downloadSDF,
    wallsToWBT,
    downloadWBT,
    downloadZip,
  };
})();
