import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from PIL import Image
from pydantic import BaseModel

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

OBJECTS_DIR = Path(os.environ.get("BUILDING_EDITOR_OBJECTS_DIR", "/root/objects"))
OBJECTS_DIR.mkdir(parents=True, exist_ok=True)

MESH_EXTS = {".obj", ".dae", ".stl"}
TEXTURE_EXTS = {".png", ".jpg", ".jpeg"}
# Fuelのテクスチャは2048x2048等が標準で、1個体あたり数MB〜十数MBにもなり、
# 部屋にいくつか置くだけでブラウザの転送・GPUメモリが重くなる。building_editorは
# 部屋スケールでの配置確認が目的で写実的な近接描写は不要なため、取り込み時に縮小する。
MAX_TEXTURE_DIM = int(os.environ.get("BUILDING_EDITOR_MAX_TEXTURE_SIZE", "1024"))

USER_AGENT = "sdf_building_editor/1.0"

# --- Gazebo Fuel(https://fuel.gazebosim.org) 由来のオブジェクトカタログ ---
# 以前はWebots公式カタログのprotoを解析して取り込んでいたが、それらのアセットは
# "Licensed for use only with Webots" という制限付きライセンスで、OneStageROS等
# Webots以外での再利用は許諾範囲外だった。Fuelの GoogleResearch(Google Scanned
# Objects) / OpenRobotics コレクションは Creative Commons Attribution 4.0 (一部CC0)
# で統一されており、用途を問わず利用できる(帰属表示のみ必須)。
# 一覧・アイコンは generate_fuel_catalog.py で事前生成した fuel_catalog.json /
# static/fuel_icons/ を使う(実行時にFuelへ一覧・画像を取りに行かない)。
FUEL_API_BASE = "https://fuel.gazebosim.org/1.0"
FUEL_CATALOG_PATH = os.path.join(BASE_DIR, "fuel_catalog.json")
FUEL_ICON_DIR_NAME = "fuel_icons"


