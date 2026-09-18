"""Gazebo Fuel(https://fuel.gazebosim.org)のモデル一覧を取得し、
fuel_catalog.json と static/fuel_icons/*.jpg を生成するスクリプト。

対象コレクション(CC BY 4.0/CC0で統一されていることを確認済み。詳細はreadme.md参照):
  - OpenRobotics (Gazebo公式コレクション)

GoogleResearch(Google Scanned Objects)も同様にCC BY 4.0で確認済みで、以前はこちらを収録して
いたが、オブジェクトの品揃えの好みでOpenRoboticsに切り替えた。OWNERSに追加すれば同じ仕組みで
そのまま取り込める。

生成物はどちらもコミット対象(fuel_catalog.jsonはただのメタデータ、
fuel_iconsはCC BY 4.0/CC0のサムネイル画像で再配布可能)。一度生成すれば、実行時に
building_editorがFuelへ一覧・画像を取りに行くことは無い(実体メッシュの取得のみ、
「ワールドに配置」「ライブラリに追加」を押した時に遅延ダウンロードされる)。

ネットワーク接続必須。OpenRoboticsだけで1000件超あり、モデルごとにmodel.sdf確認+
サムネイル取得で2リクエストかかるため、`ThreadPoolExecutor`で並列実行している
(`MAX_WORKERS`並列)。Fuel側のコレクション内容が変わった場合のみ再実行すればよい。
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

MAX_WORKERS = 24  # generate_catalog_validity.py(Webotsカタログ検証時代)と同じ並列数

FUEL_API_BASE = "https://fuel.gazebosim.org/1.0"
OWNERS = ["OpenRobotics"]
# ライセンスがこの集合に無いモデルは取り込まない(Fuel側の内容が将来変わった場合の保険)。
ALLOWED_LICENSES = {
    "Creative Commons Attribution 4.0 International",
    "Creative Commons Zero v1.0 Universal",
}
# building_editor(main.py)が取り込めるのはメッシュファイルを持つモデルのみ。
# Fuelには球・箱等のSDFプリミティブ形状だけで出来たモデル(メッシュ無し)もあり、
# そういう物は取り込み時に「no mesh found」で失敗する。事前に file_tree を見て弾く。
MESH_EXTS = {".obj", ".dae", ".stl"}
USER_AGENT = "sdf_building_editor/1.0"
PER_PAGE = 100

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(BASE_DIR, "static", "fuel_icons")
CATALOG_PATH = os.path.join(BASE_DIR, "fuel_catalog.json")


def slugify(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_")
    return slug or "object"


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def fetch_binary(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read()


def fetch_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")


# model.sdfの<mesh><uri>を正として使う(main.pyのread_sdf_mesh_uriと同じロジック)。
# 単に同梱ファイルを拡張子で探すと、モデル内に紛れている無関係な旧メッシュ
# (実例: OpenRobotics/OutsideBenchは未使用の旧.daeを同梱しているが、model.sdfが
# 実際に指すのは別の.glb)を誤って拾ってしまうため、fuel_catalog.json生成時点で
# main.pyの取り込み判定と完全に一致させる。
SDF_MODEL_URI_PREFIX_RE = re.compile(r"^model://[^/]+/(.+)$")
SDF_URI_TAG_RE = re.compile(r"<uri>\s*([^<\s][^<]*?)\s*</uri>")


def model_has_mesh(owner: str, name: str) -> bool:
    # zipを丸ごと落とさずに済む、model.sdf単体の直接fetchで判定する。
    q = urllib.parse.quote(name, safe="")
    url = f"{FUEL_API_BASE}/{owner}/models/{q}/tip/files/model.sdf"
    try:
        text = fetch_text(url)
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"  model.sdf取得失敗 {owner}/{name}: {e}", file=sys.stderr)
        return False
    m = SDF_URI_TAG_RE.search(text)
    if not m:
        return False
    uri = m.group(1)
    pm = SDF_MODEL_URI_PREFIX_RE.match(uri)
    rel = pm.group(1) if pm else uri
    return os.path.splitext(rel)[1].lower() in MESH_EXTS


def list_owner_models(owner: str, max_pages=None):
    page = 1
    while True:
        if max_pages is not None and page > max_pages:
            return
        url = f"{FUEL_API_BASE}/{owner}/models?page={page}&per_page={PER_PAGE}"
        try:
            data = fetch_json(url)
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  一覧取得失敗 page={page}: {e}", file=sys.stderr)
            return
        if not data:
            return
        yield from data
        page += 1


def process_model(owner: str, m: dict):
    # 1モデル分の判定+アイコン取得。ThreadPoolExecutorから並列に呼ばれる
    # (書き込み先はモデルごとに別ファイルなので競合しない)。
    license_name = m.get("license_name")
    if license_name not in ALLOWED_LICENSES:
        return ("license", (owner, m.get("name"), license_name))

    name = m["name"]
    if not model_has_mesh(owner, name):
        return ("no_mesh", (owner, name))

    icon_file = None
    thumb_url = m.get("thumbnail_url")
    if thumb_url:
        # thumbnail_url は "/GoogleResearch/models/.../thumbnails/0.jpg" のように
        # /1.0 プレフィックス無しの相対パスで返る(一覧・zip取得のURLとは異なる)ため、
        # ホスト直結ではなくFUEL_API_BASEに連結する(先頭が/で始まらない絶対URLの
        # 場合はそのまま使う)。
        full_url = (
            f"{FUEL_API_BASE}{thumb_url}" if thumb_url.startswith("/") else thumb_url
        )
        candidate = f"{owner}_{slugify(name)}.jpg"
        try:
            data = fetch_binary(full_url)
            Path(ICON_DIR, candidate).write_bytes(data)
            icon_file = candidate
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  アイコン取得失敗 {owner}/{name}: {e}", file=sys.stderr)

    entry = {
        "name": name,
        "owner": owner,
        "category": owner,
        "description": (m.get("description") or "").strip(),
        "license_name": license_name,
        "license_url": m.get("license_url"),
        "icon_file": icon_file,
    }
    return ("ok", entry)


def main():
    max_pages = None
    if len(sys.argv) > 1:
        # デバッグ用: 各ownerの取得ページ数を制限して少数件だけ試す
        # (例: python3 generate_fuel_catalog.py 1 → 各owner先頭100件のみ)
        max_pages = int(sys.argv[1])

    os.makedirs(ICON_DIR, exist_ok=True)

    jobs = [
        (owner, m)
        for owner in OWNERS
        for m in list_owner_models(owner, max_pages=max_pages)
    ]
    print(f"対象モデル数: {len(jobs)} 件(並列度 {MAX_WORKERS})")

    entries = []
    skipped_license = []
    skipped_no_mesh = []
    done = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(process_model, owner, m) for owner, m in jobs]
        for fut in as_completed(futures):
            kind, payload = fut.result()
            if kind == "license":
                skipped_license.append(payload)
            elif kind == "no_mesh":
                skipped_no_mesh.append(payload)
            else:
                entries.append(payload)
            done += 1
            if done % 100 == 0:
                print(f"  {done}/{len(jobs)} 件処理済み...")

    with open(CATALOG_PATH, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=1)

    print(f"\n合計 {len(entries)} 件を書き出しました: {CATALOG_PATH}")
    if skipped_license:
        print(f"ライセンス不一致で除外: {len(skipped_license)} 件")
        for s in skipped_license[:20]:
            print("  ", s)
    if skipped_no_mesh:
        print(f"メッシュ無し(プリミティブ形状等)で除外: {len(skipped_no_mesh)} 件")
        for s in skipped_no_mesh[:20]:
            print("  ", s)


if __name__ == "__main__":
    main()
