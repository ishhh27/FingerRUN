/**
 * fingerRUN — Complete Game Engine
 * ─────────────────────────────────────────────────────────
 * Architecture:
 *   GestureController  → MediaPipe position-based hand mapping
 *   GameState          → Single source of truth
 *   Renderer           → Three.js scene
 *   GameLoop           → rAF loop, physics, spawning
 *   AudioEngine        → Web Audio API synth sounds
 *   UI                 → Screen transitions, HUD updates
 * ─────────────────────────────────────────────────────────
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════ */
const C = {
  // Lanes — world X positions
  LANES: [-3, 0, 3],

  // Physics
  GRAVITY:           -0.020,
  JUMP_FORCE:         0.30,
  LAND_SQUASH:        0.62,    // scale.y when landing

  // Speed
  SPEED_START:        0.10,
  SPEED_MAX:          0.2,
  SPEED_ACCEL:        0.000010, // per frame at 60fps

  // Lane transitions
  LANE_LERP:          0.14,    // smooth factor per frame

  // Spawning
  OBS_INTERVAL_MIN:   55,
  OBS_INTERVAL_MAX:  110,
  COIN_INTERVAL_MIN:  35,
  COIN_INTERVAL_MAX:  75,

  // Cleanup
  SPAWN_Z:           -75,
  CULL_Z:             18,

  // Gesture zones (0..1 in camera space, mirrored)
  // Hand X < LEFT_THRESHOLD  → lane 0 (left)
  // Hand X > RIGHT_THRESHOLD → lane 2 (right)
  // else                      → lane 1 (center)
  ZONE_LEFT:          0.38,
  ZONE_RIGHT:         0.62,

  // Jump: wrist Y < this fraction of frame → jump
  JUMP_Y_THRESH:      0.32,
  JUMP_COOLDOWN_MS:   650,

  // Stabilizer: how many consecutive frames before acting
  ZONE_CONFIRM_FRAMES: 3,

  // Max frames to tolerate hand-loss before resetting
  HAND_LOSS_GRACE:    12,
};

/* ═══════════════════════════════════════════════════════════
   GAME STATE — single object, mutated in place
═══════════════════════════════════════════════════════════ */
const GS = {
  phase: 'loading',   // loading | start | countdown | playing | dead
  score: 0,
  distance: 0,
  highScore: +(localStorage.getItem('fr_hs') || 0),
  combo: 0,
  comboTimer: 0,

  // Player
  lane: 1,           // current target lane index
  playerX: 0,        // actual rendered X (lerped)
  playerY: 0,        // vertical position
  velY: 0,
  jumping: false,
  squashTimer: 0,    // frames of squash effect after landing
  invFrames: 0,      // invincibility frames after hit

  // Speed / world
  speed: C.SPEED_START,
  frame: 0,

  // Spawning counters
  nextObs: 70,
  nextCoin: 40,

  // Gesture
  gestLane: 1,       // gesture-suggested lane
  gestConfirm: 0,    // consecutive frames in same zone
  gestPrevLane: 1,
  gestHandLoss: 0,   // frames since last hand seen
  jumpCooldown: 0,   // ms
  lastJumpTime: 0,
  jumpReady: true,
  magnet: false,
  magnetTimer: 0,
  shield: false,
};