def slugify(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_")
    return slug or "object"


def object_slug(owner: str, name: str) -> str:
    # ownerを含めておくことで、異なるコレクション間での名前衝突を避ける。
    return slugify(f"{owner}_{name}")


def load_catalog():
    if not os.path.exists(FUEL_CATALOG_PATH):
        return []
    try:
        with open(FUEL_CATALOG_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    entries = []
    for e in raw:
        icon_file = e.get("icon_file")
        entries.append(
            {
                "name": e["name"],
                "owner": e["owner"],
                "category": e.get("category") or e["owner"],
                "description": e.get("description", ""),
                "license_name": e.get("license_name"),
                "license_url": e.get("license_url"),
                "icon_url": f"/static/{FUEL_ICON_DIR_NAME}/{icon_file}" if icon_file else None,
            }
        )
    entries.sort(key=lambda e: (e["owner"], e["name"]))
    return entries


CATALOG = load_catalog()
CATALOG_BY_KEY = {(e["owner"], e["name"]): e for e in CATALOG}


def fetch_binary(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def fuel_download_url(owner: str, name: str) -> str:
    q = urllib.parse.quote(name, safe="")
    return f"{FUEL_API_BASE}/{owner}/models/{q}/tip/{q}.zip"


def compute_obj_footprint(obj_path: str):
    # .objの頂点(v行)からXYZのバウンディングボックスを求める。width/depthは2Dキャンバスの
    # 実寸表示に、z_offset(= -min_z)は3Dプレビューでメッシュの底面を床(z=0)に
    # 合わせるために使う(メッシュのローカル原点が底面にあるとは限らないため、
    # 何も補正しないと床に埋まったり浮いたりする個体があった)。
    # 他形式(.dae/.stl)は未対応で、その場合はNoneを返しフロント側は固定サイズの
    # マーカー表示・z_offset=0にフォールバックする。
    min_x = min_y = min_z = float("inf")
    max_x = max_y = max_z = float("-inf")
    found = False
    with open(obj_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line.startswith("v "):
                continue
            parts = line.split()
            if len(parts) < 4:
                continue
            try:
                x, y, z = float(parts[1]), float(parts[2]), float(parts[3])
            except ValueError:
                continue
            found = True
            min_x, max_x = min(min_x, x), max(max_x, x)
            min_y, max_y = min(min_y, y), max(max_y, y)
            min_z, max_z = min(min_z, z), max(max_z, z)
    if not found:
        return None
    return {
        "width": max_x - min_x,
        "depth": max_y - min_y,
        "height": max_z - min_z,
        "z_offset": -min_z,
    }


def _local_tag(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _dae_geometry_node_scale(root):
    # <visual_scene>内で<instance_geometry>を直接持つ<node>のスケール成分を返す。
    # メッシュの生頂点データはテンプレート寸法のままで、実際の配置スケールは
    # <node>の<matrix>(または<scale>)側に掛けてあるモデルがある
    # (実例: OpenRobotics/Box target (green) は生頂点で2m四方だが、ノードのmatrixに
    # 3倍のスケールが入っていて実際は6m四方 ─ model.sdfのcollision box(6 6 2)と一致)。
    # これを無視すると footprint が実際の見た目(3Dプレビュー・エクスポート)より
    # 小さく出てしまう。回転成分があっても対応できるよう、行列の各列ベクトルの
    # 長さをスケールとみなす(列ベクトルの長さは回転では変わらない)。
    # 該当ノードが複数ある場合は最初の1つだけを使う(このファイルの他の簡略化と同様の割り切り)。
    for node in root.iter():
        if _local_tag(node.tag) != "node":
            continue
        if not any(_local_tag(c.tag) == "instance_geometry" for c in node):
            continue
        for child in node:
            tag = _local_tag(child.tag)
            if tag == "matrix" and child.text:
                try:
                    m = [float(x) for x in child.text.split()]
                except ValueError:
                    continue
                if len(m) == 16:
                    sx = (m[0] ** 2 + m[4] ** 2 + m[8] ** 2) ** 0.5
                    sy = (m[1] ** 2 + m[5] ** 2 + m[9] ** 2) ** 0.5
                    sz = (m[2] ** 2 + m[6] ** 2 + m[10] ** 2) ** 0.5
                    return (sx, sy, sz)
            elif tag == "scale" and child.text:
                try:
                    s = [float(x) for x in child.text.split()]
                except ValueError:
                    continue
                if len(s) == 3:
                    return (s[0], s[1], s[2])
        return (1.0, 1.0, 1.0)
    return (1.0, 1.0, 1.0)


def compute_dae_footprint(dae_path: str):
    # COLLADA(.dae)は<asset><up_axis>で「どの軸が上か」を宣言でき(既定Y_UP)、
    # 生の座標のままだと接地面(XY相当)がずれるため、up_axisに応じて軸を選び直す。
    # さらに<asset><unit meter="...">でメートル以外の単位系のこともあるため、その係数もかける。
    try:
        root = ET.parse(dae_path).getroot()
    except ET.ParseError:
        return None

    up_axis = "Y_UP"
    unit_meter = 1.0
    for asset in root.iter():
        if _local_tag(asset.tag) != "asset":
            continue
        for child in asset:
            tag = _local_tag(child.tag)
            if tag == "up_axis" and child.text:
                up_axis = child.text.strip()
            elif tag == "unit":
                try:
                    unit_meter = float(child.get("meter", "1.0"))
                except (TypeError, ValueError):
                    pass
        break

    node_scale = _dae_geometry_node_scale(root)
    if up_axis == "Y_UP":
        scale_a, scale_b = node_scale[0], node_scale[2]
    elif up_axis == "X_UP":
        scale_a, scale_b = node_scale[1], node_scale[2]
    else:  # Z_UP
        scale_a, scale_b = node_scale[0], node_scale[1]

    float_arrays = {}
    for src in root.iter():
        if _local_tag(src.tag) != "source":
            continue
        src_id = src.get("id")
        if not src_id:
            continue
        for fa in src:
            if _local_tag(fa.tag) == "float_array" and fa.text:
                try:
                    float_arrays[src_id] = [float(x) for x in fa.text.split()]
                except ValueError:
                    pass

    position_source_ids = set()
    for verts in root.iter():
        if _local_tag(verts.tag) != "vertices":
            continue
        for inp in verts:
            if _local_tag(inp.tag) == "input" and inp.get("semantic") == "POSITION":
                ref = (inp.get("source") or "").lstrip("#")
                if ref:
                    position_source_ids.add(ref)

    min_a = min_b = float("inf")
    max_a = max_b = float("-inf")
    found = False
    for sid in position_source_ids:
        coords = float_arrays.get(sid)
        if not coords:
            continue
        for i in range(0, len(coords) - len(coords) % 3, 3):
            x, y, z = coords[i], coords[i + 1], coords[i + 2]
            if up_axis == "Y_UP":
                a, b = x, z
            elif up_axis == "X_UP":
                a, b = y, z
            else:  # Z_UP
                a, b = x, y
            found = True
            min_a, max_a = min(min_a, a), max(max_a, a)
            min_b, max_b = min(min_b, b), max(max_b, b)

    if not found:
        return None
    return {
        "width": (max_a - min_a) * unit_meter * scale_a,
        "depth": (max_b - min_b) * unit_meter * scale_b,
    }


def compute_footprint(mesh_path: str, scale=(1.0, 1.0, 1.0)):
    lower = mesh_path.lower()
    if lower.endswith(".obj"):
        raw = compute_obj_footprint(mesh_path)
    elif lower.endswith(".dae"):
        raw = compute_dae_footprint(mesh_path)
    else:
        raw = None
    if raw is None:
        return None
    # メッシュを包むTransform{scale}(mm単位のメッシュを実寸に直す等)を反映する。
    result = {"width": raw["width"] * scale[0], "depth": raw["depth"] * scale[1]}
    if "height" in raw:
        result["height"] = raw["height"] * scale[2]
    if "z_offset" in raw:
        result["z_offset"] = raw["z_offset"] * scale[2]
    return result


def read_sdf_mesh_scale(obj_dir: Path):
    # Fuelのモデルはmm/inch単位のメッシュをそのまま同梱し、model.sdfの
    # <mesh><scale>で実寸に直す指示を持つことがある(例: OpenRobotics/Ambulanceは
    # インチ単位のメッシュ+scale 0.0254)。Google Scanned Objects系はscale無し
    # (=メートル単位のまま)のことが多いが、無ければ(1,1,1)にフォールバックする。
    sdf_path = obj_dir / "model.sdf"
    if not sdf_path.exists():
        return (1.0, 1.0, 1.0)
    try:
        root = ET.parse(sdf_path).getroot()
    except ET.ParseError:
        return (1.0, 1.0, 1.0)
    for el in root.iter():
        if _local_tag(el.tag) == "scale" and el.text:
            try:
                parts = [float(x) for x in el.text.split()]
                if len(parts) == 3:
                    return (parts[0], parts[1], parts[2])
            except ValueError:
                pass
    return (1.0, 1.0, 1.0)


SDF_MODEL_URI_PREFIX_RE = re.compile(r"^model://[^/]+/(.+)$")


def read_sdf_mesh_uri(obj_dir: Path):
    # model.sdfの最初の<mesh><uri>が、そのモデルが実際に使うべきメッシュファイルを指す。
    # 同梱ファイルを拡張子で総当たり検索すると、モデル内に紛れている無関係な旧メッシュ
    # (書き出しツールの副産物等)を誤って拾うことがある
    # (実例: OpenRobotics/OutsideBenchは未使用の旧Bench.daeを同梱しているが、
    # model.sdfが実際に指すのは別のOutsideBench.glb)。
    sdf_path = obj_dir / "model.sdf"
    if not sdf_path.exists():
        return None
    try:
        root = ET.parse(sdf_path).getroot()
    except ET.ParseError:
        return None
    for el in root.iter():
        if _local_tag(el.tag) == "uri" and el.text:
            uri = el.text.strip()
            m = SDF_MODEL_URI_PREFIX_RE.match(uri)
            return m.group(1) if m else uri
    return None


def read_scale(obj_dir: Path):
    meta_path = obj_dir / "_meta.json"
    if not meta_path.exists():
        return (1.0, 1.0, 1.0)
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
        s = data.get("scale", [1.0, 1.0, 1.0])
        return (float(s[0]), float(s[1]), float(s[2]))
    except (OSError, json.JSONDecodeError, ValueError, IndexError, TypeError):
        return (1.0, 1.0, 1.0)


def write_scale(obj_dir: Path, scale):
    meta_path = obj_dir / "_meta.json"
    meta_path.write_text(json.dumps({"scale": list(scale)}), encoding="utf-8")


def existing_object_files(obj_dir: Path):
    # Fuelのモデルは model.sdf / meshes / materials / thumbnails という階層構造なので
    # (Webnots protoの1階層フラットな取り込みと違い)、再帰的に探す。thumbnailsフォルダの
    # 画像はカタログ一覧用のプレビュー写真であってテクスチャではないため除外する。
    fallback_mesh_path = None
    texture_paths = []
    for f in sorted(obj_dir.rglob("*")):
        if not f.is_file():
            continue
        if "thumbnails" in f.relative_to(obj_dir).parts:
            continue
        ext = f.suffix.lower()
        if ext in MESH_EXTS and fallback_mesh_path is None:
            fallback_mesh_path = str(f)
        elif ext in TEXTURE_EXTS:
            texture_paths.append(str(f))

    # model.sdfが実際に指しているファイルを最優先する(上のfallback_mesh_pathは
    # model.sdfが無い/解析できない場合のみ使う)。model.sdfが対応していない形式(.glb等)を
    # 指している場合は、同梱の別形式メッシュに読み替えず「取り込めない」として扱う
    # (意図と異なる見た目のオブジェクトになるのを防ぐため)。
    sdf_uri = read_sdf_mesh_uri(obj_dir)
    if sdf_uri is None:
        mesh_path = fallback_mesh_path
    else:
        candidate = obj_dir / sdf_uri
        mesh_path = (
            str(candidate)
            if candidate.exists() and candidate.suffix.lower() in MESH_EXTS
            else None
        )

    return mesh_path, texture_paths


def to_objects_url(path: str) -> str:
    return "/objects/" + os.path.relpath(path, OBJECTS_DIR)


MTL_MAP_LINE_RE = re.compile(r"^(\s*map_\w+\s+)(.+?)\s*$", re.M)


def fix_mtl_texture_paths(obj_dir: Path, mtl_path: Path):
    # Fuel(Gazebo)のモデルは meshes/*.mtl の map_Kd 等がテクスチャをファイル名だけで
    # 参照するが、実体は meshes/ の隣ではなく materials/textures/ 配下にある
    # (Gazebo自身はこの置き場所の慣習を知っているが、three.jsのMTLLoader等は知らず、
    # mtlと同じディレクトリしか見ないため、そのままだとテクスチャが読めない)。
    # mtl中の参照を実際に存在するファイルへの相対パスに書き換える。
    text = mtl_path.read_text(encoding="utf-8", errors="replace")

    def repl(m):
        prefix, rest = m.group(1), m.group(2).strip()
        tokens = rest.split()
        if not tokens:
            return m.group(0)
        ref, options = tokens[-1], tokens[:-1]
        if (mtl_path.parent / ref).exists():
            return m.group(0)
        basename = os.path.basename(ref.replace("\\", "/"))
        for f in obj_dir.rglob(basename):
            if f.is_file():
                rel = os.path.relpath(f, mtl_path.parent)
                new_ref = " ".join(options + [rel]) if options else rel
                return f"{prefix}{new_ref}"
        return m.group(0)

    new_text = MTL_MAP_LINE_RE.sub(repl, text)
    if new_text != text:
        mtl_path.write_text(new_text, encoding="utf-8")


DAE_INIT_FROM_RE = re.compile(r"(<init_from>)\s*([^<\s][^<]*?)\s*(</init_from>)")
# <init_from>はCOLLADA中に2種類の意味で出てくる: <image>直下ではファイル名、
# <surface>直下では<image id="...">を指すID参照(ファイルではない)。IDにはファイル拡張子が
# 付かないのが通例なので、拡張子っぽい文字列で終わるものだけをファイル参照とみなして扱う
# (実例: OpenRobotics/Box target (red) は <surface><init_from>start_pad_png</init_from>
# という拡張子無しのID参照を持ち、これは書き換え対象から除外する必要がある)。
DAE_IMAGE_FILENAME_RE = re.compile(r"\.(png|jpe?g|tga|bmp|gif|tiff?)$", re.I)


def fix_dae_texture_paths(obj_dir: Path, dae_path: Path):
    # .mtlの場合(fix_mtl_texture_paths)と同じ問題がDAEにもある: <init_from>がテクスチャを
    # ファイル名だけで参照するが、実体は meshes/ の隣ではなく materials/textures/ 配下にある。
    # 参照先が実際には存在しない(壊れたアセット)場合は書き換えず、ColladaLoader側がその
    # テクスチャだけ読めずに続行するのに任せる。
    text = dae_path.read_text(encoding="utf-8", errors="replace")

    def repl(m):
        prefix, ref, suffix = m.group(1), m.group(2).strip(), m.group(3)
        if not DAE_IMAGE_FILENAME_RE.search(ref):
            return m.group(0)  # ファイル名でなくID参照等 → 触らない
        if (dae_path.parent / ref).exists():
            return m.group(0)
        basename = os.path.basename(ref.replace("\\", "/"))
        for f in obj_dir.rglob(basename):
            if f.is_file():
                rel = os.path.relpath(f, dae_path.parent)
                return f"{prefix}{rel}{suffix}"
        return m.group(0)

    new_text = DAE_INIT_FROM_RE.sub(repl, text)
    if new_text != text:
        dae_path.write_text(new_text, encoding="utf-8")


def downscale_texture_images(texture_paths, max_dim=MAX_TEXTURE_DIM):
    # Fuelのテクスチャ(Albedo/Normal/Roughness等)は2048x2048が標準で1枚2〜4MBにもなり、
    # 部屋にいくつか置くだけでブラウザの転送・GPUメモリが重くなる。building_editorは
    # 部屋スケールでの配置確認が目的で写実的な近接描写は不要なため、長辺がmax_dimを
    # 超える画像だけ縮小する(既に小さい画像は触らない・ファイル名/形式は変えない)。
    for path in texture_paths:
        try:
            with Image.open(path) as im:
                if max(im.size) <= max_dim:
                    continue
                im.thumbnail((max_dim, max_dim), Image.LANCZOS)
                im.save(path, optimize=True)
        except Exception as e:
            # 縮小に失敗しても取り込み自体は続行する(元画像のまま使われる)。
            print(f"texture downscale failed for {path}: {e}")


def ensure_texture_mtl(obj_dir: Path, mesh_path: str, texture_paths):
    # テクスチャ画像はあるが .obj が mtllib で .mtl を参照していない場合の保険
    # (Fuelのモデルは通常きちんと .mtl を持つが、稀なケースへのフォールバック)。
    # building_editorのプレビューは「mtlが無ければテクスチャ画像を直接メッシュに貼る」という
    # 特別扱いをするが、OneStageROSなど「.objのテクスチャは mtllib→.mtl→map_Kd 経由でしか
    # 貼らない」実行環境ではテクスチャが無視されて無地(灰色)になるため、これで揃える。
    if not mesh_path.lower().endswith(".obj") or not texture_paths:
        return
    obj_path = Path(mesh_path)
    obj_text = obj_path.read_text(encoding="utf-8", errors="replace")
    if re.search(r"^\s*mtllib\s+", obj_text, re.M):
        return  # 既に .mtl を参照している
    if not re.search(r"^\s*vt\s", obj_text, re.M):
        return  # UV座標が無いメッシュにmap_Kdを付けても貼れない
    tex = os.path.basename(texture_paths[0])
    mtl_name = obj_path.stem + ".mtl"

    used = []
    for m in re.finditer(r"^\s*usemtl\s+(\S+)", obj_text, re.M):
        if m.group(1) not in used:
            used.append(m.group(1))

    prepend = f"mtllib {mtl_name}\n"
    if used:
        mtl_material_names = used
    else:
        mtl_material_names = ["material0"]
        prepend += "usemtl material0\n"

    mtl_text = "".join(
        f"newmtl {n}\nKd 1 1 1\nmap_Kd {tex}\n" for n in mtl_material_names
    )
    (obj_path.parent / mtl_name).write_text(mtl_text, encoding="utf-8")
    obj_path.write_text(prepend + obj_text, encoding="utf-8")


def mesh_urls_for(mesh_path: str):
    # ブラウザ(3Dプレビュー)から直接fetchできるURL。/objects に OBJECTS_DIR を
    # そのままstatic mountしているので、meshと同じフォルダ内ならmtl・テクスチャも
    # 相対パスで解決できる(OBJLoader/MTLLoaderの前提を満たす)。
    mesh_url = to_objects_url(mesh_path)
    mtl_files = sorted(Path(mesh_path).parent.glob("*.mtl"))
    mtl_url = to_objects_url(str(mtl_files[0])) if mtl_files else None
    return mesh_url, mtl_url


def is_cached(owner: str, name: str) -> bool:
    obj_dir = OBJECTS_DIR / object_slug(owner, name)
    if not obj_dir.exists():
        return False
    mesh_path, _ = existing_object_files(obj_dir)
    return mesh_path is not None


# --- アクセス制限(OneStageROS の server/auth.js と同じ考え方) ---
# BUILDING_EDITOR_EXPOSE: false(既定)ならこのPC(127.0.0.1)からのみ。Docker のホスト機や
#   別のPCから使う場合は true にする。
# BUILDING_EDITOR_AUTH=token: 画面を開くときにトークンの入力を求める(ネットワークに公開する場合用)。
EXPOSE = re.fullmatch(r"(1|true|yes|on)", os.environ.get("BUILDING_EDITOR_EXPOSE", "").strip(), re.I) is not None
AUTH_ENABLED = os.environ.get("BUILDING_EDITOR_AUTH", "").strip().lower() == "token"

TOKEN_PATH = Path.home() / ".config" / "sdf-building-editor" / "token"
COOKIE_NAME = "building_editor_session"
COOKIE_MAX_AGE = 30 * 24 * 60 * 60
IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def is_allowed_host(host_header: str) -> bool:
    # localhost か IP アドレスでのアクセスだけを許可する(DNS rebinding 対策)。
    # 攻撃者のドメインを 127.0.0.1 に向けてこのサーバーを読み書きする攻撃では、Host が攻撃者のドメインになる。
    try:
        hostname = urllib.parse.urlsplit(f"http://{host_header}").hostname
    except ValueError:
        return False
    if not hostname:
        return False
    if hostname == "localhost" or hostname.endswith(".localhost"):
        return True
    if IPV4_RE.match(hostname):
        return True
    return ":" in hostname  # IPv6 リテラル([::1] 等。urlsplit は角括弧を外して返す)


def is_same_origin_request(request: Request) -> bool:
    # 他の Web サイトや、同じ PC の別ポート(OneStageROS 等)のページからのリクエストを拒否する。
    # ブラウザ以外(curl など)はヘッダーを偽装できるため、ネットワークからの保護は待ち受けアドレスとログインで行う。
    site = request.headers.get("sec-fetch-site")
    if site and site not in ("same-origin", "none"):
        return False
    origin = request.headers.get("origin")
    if not origin:
        return True
    try:
        return urllib.parse.urlsplit(origin).netloc == request.headers.get("host", "")
    except ValueError:
        return False


def write_token(token: str, exclusive: bool):
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    fd = os.open(TOKEN_PATH, flags, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token + "\n")


def load_or_create_token() -> str:
    try:
        token = TOKEN_PATH.read_text().strip()
        if token:
            return token
    except FileNotFoundError:
        pass
    try:
        write_token(secrets.token_urlsafe(24), exclusive=True)
    except FileExistsError:
        pass
    return TOKEN_PATH.read_text().strip()


def session_value(token: str) -> str:
    # Cookie にはトークンそのものではなく、トークンから導出した値を入れる
    return hmac.new(token.encode(), b"building-editor-session", hashlib.sha256).hexdigest()


ACCESS_TOKEN = load_or_create_token() if AUTH_ENABLED else None


def has_valid_session(request: Request) -> bool:
    if not AUTH_ENABLED:
        return True
    value = request.cookies.get(COOKIE_NAME, "")
    return hmac.compare_digest(value, session_value(ACCESS_TOKEN))


# ログインの総当たり対策(IPごとに1分あたり10回まで)
LOGIN_WINDOW_SEC = 60
LOGIN_MAX_ATTEMPTS = 10
_login_attempts = {}


def login_rate_limited(ip: str) -> bool:
    now = time.monotonic()
    recent = [t for t in _login_attempts.get(ip, []) if now - t < LOGIN_WINDOW_SEC]
    recent.append(now)
    _login_attempts[ip] = recent
    return len(recent) > LOGIN_MAX_ATTEMPTS


# ログイン無しで開けるパス(ログイン画面とログインAPIだけ)
PUBLIC_PATHS = {"/login", "/api/auth/login"}


app = FastAPI(title="Building Editor")


@app.middleware("http")
async def no_cache_static(request, call_next):
    # 演習中に更新した static(js/css/html)がブラウザキャッシュで古いまま残り、
    # 「新しいindex.html + 古いapp.js」でJSが壊れる事故を防ぐ。
    # no-cache は「使う前に必ず再検証」なので、未変更なら304で軽い。
    response = await call_next(request)
    path = request.url.path
    if path == "/":
        response.headers["Cache-Control"] = "no-store, must-revalidate"
    elif path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# no_cache_static より後に登録して外側で動かし、拒否したリクエストは中まで通さない
@app.middleware("http")
async def access_control(request: Request, call_next):
    if not (is_allowed_host(request.headers.get("host", "")) and is_same_origin_request(request)):
        return JSONResponse({"error": "Forbidden"}, status_code=403)
    path = request.url.path
    if path not in PUBLIC_PATHS and not has_valid_session(request):
        if path == "/":
            return RedirectResponse("/login", status_code=303)
        return JSONResponse({"error": "Unauthorized"}, status_code=401)
    return await call_next(request)


class LoginRequest(BaseModel):
    token: str


@app.get("/login")
def login_page():
    if not AUTH_ENABLED:
        return RedirectResponse("/", status_code=303)
    return FileResponse(os.path.join(STATIC_DIR, "login.html"), headers={"Cache-Control": "no-store"})


@app.post("/api/auth/login")
def login(req: LoginRequest, request: Request):
    if not AUTH_ENABLED:
        return {"ok": True}
    if login_rate_limited(request.client.host if request.client else ""):
        return JSONResponse({"error": "Too many attempts"}, status_code=429)
    if not hmac.compare_digest(req.token.strip().encode(), ACCESS_TOKEN.encode()):
        return JSONResponse({"error": "Invalid token"}, status_code=401)
    response = JSONResponse({"ok": True})
    response.set_cookie(
        COOKIE_NAME, session_value(ACCESS_TOKEN),
        max_age=COOKIE_MAX_AGE, path="/", httponly=True, samesite="strict",
    )
    return response


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/catalog")
def get_catalog():
    # cached はディスク上の実体の有無なので、モジュール読み込み時ではなく毎回見に行く
    # (取り込み後にカタログを開き直すと反映される)。
    return [{**e, "cached": is_cached(e["owner"], e["name"])} for e in CATALOG]


class ImportRequest(BaseModel):
    owner: str
    name: str


@app.post("/api/objects/import")
def import_object(req: ImportRequest):
    entry = CATALOG_BY_KEY.get((req.owner, req.name))
    if not entry:
        raise HTTPException(
            status_code=404, detail=f"unknown object: {req.owner}/{req.name}"
        )

    obj_dir = OBJECTS_DIR / object_slug(req.owner, req.name)

    if obj_dir.exists() and any(obj_dir.iterdir()):
        mesh_path, texture_paths = existing_object_files(obj_dir)
        if mesh_path:
            scale = read_scale(obj_dir)
            # このフィックス導入前にキャッシュされた個体も次回配置時に自己修復させる。
            downscale_texture_images(texture_paths)
            if mesh_path.lower().endswith(".dae"):
                fix_dae_texture_paths(obj_dir, Path(mesh_path))
            else:
                ensure_texture_mtl(obj_dir, mesh_path, texture_paths)
            mesh_url, mtl_url = mesh_urls_for(mesh_path)
            return {
                "name": req.name,
                "owner": req.owner,
                "mesh_path": mesh_path,
                "mesh_url": mesh_url,
                "mtl_url": mtl_url,
                "texture_paths": texture_paths,
                "texture_urls": [to_objects_url(p) for p in texture_paths],
                "scale": list(scale),
                "footprint": compute_footprint(mesh_path, scale),
                "base_color": None,
            }
        # 既存フォルダにメッシュが無い(前回失敗)場合は再取得を試みる

    url = fuel_download_url(req.owner, req.name)
    try:
        data = fetch_binary(url)
    except (urllib.error.URLError, TimeoutError) as e:
        raise HTTPException(status_code=502, detail=f"failed to fetch model: {e}")

    obj_dir.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            zf.extractall(obj_dir)
    except zipfile.BadZipFile as e:
        raise HTTPException(status_code=502, detail=f"invalid archive from Fuel: {e}")

    mesh_path, texture_paths = existing_object_files(obj_dir)
    if not mesh_path:
        raise HTTPException(
            status_code=422,
            detail=f"no mesh found in downloaded model: {req.owner}/{req.name}",
        )

    downscale_texture_images(texture_paths)

    if mesh_path.lower().endswith(".dae"):
        fix_dae_texture_paths(obj_dir, Path(mesh_path))
    else:
        for mtl_path in Path(mesh_path).parent.glob("*.mtl"):
            fix_mtl_texture_paths(obj_dir, mtl_path)
        # texture_paths はmtl書き換え後に取り直す必要は無い(ファイル自体の場所は変わらない)。
        ensure_texture_mtl(obj_dir, mesh_path, texture_paths)

    scale = read_sdf_mesh_scale(obj_dir)
    write_scale(obj_dir, scale)
    mesh_url, mtl_url = mesh_urls_for(mesh_path)

    return {
        "name": req.name,
        "owner": req.owner,
        "mesh_path": mesh_path,
        "mesh_url": mesh_url,
        "mtl_url": mtl_url,
        "texture_paths": texture_paths,
        "texture_urls": [to_objects_url(p) for p in texture_paths],
        "scale": list(scale),
        "footprint": compute_footprint(mesh_path, scale),
        "base_color": None,
    }


app.mount("/objects", StaticFiles(directory=OBJECTS_DIR), name="objects")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


def print_token(reset: bool):
    # python3 main.py token [--reset]
    if reset:
        write_token(secrets.token_urlsafe(24), exclusive=False)
        print("トークンを再発行しました。ログイン中のブラウザは再ログインが必要です。")
        print("起動中の building_editor は再起動してください。")
    print(f"トークン: {load_or_create_token()}")
    print(f"保存場所: {TOKEN_PATH}")


if __name__ == "__main__":
    if sys.argv[1:2] == ["token"]:
        print_token("--reset" in sys.argv[2:])
        sys.exit(0)

    import uvicorn

    port = int(os.environ.get("BUILDING_EDITOR_PORT", "8080"))
    host = "0.0.0.0" if EXPOSE else "127.0.0.1"
    print(f"Listening on {host}:{port}" + ("" if EXPOSE else " (このPCからのみ。公開するには BUILDING_EDITOR_EXPOSE=true)"))
    print("Login: enabled (BUILDING_EDITOR_AUTH=token)。トークンは python3 main.py token で表示できます"
          if AUTH_ENABLED else "Login: disabled")
    uvicorn.run("main:app", host=host, port=port, reload=False)
