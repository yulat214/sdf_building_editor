## 準備
```
cd {path}/building_editor
pip install -r requirements.txt # 初回実行時のみ
```
オブジェクトカタログ(`fuel_catalog.json`・サムネイル`static/fuel_icons/`)はリポジトリに
コミット済みなので、追加のセットアップ操作は不要。

## 使い方
```
cd {path}/building_editor
python3 main.py
```
ブラウザを開き、localhost:8080にアクセスする

## その他
環境変数`BUILDING_EDITOR_PORT`で使用するポートを選択できる(`3000`はOneStageROSが使うので避ける)。

例：
```
BUILDING_EDITOR_PORT=8081 python3 main.py
```

## アクセス制限

OneStageROS(2.0.0以降)と同じ考え方で、次の制限を掛けている。

- **待ち受けアドレス**: 既定では`127.0.0.1`(このPCからのみ)。Dockerコンテナ内で動かして
  ホスト機のブラウザから使う場合や、別のPCから使う場合は`BUILDING_EDITOR_EXPOSE=true`を設定する。
  ```
  BUILDING_EDITOR_EXPOSE=true python3 main.py
  ```
- **アクセス元の確認**: `localhost`・IPアドレス以外のHost名でのアクセス(DNS rebinding)と、
  他のWebサイトや同じPCの別ポート(OneStageROSの画面等)から送られたリクエストは`403`で拒否する。
- **ログイン(任意)**: `BUILDING_EDITOR_AUTH=token`を設定すると、画面を開くときにトークンの入力が
  必要になる。ネットワークに公開する(`BUILDING_EDITOR_EXPOSE=true`)場合は設定すること。
  ```
  BUILDING_EDITOR_EXPOSE=true BUILDING_EDITOR_AUTH=token python3 main.py
  python3 main.py token          # トークンを表示
  python3 main.py token --reset  # トークンを再発行(起動中のサーバーは再起動が必要)
  ```
  トークンは`~/.config/sdf-building-editor/token`に保存される。
  `http://localhost:8080/login#token=<トークン>`で開くと入力を省略できる。

## オブジェクトカタログ