/* ═══════════════════════════════════════════════════════════
   RENDERER — Three.js scene
═══════════════════════════════════════════════════════════ */
const R = (() => {
  let renderer, scene, camera;
  let playerMesh, playerGroup;
  let groundTiles = [];
  let obstacles   = [];
  let coins       = [];
  let particles   = [];
  let archGroup;
  let pointLights = [];

  // Materials (reused)
  const MAT = {};

  function init() {
    const canvas = document.getElementById('game-canvas');

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = false; // off for perf; emissive lights look great anyway
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04060f);
    scene.fog = new THREE.FogExp2(0x040810, 0.020);

    camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 200);
    camera.position.set(0, 4.5, 9);
    camera.lookAt(0, 1.2, -10);

    window.addEventListener('resize', () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });

    _buildMaterials();
    _buildLights();
    _buildGround();
    _buildPlayer();
    _buildArches();
    _buildStars();
    buildGalaxyDecor();
  }

  function _buildMaterials() {
    MAT.ground = new THREE.MeshStandardMaterial({
      color: 0x050c1e, roughness: 0.9, metalness: 0.1,
      emissive: 0x001122, emissiveIntensity: 0.2,
    });
    MAT.wall = new THREE.MeshStandardMaterial({
      color: 0x001833, emissive: 0x00e5ff, emissiveIntensity: 0.55,
    });
    MAT.laneDiv = new THREE.LineBasicMaterial({
      color: 0x00e5ff, transparent: true, opacity: 0.15,
    });
    MAT.player = new THREE.MeshStandardMaterial({
      color: 0x0088ff, emissive: 0x00e5ff, emissiveIntensity: 0.5,
      roughness: 0.1, metalness: 0.9,
    });
    MAT.playerVisor = new THREE.MeshStandardMaterial({
      color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 3,
      transparent: true, opacity: 0.75,
    });
    MAT.obsRed = new THREE.MeshStandardMaterial({
      color: 0x991122, emissive: 0xff2244, emissiveIntensity: 0.9,
      roughness: 0.2, metalness: 0.8,
    });
    MAT.obsOrange = new THREE.MeshStandardMaterial({
      color: 0x882200, emissive: 0xff6d00, emissiveIntensity: 0.8,
      roughness: 0.2, metalness: 0.8,
    });
    MAT.obsPink = new THREE.MeshStandardMaterial({
      color: 0x660088, emissive: 0xf700ff, emissiveIntensity: 0.7,
      roughness: 0.2, metalness: 0.8,
    });
    MAT.coin = new THREE.MeshStandardMaterial({
  color:
    GS.distance >= 500 ? 0xaa00ff :
    GS.distance >= 200 ? 0x00aaff :
    GS.distance >= 100  ? 0xff4444 :
                           0xffe600,

  emissive:
    GS.distance >= 500 ? 0xaa00ff :
    GS.distance >= 200 ? 0x0088ff :
    GS.distance >= 100  ? 0xff2222 :
                           0xffcc00,

  emissiveIntensity: 1.5,

  roughness: 0.25,
  metalness: 0.8
});
    MAT.arch = [
      new THREE.MeshStandardMaterial({ color:0x001f33, emissive:0x00e5ff, emissiveIntensity:1, transparent:true, opacity:0.5 }),
      new THREE.MeshStandardMaterial({ color:0x330011, emissive:0xff00aa, emissiveIntensity:0.9, transparent:true, opacity:0.45 }),
    ];
  }

  function _buildLights() {
    scene.add(new THREE.AmbientLight(0x112244, 0.7));

    const dir = new THREE.DirectionalLight(0x00e5ff, 1.2);
    dir.position.set(4, 10, 4);
    scene.add(dir);

    const hemi = new THREE.HemisphereLight(0x001133, 0x000000, 0.4);
    scene.add(hemi);

    // Dynamic point lights that travel with player
    [0xf700ff, 0xff6d00].forEach((col, i) => {
      const pl = new THREE.PointLight(col, 1.8, 14);
      pl.position.set(i === 0 ? -6 : 6, 3, 0);
      scene.add(pl);
      pointLights.push(pl);
    });
  }

  function _buildGround() {
    for (let i = 0; i < 8; i++) {
      const tile = _makeTile();
      tile.position.z = -i * 12;
      scene.add(tile);
      groundTiles.push(tile);
    }
  }

  function _makeTile() {
    const g = new THREE.Group();

    // Floor plane
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 12, 4, 4), MAT.ground);
    floor.rotation.x = -Math.PI / 2;
    g.add(floor);

    // Lane dividers
    [-1.5, 1.5].forEach(x => {
      const pts = [new THREE.Vector3(x, 0.01, -6), new THREE.Vector3(x, 0.01, 6)];
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), MAT.laneDiv));
    });

    // Side walls
    [-5.5, 5.5].forEach(x => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.5, 12), MAT.wall);
      wall.position.set(x, 1.25, 0);
      g.add(wall);
    });

    return g;
  }

  function _buildPlayer() {
    playerGroup = new THREE.Group();

    // Body
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.38, 0.32, 1.1, 10),
      MAT.player
    );
    body.position.y = 0.85;
    playerGroup.add(body);

    // Head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.31, 10, 10), MAT.player);
    head.position.y = 1.75;
    playerGroup.add(head);

    // Visor strip
    const visor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.28, 0.1, 10),
      MAT.playerVisor
    );
    visor.position.set(0, 1.76, 0.2);
    visor.rotation.x = Math.PI / 2;
    playerGroup.add(visor);

    // Legs (named for animation)
    [-0.18, 0.18].forEach((x, i) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.65, 8), MAT.player);
      leg.position.set(x, 0.32, 0);
      leg.name = 'leg' + i;
      playerGroup.add(leg);
    });

    // Glow ring at feet
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.035, 6, 22),
      new THREE.MeshStandardMaterial({ color:0x00e5ff, emissive:0x00e5ff, emissiveIntensity:4, transparent:true, opacity:0.7 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.03;
    ring.name = 'ring';
    playerGroup.add(ring);

    playerGroup.position.set(C.LANES[1], 0, 0);
    // 🚀 Player glow trail
const trailLight = new THREE.PointLight(
  0x00e5ff,
  2,
  8
);

trailLight.position.set(0, 0.5, -1);

playerGroup.add(trailLight);

// ✨ Soft aura
const aura = new THREE.Mesh(

  new THREE.SphereGeometry(0.45, 16, 16),

  new THREE.MeshBasicMaterial({
    color: 0x00e5ff,
    transparent: true,
    opacity: 0.08
  })
);


playerGroup.add(aura);
    scene.add(playerGroup);
    playerMesh = playerGroup;
  }

  function _buildArches() {
    archGroup = new THREE.Group();
    for (let i = 0; i < 18; i++) {
      const mat = MAT.arch[i % 2];
      const arch = new THREE.Mesh(new THREE.TorusGeometry(6.5, 0.07, 5, 28, Math.PI), mat);
      arch.rotation.x = Math.PI / 2;
      arch.position.set(0, 0, -22 - i * 10);
      archGroup.add(arch);
    }
    scene.add(archGroup);
  }

  function _buildStars() {
    const geo = new THREE.BufferGeometry();
    const count = 1800;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3]     = (Math.random() - 0.5) * 180;
      pos[i * 3 + 1] =  Math.random() * 60 + 2;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 180;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x8899cc, size: 0.13, transparent: true, opacity: 0.7 })));
  }
  function buildGalaxyDecor() {

  // PLANETS
  for (let i = 0; i < 5; i++) {
    const planet = new THREE.Mesh(
      new THREE.SphereGeometry(2 + Math.random() * 2, 32, 32),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(`hsl(${Math.random()*360},80%,60%)`),
        emissive: 0x222244,
        emissiveIntensity: 1
      })
    );

    planet.position.set(
      (Math.random() - 0.5) * 80,
      10 + Math.random() * 20,
      -50 - Math.random() * 120
    );

    scene.add(planet);
  }


  // METEORS
  for (let i = 0; i < 15; i++) {
    const meteor = new THREE.Mesh(
      new THREE.SphereGeometry(0.2 + Math.random() * 0.3, 8, 8),
      new THREE.MeshStandardMaterial({
        color: 0xffaa55,
        emissive: 0xff6600,
        emissiveIntensity: 2
      })
    );

    meteor.position.set(
      (Math.random() - 0.5) * 100,
      5 + Math.random() * 25,
      -Math.random() * 200
    );

    meteor.userData.speed = 0.2 + Math.random() * 0.4;

    scene.add(meteor);
    particles.push(meteor);
    }
  }
  // ── Obstacle factory ──
  function spawnObstacle(speed) {
    // Pick 1 or 2 lanes to block
    const count = Math.random() < 0.35 ? 2 : 1;
    const lanePick = _shuffleLanes().slice(0, count);
    const type = _randItem(['tall']);
    const group = new THREE.Group();

    lanePick.forEach(laneIdx => {
      let geo, mat, py;
      if (type === 'tall') {
        geo = new THREE.BoxGeometry(1.9, 2.4, 0.45);
        mat = MAT.obsRed; py = 1.2;
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(C.LANES[laneIdx], py, 0);
      group.add(mesh);
    });

    group.position.z = C.SPAWN_Z;
    group.userData = { lanes: lanePick, type };
    scene.add(group);
    obstacles.push(group);
  }
  //Magnet factory
  function spawnMagnet() {

   const magnet = new THREE.Mesh(
     new THREE.TorusGeometry(0.35, 0.15, 16, 100),
     new THREE.MeshStandardMaterial({
       color: 0xff0000,
       emissive: 0xff4444,
       emissiveIntensity: 2
     })
   );

   magnet.rotation.z = Math.PI / 2;

   const lane = Math.floor(Math.random() * 3);

magnet.position.set(
  C.LANES[lane],
  1,
  C.SPAWN_Z
);

magnet.userData = {
  type: 'magnet',
  lane: lane,
  alive: true
};

   scene.add(magnet);
   coins.push(magnet);
  }
  // ── Coin factory ──
  function spawnCoins() {
    const lane = Math.floor(Math.random() * 3);
    const n = Math.floor(Math.random() * 5) + 1;
    for (let i = 0; i < n; i++) {
      const coinMaterial = new THREE.MeshStandardMaterial({

  color:
    GS.distance >= 1500 ? 0xaa00ff :
    GS.distance >= 1000 ? 0x00aaff :
    GS.distance >= 500 ? 0xff4444 :
                         0xffe600,

  emissive:
    GS.distance >= 1500 ? 0xaa00ff :
    GS.distance >= 1000 ? 0x0088ff :
    GS.distance >= 500 ? 0xff2222 :
                         0xffcc00,

  emissiveIntensity: 1.5,

  roughness: 0.25,
  metalness: 0.8
});

const coin = new THREE.Mesh(
  new THREE.OctahedronGeometry(0.21, 0),
  coinMaterial
);
      coin.position.set(C.LANES[lane], 0.85, C.SPAWN_Z - i * 2.8);
      coin.userData = { lane, alive: true };
      scene.add(coin);
      coins.push(coin);
    }
  }

  // ── Particle burst ──
  function burst(x, y, z, color = 0xffe600, n = 10) {
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 3,
      transparent: true, opacity: 1,
    });
    for (let i = 0; i < n; i++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.07 + Math.random() * 0.07, 4, 4), mat.clone());
      p.position.set(x, y, z);
      p.userData.vel = new THREE.Vector3(
        (Math.random() - 0.5) * 0.18,
        Math.random() * 0.18 + 0.04,
        (Math.random() - 0.5) * 0.08
      );
      p.userData.life = 1;
      p.userData.decay = 0.035 + Math.random() * 0.03;
      scene.add(p);
      particles.push(p);
    }
  }

  // ── Trail particle ──
  let trailTimer = 0;
  function addTrail() {
    trailTimer++;
    if (trailTimer % 4 !== 0) return;
    const p = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 4, 4),
      new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 2.5, transparent: true, opacity: 0.5 })
    );
    p.position.set(playerGroup.position.x, playerGroup.position.y + 0.5, playerGroup.position.z);
    p.userData.vel = new THREE.Vector3(0, 0.01, 0);
    p.userData.life = 1;
    p.userData.decay = 0.07;
    scene.add(p);
    particles.push(p);
  }

  // ── Update called each frame ──
  function update(gs) {
    const mz = gs.speed * 60 / 60; // normalized move per frame

    // Ground tiles scroll
    groundTiles.forEach(t => {
      t.position.z += mz;
      if (t.position.z > 12) t.position.z -= groundTiles.length * 12;
    });

    // Arches scroll
    archGroup.children.forEach(a => {
      a.position.z += mz;
      if (a.position.z > 10) a.position.z -= archGroup.children.length * 10;
    });

    // Obstacles
    for (let i = obstacles.length - 1; i >= 0; i--) {
      const o = obstacles[i];
      o.position.z += mz;
      if (o.userData.type === 'wide') o.rotation.y += 0.025;
      if (o.position.z > C.CULL_Z) {
        scene.remove(o);
        obstacles.splice(i, 1);
      }
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.userData.life -= p.userData.decay;
      p.position.add(p.userData.vel);
      p.userData.vel.y -= 0.005;
      p.material.opacity = p.userData.life;
      p.scale.setScalar(Math.max(0, p.userData.life));
      if (p.userData.life <= 0) {
        scene.remove(p);
        p.geometry.dispose();
        p.material.dispose();
        particles.splice(i, 1);
      }
    }

    // Player position (smooth lerp)
    gs.playerX += (C.LANES[gs.lane] - gs.playerX) * C.LANE_LERP * 3.5;
    playerGroup.position.x = gs.playerX;
    playerGroup.position.y = gs.playerY;

    // Squash/stretch
    let scaleY = 1.0;
    if (gs.squashTimer > 0) {
      gs.squashTimer--;
      const t = gs.squashTimer / 8;
      scaleY = C.LAND_SQUASH + (1 - C.LAND_SQUASH) * (1 - t);
    }
    if (gs.jumping) {
      scaleY = 1.0 + (gs.velY / C.JUMP_FORCE) * 0.25;
    }
    playerGroup.scale.y += (scaleY - playerGroup.scale.y) * 0.35;
    playerGroup.scale.x += (1 / Math.max(0.6, scaleY) - playerGroup.scale.x) * 0.35;

    // Leg animation
    const leg0 = playerGroup.getObjectByName('leg0');
    const leg1 = playerGroup.getObjectByName('leg1');
    if (leg0 && leg1) {
      const t = gs.frame * 0.22;
      leg0.rotation.x = Math.sin(t) * 0.7;
      leg1.rotation.x = Math.sin(t + Math.PI) * 0.7;
    }

    // Ring spin
    const ring = playerGroup.getObjectByName('ring');
    if (ring) ring.rotation.z += 0.06;

    // Invincibility blink
    if (gs.invFrames > 0) {
      playerGroup.visible = Math.floor(gs.frame * 0.5) % 2 === 0;
    } else {
      playerGroup.visible = true;
    }

    // Trail
    addTrail();

    // Side light pulse
    pointLights.forEach((pl, i) => {
      pl.intensity = 1.5 + Math.sin(gs.frame * 0.06 + i * Math.PI) * 0.5;
    });
  }

  // Camera follows player with smooth lag
  let camTargetX = 0, camShake = 0;

  function updateCamera(gs) {
    camTargetX += (gs.playerX * 0.12 - camTargetX) * 0.08;
    const baseY = 4.5 + gs.playerY * 0.2;

    camera.position.x += (camTargetX - camera.position.x) * 0.07;
    camera.position.y += (baseY - camera.position.y) * 0.07;

    if (camShake > 0) {
      camera.position.x += (Math.random() - 0.5) * camShake * 0.04;
      camera.position.y += (Math.random() - 0.5) * camShake * 0.03;
      camShake -= 1.2;
    }

    camera.lookAt(gs.playerX * 0.2, 1.5, -12);
  }

  function shake(amount = 15) { camShake = amount; }

  function render(gs) {
    updateCamera(gs);
    camera.position.z = 6 + Math.sin(performance.now() * 0.01) * 0.03;
    renderer.render(scene, camera);
  }

  function clearLevel() {
    [...obstacles, ...coins, ...particles].forEach(o => scene.remove(o));
    obstacles.length = 0;
    coins.length     = 0;
    particles.length = 0;
    trailTimer       = 0;
    camShake         = 0;
    camTargetX       = 0;
    playerGroup.position.set(C.LANES[1], 0, 0);
    playerGroup.scale.set(1, 1, 1);
    playerGroup.visible = true;
    camera.position.set(0, 4.5, 9);
  }

  // Collision helpers
  function getObstacles() { return obstacles; }
  function getCoins()     { return coins; }

  function removeCoin(coin) {
    const idx = coins.indexOf(coin);
    if (idx !== -1) { scene.remove(coin); coins.splice(idx, 1); }
  }
  function removeObstacle(obs) {
    const idx = obstacles.indexOf(obs);
    if (idx !== -1) { scene.remove(obs); obstacles.splice(idx, 1); }
  }

  return {
    init, update, render, shake, clearLevel,
    spawnObstacle, spawnCoins, spawnMagnet, burst,
    getObstacles, getCoins, removeCoin, removeObstacle,
  };

  function _shuffleLanes() { return [0,1,2].sort(() => Math.random()-0.5); }
  function _randItem(arr) { return arr[Math.floor(Math.random()*arr.length)]; }
})();


