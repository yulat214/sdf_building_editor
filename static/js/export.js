// Converts wall segments (meters) into an Ignition Gazebo world SDF string.
(() => {
  function wallToModelXml(wall, index, wallHeight) {
    const dx = wall.x2 - wall.x1;
    const dy = wall.y2 - wall.y1;
    const length = Math.hypot(dx, dy);
    const yaw = Math.atan2(dy, dx);
    const cx = (wall.x1 + wall.x2) / 2;
    const cy = (wall.y1 + wall.y2) / 2;
    const cz = wallHeight / 2;

    return `    <model name="wall_${index}">
      <static>true</static>
      <pose>${cx.toFixed(4)} ${cy.toFixed(4)} ${cz.toFixed(4)} 0 0 ${yaw.toFixed(6)}</pose>
      <link name="link">
        <collision name="collision">
          <geometry>
            <box>
              <size>${length.toFixed(4)} ${wall.thickness.toFixed(4)} ${wallHeight.toFixed(4)}</size>
            </box>
          </geometry>
        </collision>
        <visual name="visual">
          <geometry>
            <box>
              <size>${length.toFixed(4)} ${wall.thickness.toFixed(4)} ${wallHeight.toFixed(4)}</size>
            </box>
          </geometry>
          <material>
            <ambient>0.8 0.8 0.8 1</ambient>
            <diffuse>0.8 0.8 0.8 1</diffuse>
          </material>
        </visual>
      </link>
    </model>`;
  }

  function wallsToSDF(walls, options) {
    const { worldName = "building_editor_world", wallHeight = 2.5 } = options || {};
    const wallModels = walls
      .map((w, i) => wallToModelXml(w, i, wallHeight))
      .join("\n");

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
  </world>
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

  window.BuildingEditorExport = { wallsToSDF, downloadSDF };
})();