[Gazebo Fuel](https://app.gazebosim.org/)の **OpenRobotics**(Gazebo公式コレクション、什器・乗り物等)
から一覧を取得し、オブジェクトのメッシュ・テクスチャを取り込んで配置できる。
[Creative Commons Attribution 4.0 International](http://creativecommons.org/licenses/by/4.0/)
(一部CC0)で統一されている。取り込んだ実体はWebots・OneStageROSの両方から同じ絶対パスで参照される
想定で、環境変数で置き場所を変更できる。

以前はWebots公式カタログから取り込んでいたが、そちらのアセットは "Licensed for use only with
Webots" という制限付きライセンスで、Webots以外(OneStageROS等)での利用が許諾範囲外だったため、
今はFuelのみを対象にしている。Fuelには他に **GoogleResearch**(Google Scanned Objects、家庭用品・
おもちゃ類、同じくCC BY 4.0)もあり、こちらも `generate_fuel_catalog.py` の `OWNERS` に追加すれば
同じ仕組みで取り込めることを確認済みだが、当面は OpenRobotics のみ収録している。

### 帰属表示

OpenRobotics コレクション: © Open Robotics, CC BY 4.0 / CC0

各モデルの正確なライセンスは `fuel_catalog.json` の `license_name`/`license_url` を参照。

### 操作

一覧の項目を1クリックするとパネル上部のプレビュー枠に画像が出る(この時点ではダウンロードも
配置もしない)。実体(メッシュ・テクスチャ)を`BUILDING_EDITOR_OBJECTS_DIR`配下に落とすのは、
プレビュー枠のどちらかのボタンを押したときだけ:

- **ワールドに配置**: 取り込んでから配置モードに入る。キャンバスをクリックで確定(Escで解除)。
  同じ物を続けて置きたい場合はもう一度このボタンを押す。
- **ライブラリに追加**: 取り込むだけ。building_editorのシーンには入れず、OneStageROS等から
  その実体を配置したい場合に使う。取り込み済みの項目には「取り込み済み」バッジが付き、
  以降このボタンは無効になる。

`/api/catalog`は各項目に`cached`(ディスク上に実体があるか)を含めて返す。

- `BUILDING_EDITOR_OBJECTS_DIR`: オブジェクトの実体(メッシュ・テクスチャ)を保存するディレクトリ。
  既定値: `/root/objects`
- `BUILDING_EDITOR_MAX_TEXTURE_SIZE`: 取り込み時にテクスチャ画像を縮小する上限(長辺px)。
  既定値: `1024`。Fuelのテクスチャ(Albedo/Normal/Roughness等)は2048x2048が標準で1個体あたり
  数MB〜十数MBにもなり、部屋にいくつか置くだけでブラウザの転送・GPUメモリが重くなる。
  building_editorは部屋スケールでの配置確認が目的で写実的な近接描写は不要なため、
  この上限を超える画像だけ自動で縮小する(例: Armchairは9MB→2.2MBに削減。実測済み)。
  ファイル名・形式は変えないので参照の書き換えは不要。

初回の取り込み時にFuel(`fuel.gazebosim.org`)からモデル一式(zip)をダウンロードするため、
その時点でネットワーク接続が必要。一度取り込んだオブジェクトは`BUILDING_EDITOR_OBJECTS_DIR`配下に
残るため、2回目以降はネットワーク無しで再利用される(縮尺情報は`<name>/_meta.json`に保存)。

取り込めたオブジェクトの実寸(2Dキャンバス上の表示サイズ)は`.obj`/`.dae`のメッシュから
バウンディングボックスを計算して求めている(`.stl`は未対応で、その場合は固定サイズの点で
代替表示される)。メッシュ自体がinch/mm単位などで作られていて`model.sdf`の`<mesh><scale>`で
実寸に補正されているケース(例: OpenRobotics/Ambulanceはinch単位+`scale 0.0254`)にも対応済み。

### どのファイルをメッシュとして使うか

1モデルのzipに複数のメッシュファイルが同梱されていることがあり(書き出しツールの副産物である
未使用の旧メッシュ等)、単純に拡張子で総当たり検索すると無関係なファイルを誤って拾うことがある
(実例: OpenRobotics/OutsideBenchは未使用の旧`.dae`を同梱しているが、`model.sdf`が実際に指すのは
別の`.glb`)。これを避けるため、`model.sdf`の最初の`<mesh><uri>`が指すファイルを優先し、
それが`.obj`/`.dae`/`.stl`のいずれでもない場合(`.glb`等、未対応形式)は同梱の他ファイルへ
読み替えず「取り込めない」として扱う。`model.sdf`が無い/解析できない場合のみ、フォルダ内の
拡張子検索にフォールバックする。`generate_fuel_catalog.py`のカタログ事前フィルタも同じ判定を使う。

### 色・テクスチャ

- Fuelのモデルは通常`meshes/<name>.obj` + 同じフォルダの`.mtl` + `materials/textures/`配下の
  画像、という構成で取り込み時にそのまま使えるが、**`.mtl`内の`map_Kd`等はテクスチャをファイル名
  だけで参照しており、実体は`.mtl`と同じフォルダではなく`materials/textures/`にある**
  (Gazebo自身はこの置き場所の慣習を知っているが、three.jsのMTLLoader等の一般的なOBJ/MTL
  ローダーは知らず、`.mtl`と同じディレクトリしか探さない)。取り込み時に`.mtl`内の参照を
  実際に存在するファイルへの相対パスに書き換えている。
- `.mtl`が無く単体のテクスチャ画像しか無い個体があった場合のフォールバックとして、`map_Kd`付きの
  最小`.mtl`を生成して`.obj`に`mtllib`を差し込む処理も残している(UV(`vt`)を持つメッシュにのみ
  行う。`.mtl`経由でしかテクスチャを貼らない実行環境=OneStageROS等での無地化を防ぐため)。

建物の構成要素(壁・ドア)はカタログ取り込みではなく、building_editor側の専用プリミティブ
(ツールバーの「壁」/「ドア」切り替え)で簡易的な箱として直接配置する。

## 操作(配置済みアイテムの移動・削除)

配置済みの壁・ドア・オブジェクトは、ドラッグで移動、右クリックで削除できる
(カタログ選択中/壁描画の始点確定待ちの間は無効)。ドラッグ中にEscでキャンセルすると
元の位置に戻る。

## ロボット開始位置

ツールバーの「ロボット開始位置」ボタンで、部屋のどこにロボットを置いて演習を始めるかを
2Dキャンバス上で指定できる(1個だけ、位置+向き)。他のオブジェクトと同様、クリックで設置、
ドラッグで移動、選択中はスクロール/回転欄で向きを編集、右クリックで削除できる。

- **SDF出力**: `<world>`直下に`<model name="spawn"><pose>x y 0 0 0 yaw</pose></model>`として
  出力する。これはOneStageROS(`assets-server.js`)が既に持っている規約
  (`name`が`spawn`または`robot`のモデルは可視化せず初期姿勢としてのみ扱う)にそのまま乗る形
  で、OneStageROS側の改修は不要。
- **WBT出力**: `turtlebot3_lime_webots`の`Turtlebot3Lime`ノードとして出力する
  (`EXTERNPROTO`は`/root/webots_ws/src/turtlebot3_lime_webots/protos/Turtlebot3Lime.proto`を
  絶対パスで宣言する。相対パスだと保存先によって壊れるため)。`controller "<extern>"`にして
  あるので、`ros2 launch turtlebot3_lime_webots robot_launch.py world:=<出力した.wbt>`で
  そのままロボットごと起動できる。
- ロボット開始位置を置いていない場合は、SDF/WBTどちらも該当ノードを一切出力しない
  (`spawn`モデルも`EXTERNPROTO`/`Turtlebot3Lime`ノードも無し)。

## カタログ一覧・サムネイルの再生成

`fuel_catalog.json`(一覧のメタデータ)と`static/fuel_icons/`(サムネイル画像、CC BY 4.0な
ので再配布可)はどちらもリポジトリにコミットしてあり、通常は生成し直す必要が無い。
Fuel側のコレクションが更新された場合のみ、

```
cd {path}/building_editor
python3 generate_fuel_catalog.py
```

で再生成する(ネットワーク接続必須。OpenRoboticsだけで1000件超あるため、一覧取得+
各モデルのファイル構成確認+サムネイルダウンロードで数十分かかる。デバッグ用に
`python3 generate_fuel_catalog.py 1`のように引数で取得ページ数を制限できる)。

ライセンスが`ALLOWED_LICENSES`に一致しないモデルと、`model.sdf`が指すメッシュが
`.obj`/`.dae`/`.stl`のいずれでもないモデル(SDFプリミティブ形状のみ、`.glb`/`.gltf`形式等)は
自動的に除外される(判定方法は前節「どのファイルをメッシュとして使うか」と同じ)。
`.glb`/`.gltf`は現状building_editorが取り込めない。

## 3Dプレビュー

ツールバーの「3Dプレビュー」ボタンで、配置済みの壁・ドア・オブジェクトを実寸・実位置で
3D表示できる(読み取り専用、ドラッグで回転・スクロールでズーム)。

- 描画は three.js を使用。CDNには依存せず、`static/vendor/three/`にローカルで同梱している
  (`OneStageROS`の`node_modules/three`(0.182.0)からコピーしたもの。演習で大人数が同時に開いても
  外部への通信が発生しないようにするため)。
  `three.module.js`は`three.core.js`という兄弟ファイルに依存しているので、更新する際は
  必ず両方一緒に(`OneStageROS`側で`npm update three`した後などに)コピーし直すこと。
  `ColladaLoader.js`は`TGALoader.js`(同ディレクトリ)に依存しているので、更新時は両方コピーする。
- `.obj`/`.dae`のみ実体を表示する。`.obj`は`.mtl`があればマテリアル込み、無ければテクスチャの
  1枚目をそのまま貼るか、それも無ければ灰色。`.dae`は材質・テクスチャ参照をファイル自身が
  持っているのでそのまま描画する。それ以外の形式や読み込みに失敗したオブジェクトは、
  2Dキャンバスの実寸表示と同じ考え方でfootprintサイズの半透明ボックスに代替される。
- `.dae`の`<up_axis>`がZ_UPの場合、three.jsのColladaLoaderは「Y-upが既定の3D空間に合わせる」
  ため自動でX軸-90°回転を掛けてしまう。building_editorの世界はSDF/Gazeboと同じZ-up前提
  (壁・ドア・他オブジェクトすべてZ-upで配置)なので、この自動回転を毎回打ち消している
  (`loadDaeMesh`で`group.rotation.set(0,0,0)`)。無効化しないと、モデルが横倒しになり
  床面や実寸footprintと噛み合わなくなる(実際にArmchair/Bathtub/box_target等で発生した)。
  Y_UP/X_UPのDAE(ColladaLoaderが回転を掛けないケース)は現状未対応で、向きがずれる可能性がある。
- モーダルを閉じるたびにgeometry/material/textureを破棄しており、開閉を繰り返してもWebGLの
  リソースが増え続けないようにしている。