/* ═══════════════════════════════════════════════════════════
   GESTURE CONTROLLER
   ─────────────────────────────────────────────────────────
   Uses POSITION-BASED zone mapping (not unreliable swipes).
   The camera frame is divided into LEFT / CENTER / RIGHT.
   Wrist Y position triggers jump with cooldown.
   Smoothed across ZONE_CONFIRM_FRAMES to prevent flicker.
═══════════════════════════════════════════════════════════ */
const Gesture = (() => {
  let hands, mpCam;
  let videoEl, canvasEl, ctx;
  let pendingLane = 1;   // what zone detector currently sees
  let confirmCount = 0;  // how many frames same zone seen

  function init(videoId, canvasId, onReady) {
    videoEl  = document.getElementById(videoId);
    canvasEl = document.getElementById(canvasId);
    ctx      = canvasEl.getContext('2d');

    hands = new Hands({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
    });

    hands.setOptions({
      maxNumHands:          1,
      modelComplexity:      0,   // fastest model
      minDetectionConfidence: 0.70,
      minTrackingConfidence:  0.60,
    });

    hands.onResults(results => {
      _drawHand(results);
      _processResults(results);
    });

    mpCam = new Camera(videoEl, {
      onFrame: async () => {
        if (GS.phase === 'playing') {
          await hands.send({ image: videoEl });
        }
      },
      width: 320, height: 240,
    });

    mpCam.start()
      .then(() => { if (onReady) onReady(); })
      .catch(e => {
        console.warn('[Gesture] Camera error:', e);
        _setCamState('⚠ No camera — use keyboard');
      });
  }

  function _processResults(results) {
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      GS.gestHandLoss++;
      if (GS.gestHandLoss > C.HAND_LOSS_GRACE) {
        // Grace period elapsed — reset to center
        _updateLane(1);
        _setCamState('Show your hand…');
        _setZoneUI(-1);
      }
      return;
    }

    GS.gestHandLoss = 0;
    const lm = results.multiHandLandmarks[0];
    const wrist = lm[0];

    // ── Zone detection (mirrored: camera left = user right) ──
    // wrist.x is 0=left edge, 1=right edge in CAMERA space
    // Because camera is mirrored, wrist.x < ZONE_LEFT means user's hand is on RIGHT
    const wx = wrist.x; // 0..1

    let detectedLane;
    if (wx < C.ZONE_LEFT) {
      detectedLane = 2; // camera left = user right → right lane
    } else if (wx > C.ZONE_RIGHT) {
      detectedLane = 0; // camera right = user left → left lane
    } else {
      detectedLane = 1; // center
    }

    // ── Zone stabilizer (confirm N frames before acting) ──
    if (detectedLane === pendingLane) {
      confirmCount = Math.min(confirmCount + 1, C.ZONE_CONFIRM_FRAMES + 2);
    } else {
      pendingLane  = detectedLane;
      confirmCount = 1;
    }

    if (confirmCount >= C.ZONE_CONFIRM_FRAMES) {
      _updateLane(pendingLane);
    }

    // Better jump detection
    if (!GS.jumpReady && wrist.y > 0.45) {
     GS.jumpReady = true;
    }

    if (GS.jumpReady && wrist.y < C.JUMP_Y_THRESH) {
      const now = performance.now();

    if (now - GS.lastJumpTime > C.JUMP_COOLDOWN_MS) {
      GS.lastJumpTime = now;
      GS.jumpReady = false;
      triggerJump();
    }
    }

    // ── UI zone bars ──
    _setZoneUI(detectedLane);
    _setCamState(
      detectedLane === 0 ? '👈 LEFT' :
      detectedLane === 2 ? '👉 RIGHT' : '🖐 CENTER'
    );
  }

  function _updateLane(lane) {
    GS.gestLane = lane;
    if (GS.phase === 'playing') {
      GS.lane = lane;
    }
  }

  function _drawHand(results) {
    canvasEl.width  = canvasEl.offsetWidth;
    canvasEl.height = canvasEl.offsetHeight;
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      const lm = results.multiHandLandmarks[0];
      drawConnectors(ctx, lm, HAND_CONNECTIONS, { color:'#00e5ff', lineWidth: 1.5 });
      drawLandmarks(ctx, lm, { color:'#ff6d00', lineWidth: 1, radius: 2.5 });
    }
  }

  function _setCamState(text) {
    const el1 = document.getElementById('cam-state');
    if (el1) el1.textContent = text;
  }

  function _setZoneUI(lane) {
    ['cz-left','cz-mid','cz-right'].forEach((id,i) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('active', i === (lane === 0 ? 0 : lane === 1 ? 1 : 2));
    });

    // Also update start screen zone highlight
    const zones = document.querySelectorAll('.zone');
    zones.forEach((z, i) => {
      z.classList.toggle('active', i === (lane === 0 ? 0 : lane === 1 ? 1 : 2));
    });
  }

  // Also run hands on start-screen preview
  let previewHands, previewCam;
  function initPreview() {
    const videoP = document.getElementById('video-preview');
    const canvasP = document.getElementById('canvas-preview');
    if (!videoP || !canvasP) return;
    const pctx = canvasP.getContext('2d');

    previewHands = new Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}` });
    previewHands.setOptions({ maxNumHands:1, modelComplexity:0, minDetectionConfidence:0.65, minTrackingConfidence:0.55 });
    previewHands.onResults(r => {
      canvasP.width = canvasP.offsetWidth;
      canvasP.height = canvasP.offsetHeight;
      pctx.clearRect(0, 0, canvasP.width, canvasP.height);
      if (r.multiHandLandmarks && r.multiHandLandmarks[0]) {
        const lm = r.multiHandLandmarks[0];
        drawConnectors(pctx, lm, HAND_CONNECTIONS, { color:'#00e5ff', lineWidth:1.5 });
        drawLandmarks(pctx, lm, { color:'#ff6d00', lineWidth:1, radius:2.5 });

        // Zone highlight on preview
        const wx = lm[0].x;
        const zone = wx < C.ZONE_LEFT ? 2 : wx > C.ZONE_RIGHT ? 0 : 1;
        _setZoneUI(zone);
      }
    });

    previewCam = new Camera(videoP, {
      onFrame: async () => { await previewHands.send({ image: videoP }); },
      width: 320, height: 240,
    });
    previewCam.start().catch(e => console.warn('[Preview cam]', e));
  }

  function stopPreview() {
    if (previewCam) { previewCam.stop && previewCam.stop(); }
  }

  return { init, initPreview, stopPreview };
})();


/* ═══════════════════════════════════════════════════════════
   AUDIO ENGINE — Web Audio API
   Keeps it performant: no audio files, pure oscillator synth
═══════════════════════════════════════════════════════════ */
const Audio = (() => {
  let ctx;
  let masterGain;
  let bgTimer;

  function init() {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = 0.6;
      masterGain.connect(ctx.destination);
      _startBG();
    } catch(e) {}
  }

  function _osc(type, freq, startT, dur, gainVal = 0.2, dest = masterGain) {
    if (!ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gainVal, startT);
    g.gain.exponentialRampToValueAtTime(0.0001, startT + dur);
    o.connect(g); g.connect(dest);
    o.start(startT); o.stop(startT + dur + 0.01);
  }

  function _startBG() {
    if (!ctx) return;
    const bgGain = ctx.createGain();
    bgGain.gain.value = 0.10;
    bgGain.connect(masterGain);

    let t = ctx.currentTime;
    const BPM = 128;
    const beat = 60 / BPM;

    function scheduleBatch() {
      const now = ctx.currentTime;
      while (t < now + 1.5) {
        // Kick
        _osc('sine',   80,  t,        0.25, 0.5, bgGain);
        _osc('sine',   40,  t + 0.01, 0.2,  0.3, bgGain);
        // Snare
        _osc('square', 220, t + beat*2, 0.08, 0.2, bgGain);
        // Hi-hat
        [0,1,2,3].forEach(i => _osc('sawtooth', 8000, t + beat*i*0.5, 0.04, 0.04, bgGain));
        t += beat * 4;
      }
      bgTimer = setTimeout(scheduleBatch, 800);
    }
    scheduleBatch();
  }

  function play(type) {
    if (!ctx) return;
    const now = ctx.currentTime;
    switch(type) {
      case 'coin':
        _osc('sine', 880, now, 0.06, 0.18);
        _osc('sine', 1320, now + 0.05, 0.08, 0.12);
        break;
      case 'jump':
        _osc('sine', 280, now, 0.2, 0.22);
        _osc('sine', 560, now + 0.07, 0.15, 0.15);
        break;
      case 'swoosh':
        _osc('sawtooth', 600, now, 0.12, 0.08);
        _osc('sine', 200, now + 0.04, 0.1, 0.1);
        break;
      case 'hit':
        _osc('sawtooth', 150, now, 0.5, 0.35);
        _osc('sine', 60, now + 0.05, 0.4, 0.25);
        break;
      case 'gameover':
        [0, 0.15, 0.3, 0.5].forEach((delay, i) => {
          _osc('sawtooth', 400 - i*80, now + delay, 0.25, 0.3);
        });
        break;
    }
  }

  function stop() { if (bgTimer) clearTimeout(bgTimer); }

  return { init, play, stop };
})();


/* ═══════════════════════════════════════════════════════════
   COLLISION DETECTION
═══════════════════════════════════════════════════════════ */
function checkCollisions() {
  const px = GS.playerX;
  const py = GS.playerY;
  const pz = 0; // player always at Z=0

  // ── Coins ──
  for (const coin of R.getCoins()) {
    if (!coin.userData.alive) continue;
    const dz = Math.abs(coin.position.z - pz);
    if (dz > 2.5) continue;
    if (coin.userData.lane !== GS.lane) continue;
    if (dz < 1.8) {

  if (coin.userData.type === 'magnet') {

    GS.magnet = true;
    GS.magnetTimer = 600;

    UI.showFeedback('🧲 MAGNET', 1);

    R.removeCoin(coin);

    continue;
  }

  coin.userData.alive = false;

  R.burst(
    coin.position.x,
    coin.position.y,
    coin.position.z,
    0xffe600,
    10
  );

  R.removeCoin(coin);

  GS.score += 10;
  GS.combo++;
  GS.comboTimer = 180;

  Audio.play('coin');

  UI.showFeedback(
    GS.combo >= 10
      ? '🔥 PERFECT!'
      : GS.combo >= 5
      ? '⚡ GREAT!'
      : null,
    GS.combo
  );

  UI.animateScore();
}
  }

  // ── Obstacles ──
  if (GS.invFrames > 0) return;
  for (const obs of R.getObstacles()) {
    if (!obs.userData.lanes.includes(GS.lane)) continue;
    const dz = Math.abs(obs.position.z - pz);
    if (dz > 3) continue;

    const child = obs.children[0];
    if (!child) continue;
    const obsH = child.geometry.parameters.height || 1;
    const obsY = child.position.y;

    // Tall obstacle: jumping clears if player is high enough
    if (obs.userData.type === 'tall' && GS.jumping && py > obsH * 0.55) continue;

    if (dz < 1.3) {

      if (GS.shield) {

        GS.shield = false;
    
        UI.showFeedback('🛡 SHIELD USED', 1);

       R.removeObstacle(obs);

       return;
     }

    handleHit();
    return;
    }
  }
}

function handleHit() {
  GS.invFrames = 90;
  GS.combo = 0;
  GS.comboTimer = 0;
  Audio.play('hit');
  R.shake(18);
  UI.flash();
  document.getElementById('combo-text').textContent = '';
  setTimeout(triggerGameOver, 350);
}


/* ═══════════════════════════════════════════════════════════
   PLAYER ACTIONS
═══════════════════════════════════════════════════════════ */
function triggerJump() {
  if (GS.jumping || GS.phase !== 'playing') return;
  GS.jumping = true;
  GS.velY    = C.JUMP_FORCE;
  Audio.play('jump');
  UI.showFeedback('↑ JUMP', 0);
}

function triggerLeft() {
  if (GS.lane <= 0 || GS.phase !== 'playing') return;
  GS.lane--;
  Audio.play('swoosh');
}

function triggerRight() {
  if (GS.lane >= 2 || GS.phase !== 'playing') return;
  GS.lane++;
  Audio.play('swoosh');
}


/* ═══════════════════════════════════════════════════════════
   GAME LOOP
═══════════════════════════════════════════════════════════ */
let rafId = null;
let lastT  = 0;

function gameLoop(ts) {
  rafId = requestAnimationFrame(gameLoop);
  const dt = Math.min((ts - lastT) / 16.667, 3); // cap at 3x slowdown
  lastT = ts;

  if (GS.phase !== 'playing') {
    R.render(GS); // keep rendering during countdown
    return;
  }

  GS.frame++;

  // ── Speed ramp ──
  GS.speed = Math.min(C.SPEED_MAX, GS.speed + C.SPEED_ACCEL * dt * 60);
  GS.distance += GS.speed * dt;

  // ── Vertical physics ──
  if (GS.jumping || GS.playerY > 0) {
    GS.velY   += C.GRAVITY * dt;
    GS.playerY = Math.max(0, GS.playerY + GS.velY * dt * 3);
    if (GS.playerY <= 0 && GS.jumping) {
      GS.playerY    = 0;
      GS.velY       = 0;
      GS.jumping    = false;
      GS.squashTimer = 8;
    }
  }

  // ── Timers ──
  if (GS.comboTimer > 0) { GS.comboTimer -= dt; if (GS.comboTimer <= 0) { GS.combo = 0; document.getElementById('combo-text').textContent = ''; } }
  if (GS.invFrames > 0)  GS.invFrames -= dt;

  // ── Spawning ──
  GS.nextObs -= dt;
  if (GS.nextObs <= 0) {
    R.spawnObstacle(GS.speed);
    GS.nextObs = lerp(C.OBS_INTERVAL_MIN, C.OBS_INTERVAL_MAX, Math.random()) / Math.max(1, GS.speed / C.SPEED_START * 0.6);
  }
  GS.nextCoin -= dt;
  if (GS.nextCoin <= 0) {
    if (Math.random() < 0.18) {
      R.spawnMagnet();
    } else {
      R.spawnCoins();
    }
    GS.nextCoin = lerp(C.COIN_INTERVAL_MIN, C.COIN_INTERVAL_MAX, Math.random());
  }
  // ── Magnet Effect ──
 if (GS.magnet) {

  GS.magnetTimer -= dt;

  if (GS.magnetTimer <= 0) {
    GS.magnet = false;
  }

  for (const coin of R.getCoins()) {

    const dx = GS.playerX - coin.position.x;
    const dz = 0 - coin.position.z;

    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < 6) {

      coin.position.x += dx * 0.08;
      coin.position.z += dz * 0.08;
    }
  }
 }
  // ── Collision ──
  checkCollisions();

  // ── Render ──
  R.update(GS);
  R.render(GS);

  // ── HUD ──
  UI.updateHUD();
}

function lerp(a, b, t) { return a + (b - a) * t; }


/* ═══════════════════════════════════════════════════════════
   UI — screen management, HUD updates
═══════════════════════════════════════════════════════════ */
const UI = (() => {
  function show(id)  { document.getElementById(id).classList.remove('hidden'); }
  function hide(id)  { document.getElementById(id).classList.add('hidden'); }

  function showFeedback(label, combo) {
    // Update combo counter
    const comboEl = document.getElementById('combo-text');
    if (combo >= 3) {
      comboEl.textContent = `×${combo} COMBO`;
      comboEl.style.transform = 'scale(1.2)';
      setTimeout(() => { if(comboEl) comboEl.style.transform = ''; }, 120);
    } else {
      comboEl.textContent = combo >= 1 ? `×${combo}` : '';
    }

    // Show label
    if (label) {
      const el = document.getElementById('feedback-text');
      el.textContent = label;
      el.style.color = label.includes('PERFECT') ? '#ff6d00' :
                       label.includes('GREAT')   ? '#ffe600' :
                       label.includes('JUMP')    ? '#00e5ff' : '#00ff88';
      el.style.textShadow = `0 0 20px currentColor`;
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
    }
  }

  function animateScore() {
    const el = document.getElementById('hud-score');
    if (!el) return;
    el.style.transform = 'scale(1.3)';
    el.style.color = '#ffe600';
    setTimeout(() => { el.style.transform = ''; el.style.color = ''; }, 130);
  }

  function updateHUD() {
    const score = Math.floor(GS.score + GS.distance * 2.5);
    document.getElementById('hud-score').textContent = score;
    document.getElementById('hud-dist').textContent  = Math.floor(GS.distance) + 'm';
  }

  function flash() {
    const el = document.getElementById('flash-overlay');
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  function showCountdown(cb) {
    show('screen-countdown');
    const numEl = document.getElementById('countdown-num');
    let n = 3;
    numEl.textContent = n;

    const colors = ['var(--c-cyan)', 'var(--c-orange)', 'var(--c-pink)', 'var(--c-green)'];

    const tick = () => {
      n--;
      numEl.style.color = colors[n % colors.length] || 'var(--c-green)';
      numEl.style.textShadow = `0 0 40px currentColor, 0 0 100px currentColor`;

      if (n > 0) {
        numEl.textContent = n;
        numEl.style.animation = 'none';
        void numEl.offsetWidth;
        numEl.style.animation = 'cdPop 0.7s cubic-bezier(.17,.67,.35,1.3) both';
        setTimeout(tick, 900);
      } else {
        numEl.textContent = 'GO!';
        numEl.style.animation = 'none';
        void numEl.offsetWidth;
        numEl.style.animation = 'cdPop 0.7s cubic-bezier(.17,.67,.35,1.3) both';
        setTimeout(() => {
          hide('screen-countdown');
          cb();
        }, 700);
      }
    };
    setTimeout(tick, 900);
  }

  return { show, hide, showFeedback, animateScore, updateHUD, flash, showCountdown };
})();


/* ═══════════════════════════════════════════════════════════
   GAME FLOW
═══════════════════════════════════════════════════════════ */
function resetState() {
  GS.phase     = 'playing';
  GS.score     = 0;
  GS.distance  = 0;
  GS.combo     = 0;
  GS.comboTimer = 0;
  GS.lane      = 1;
  GS.playerX   = C.LANES[1];
  GS.playerY   = 0;
  GS.velY      = 0;
  GS.jumping   = false;
  GS.squashTimer = 0;
  GS.invFrames = 0;
  GS.speed     = C.SPEED_START;
  GS.frame     = 0;
  GS.nextObs   = 70;
  GS.nextCoin  = 40;
  GS.gestHandLoss = 0;
  GS.lastJumpTime = 0;
  R.clearLevel();
}

function startGame() {

  const bgm = document.getElementById('bgm');

  if (bgm) {

    bgm.volume = 0.35;

    bgm.play().catch(err => console.log(err));
  }

  Audio.init();

  Gesture.stopPreview();

  UI.hide('screen-start');

  UI.show('screen-game');

  resetState();

  GS.phase = 'countdown';

  UI.showCountdown(() => {

    GS.phase = 'playing';

    Gesture.init('video-game', 'canvas-game', null);

  });
}

function triggerGameOver() {
  if (GS.phase === 'dead') return;
  GS.phase = 'dead';
  Audio.play('gameover');

  const finalScore = Math.floor(GS.score + GS.distance * 2.5);
  if (finalScore > GS.highScore) {
    GS.highScore = finalScore;
    localStorage.setItem('fr_hs', GS.highScore);
  }

  document.getElementById('go-score').textContent = finalScore;
  document.getElementById('go-dist').textContent  = Math.floor(GS.distance) + 'm';
  document.getElementById('go-hs').textContent    = GS.highScore;

  const msgs = [
    'Keep pushing, legend! 🔥',
    'Your reflexes are sharpening! ⚡',
    'The neon city demands more! 🌆',
    'Almost there — one more run! 💪',
    "The street won't beat you twice! 🎯",
  ];
  document.getElementById('go-msg').textContent =
    finalScore >= GS.highScore ? '🏆 NEW BEST SCORE! Legendary!' : msgs[Math.floor(Math.random() * msgs.length)];

  setTimeout(() => {
    UI.hide('screen-game');
    UI.show('screen-gameover');
  }, 500);
}

function replayGame() {
  UI.hide('screen-gameover');
  UI.show('screen-game');
  resetState();
  GS.phase = 'countdown';
  UI.showCountdown(() => { GS.phase = 'playing'; });
}

function goMenu() {
  UI.hide('screen-gameover');
  document.getElementById('hs-val').textContent = GS.highScore;
  UI.show('screen-start');
  GS.phase = 'start';
  Gesture.initPreview();
}


/* ═══════════════════════════════════════════════════════════
   KEYBOARD FALLBACK (always available as backup)
═══════════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (GS.phase !== 'playing') return;
  switch (e.key) {
    case 'ArrowLeft':  case 'a': case 'A': triggerLeft();  break;
    case 'ArrowRight': case 'd': case 'D': triggerRight(); break;
    case 'ArrowUp':    case 'w': case 'W': triggerJump();  break;
    case ' ':                               triggerJump();  break;
  }
});


/* ═══════════════════════════════════════════════════════════
   BUTTON BINDINGS
═══════════════════════════════════════════════════════════ */
document.getElementById('btn-start').addEventListener('click', startGame);
document.getElementById('btn-replay').addEventListener('click', replayGame);
document.getElementById('btn-menu').addEventListener('click', goMenu);


/* ═══════════════════════════════════════════════════════════
   LOADING + BOOT
═══════════════════════════════════════════════════════════ */
const LOAD_STEPS = [
  { label: 'Initializing renderer…', pct: 18 },
  { label: 'Building neon city…',    pct: 38 },
  { label: 'Loading gesture AI…',    pct: 58 },
  { label: 'Calibrating zones…',     pct: 78 },
  { label: 'Scanning player…',       pct: 92 },
  { label: 'Ready!',                 pct: 100 },
];

function runLoader(onDone) {
  const bar    = document.getElementById('loading-bar');
  const status = document.getElementById('loading-status');
  let step = 0;

  function tick() {
    if (step >= LOAD_STEPS.length) { onDone(); return; }
    const s = LOAD_STEPS[step++];
    bar.style.width    = s.pct + '%';
    status.textContent = s.label;
    setTimeout(tick, 280 + Math.random() * 180);
  }
  tick();
}

window.addEventListener('load', () => {
  // Init Three.js immediately
  R.init();

  // Start render loop (shows scene while loading)
  lastT = performance.now();
  requestAnimationFrame(gameLoop);

  // Init gesture preview (camera preview on start screen)
  // — done after loading so MediaPipe is ready
  runLoader(() => {
    // Fade out loading screen
    const ls = document.getElementById('screen-loading');
    ls.style.transition = 'opacity 0.45s ease';
    ls.style.opacity = '0';
    setTimeout(() => {
      ls.classList.add('hidden');
      GS.phase = 'start';
      document.getElementById('hs-val').textContent = GS.highScore;
      UI.show('screen-start');
      // Start webcam preview on start screen
      Gesture.initPreview();
    }, 470);
  });
});
