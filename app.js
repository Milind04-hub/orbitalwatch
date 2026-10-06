// OrbitalWatch — 3D space-junk tracker
// Data: CelesTrak GP element sets (NORAD two-line elements, the catalog NASA's
// Orbital Debris Program Office tracks). Propagation: SGP4 via satellite.js.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const EARTH_RADIUS_KM = 6371;
const SCALE = 1 / 1000; // 1 scene unit = 1000 km

// ---------------------------------------------------------------------------
// Catalog groups (CelesTrak GP queries)
// ---------------------------------------------------------------------------
const GROUPS = [
  { id: "cosmos-2251-debris", name: "Cosmos 2251 debris", color: 0xff5d5d, on: true,
    desc: "2009 Iridium-Cosmos collision" },
  { id: "iridium-33-debris", name: "Iridium 33 debris", color: 0xff9d4d, on: true,
    desc: "2009 Iridium-Cosmos collision" },
  { id: "fengyun-1c-debris", name: "Fengyun 1C debris", color: 0xffe14d, on: true,
    desc: "2007 Chinese ASAT test" },
  { id: "cosmos-1408-debris", name: "Cosmos 1408 debris", color: 0xc44dff, on: true,
    desc: "2021 Russian ASAT test" },
  { id: "stations", name: "Crewed stations", color: 0x4dff88, on: true,
    desc: "ISS, Tiangong & visitors" },
  { id: "last-30-days", name: "Recent launches", color: 0x4da3ff, on: false,
    desc: "Objects launched in last 30 days" },
  // Constellations / operators
  { id: "starlink", name: "Starlink (SpaceX)", color: 0x7ffff2, on: true,
    desc: "SpaceX broadband megaconstellation" },
  { id: "oneweb", name: "OneWeb (Eutelsat)", color: 0xff7ad6, on: true,
    desc: "OneWeb broadband constellation" },
  { id: "iridium-NEXT", name: "Iridium NEXT", color: 0xffa3a3, on: true,
    desc: "Iridium satellite-phone constellation" },
  { id: "gps-ops", name: "GPS (USA)", color: 0xb8ff5e, on: true,
    desc: "US GPS navigation constellation" },
  { id: "glo-ops", name: "GLONASS (Russia)", color: 0xff9e5e, on: true,
    desc: "Russian navigation constellation" },
  { id: "galileo", name: "Galileo (EU)", color: 0x5e9eff, on: true,
    desc: "European navigation constellation" },
  { id: "beidou", name: "BeiDou (China)", color: 0xe05eff, on: true,
    desc: "Chinese navigation constellation" },
  // Catch-all — parsed LAST so named groups above claim their objects first
  { id: "active", name: "Other active satellites", color: 0x7fd4ff, on: true,
    desc: "Everything else in the public operational catalog" },
];

const TLE_URL = (g) =>
  `https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`;

// Minimal offline fallback so the app still works without network/CORS.
const FALLBACK_TLES = {
  stations: `ISS (ZARYA)
1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9000
2 25544  51.6400 208.9163 0006317  69.9862 290.2553 15.49815308  1000
CSS (TIANHE)
1 48274U 21035A   24001.50000000  .00021000  00000-0  24000-3 0  9000
2 48274  41.4700 200.0000 0005000  90.0000 270.0000 15.60000000  1000`,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/** Every tracked object: {name, noradId, satrec, groupIdx, idx, alive} */
const objects = [];
let simTime = new Date();
let speed = 1;          // sim seconds per real second
let playing = true;
let selected = null;    // object reference
let following = false;
let altMin = 0, altMax = 50000;

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 5000);
camera.position.set(18, 9, 18);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.getElementById("canvas-container").appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 7;
controls.maxDistance = 400;

// Bloom post-processing: bright pixels (city lights pushed into HDR, sunlit
// limb, metallic glints) bleed light into their surroundings — the glow.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(innerWidth, innerHeight),
  0.6,    // strength
  0.3,    // radius — tight glow, not a broad haze
  0.65);  // threshold — only the bright city cores glow
composer.addPass(bloomPass);

scene.add(new THREE.AmbientLight(0x445566, 0.55));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(50, 20, 30);
scene.add(sun);

// Real Sun direction in ECI (low-precision solar ephemeris, ~0.01° good).
// Satellites live in the inertial scene frame, so this makes the day/night
// terminator on Earth track actual UTC.
function sunDirectionECI(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;                       // days since J2000
  const L = (280.460 + 0.9856474 * n) % 360;      // mean longitude (deg)
  const g = ((357.528 + 0.9856003 * n) % 360) * Math.PI / 180; // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * Math.PI / 180; // ecliptic lon
  const eps = (23.439 - 0.0000004 * n) * Math.PI / 180; // obliquity
  // ECI unit vector
  const x = Math.cos(lambda);
  const y = Math.cos(eps) * Math.sin(lambda);
  const z = Math.sin(eps) * Math.sin(lambda);
  // ECI (x,y,z) -> three.js (x, z, -y), matching the satellite mapping
  return new THREE.Vector3(x, z, -y);
}

// Stars
{
  const n = 3000, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(1500 + Math.random() * 1000);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8899bb, size: 1.2, sizeAttenuation: false })));
}

// Earth (rotates with GMST so ECI positions line up with geography)
const earthGroup = new THREE.Group();
scene.add(earthGroup);
let earthMat; // day/night shader — sun direction updated each frame
{
  const loader = new THREE.TextureLoader();
  // Load locally-hosted textures first (no CDN dependency); fall back to unpkg
  // only if a local file is missing.
  const loadTex = (local, cdn) => loader.load(
    local,
    undefined,
    undefined,
    () => { console.warn(`Local texture ${local} failed, trying CDN`); loader.load(cdn, (t) => { t.colorSpace = THREE.SRGBColorSpace; earthMat.uniforms[local.includes("night") ? "nightMap" : "dayMap"].value = t; }); });
  const dayTex = loadTex("assets/earth-day.jpg", "https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg");
  const nightTex = loadTex("assets/earth-night.jpg", "https://unpkg.com/three-globe@2.31.0/example/img/earth-night.jpg");
  dayTex.colorSpace = THREE.SRGBColorSpace;
  nightTex.colorSpace = THREE.SRGBColorSpace;
  // Blend a sunlit day texture with a city-lights night texture across the
  // terminator, so the dark hemisphere still reads as Earth at any camera angle.
  earthMat = new THREE.ShaderMaterial({
    uniforms: {
      dayMap: { value: dayTex },
      nightMap: { value: nightTex },
      sunDir: { value: new THREE.Vector3(1, 0, 0) }, // world-space, set per frame
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldN;
      void main() {
        vUv = uv;
        vWorldN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D dayMap;
      uniform sampler2D nightMap;
      uniform vec3 sunDir;
      varying vec2 vUv;
      varying vec3 vWorldN;
      void main() {
        float s = dot(normalize(vWorldN), normalize(sunDir));
        float day = smoothstep(-0.05, 0.25, s);            // soft terminator
        vec3 dayTex = texture2D(dayMap, vUv).rgb;
        vec3 nightTex = texture2D(nightMap, vUv).rgb;
        // Sunlit surface fading to a near-black night side (like Google Earth);
        // only a whisper of earthshine so continents aren't pure void.
        vec3 surface = mix(dayTex * 0.008, dayTex * (0.12 + 0.88 * clamp(s, 0.0, 1.0)), day);
        // City lights: pushed into HDR so the bloom pass adds a tight glow.
        // A gentle gate removes only the faintest background haze.
        float lights = 1.0 - smoothstep(-0.16, 0.02, s);
        float lum = dot(nightTex, vec3(0.4));
        vec3 cities = nightTex * smoothstep(0.02, 0.10, lum); // gate out faint background
        float warm = smoothstep(0.10, 0.35, lum);
        vec3 cityGlow = cities * (4.5 + 5.0 * warm) * lights;
        gl_FragColor = vec4(surface + cityGlow, 1.0);
      }`,
  });
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS_KM * SCALE, 64, 64), earthMat);
  earthGroup.add(earth);

  // Atmosphere glow
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS_KM * SCALE * 1.025, 64, 64),
    new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false,
      vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix*normal);
        gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vN; void main(){
        float i = pow(0.62 - dot(vN, vec3(0,0,-1.0)), 4.0);
        gl_FragColor = vec4(0.3, 0.6, 1.0, 1.0) * i * 0.55; }`,
    }));
  earthGroup.add(atmo);
}

// Instanced 3D meshes: tumbling shard fragments for debris, a body+solar-panel
// model for intact spacecraft. (Sizes are wildly exaggerated and scale with
// camera distance — real debris would be subpixel at this zoom.)
let meshes = [];        // [{mesh, objs: [object,...]}]
let pointScale = 1;     // from the size slider
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const dummy = new THREE.Object3D();
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

function makeShardGeometry(seed) {
  // Low-poly icosahedron with jittered vertices -> irregular fragment
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const pos = geo.attributes.position;
  let s = seed;
  const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i,
      pos.getX(i) * (0.45 + rand() * 0.9),
      pos.getY(i) * (0.45 + rand() * 0.9),
      pos.getZ(i) * (0.45 + rand() * 0.9));
  }
  geo.computeVertexNormals();
  return geo;
}

function makeSatelliteGeometry() {
  // Bus + two solar panel wings + antenna dish
  const bus = new THREE.BoxGeometry(0.7, 0.7, 1.1);
  const panelL = new THREE.BoxGeometry(2.2, 0.04, 0.8);
  panelL.translate(-1.55, 0, 0);
  const panelR = panelL.clone();
  panelR.translate(3.1, 0, 0);
  const dish = new THREE.CylinderGeometry(0.28, 0.38, 0.18, 10);
  dish.rotateX(Math.PI / 2);
  dish.translate(0, 0, 0.68);
  return BufferGeometryUtils.mergeGeometries([bus, panelL, panelR, dish]);
}

function buildInstancedMeshes() {
  // Variant geometries: 3 shard shapes for debris, 1 satellite shape
  const variants = [
    { geo: makeShardGeometry(1234), debris: true },
    { geo: makeShardGeometry(5678), debris: true },
    { geo: makeShardGeometry(9012), debris: true },
    { geo: makeSatelliteGeometry(), debris: false },
  ];
  // Assign each object to a variant
  const buckets = variants.map(() => []);
  for (const o of objects) {
    const isDebris = GROUPS[o.groupIdx].id.includes("debris");
    const vi = isDebris ? o.idx % 3 : 3;
    o.rotAxis = new THREE.Vector3().randomDirection();
    o.rotSpeed = isDebris ? 0.5 + Math.random() * 2.5 : 0.05; // debris tumbles
    o.rotPhase = Math.random() * Math.PI * 2;
    o.scaleVar = 0.7 + Math.random() * 0.7;
    buckets[vi].push(o);
  }
  const mat = new THREE.MeshStandardMaterial({ metalness: 0.65, roughness: 0.45 });
  meshes = variants.map((v, vi) => {
    const objs = buckets[vi];
    const mesh = new THREE.InstancedMesh(v.geo, mat, Math.max(objs.length, 1));
    mesh.frustumCulled = false;
    objs.forEach((o, ii) => {
      o.meshIdx = vi;
      o.instId = ii;
      // Tint by group color, debris slightly varied so the cloud has texture
      const c = new THREE.Color(GROUPS[o.groupIdx].color);
      if (v.debris) c.multiplyScalar(0.75 + Math.random() * 0.45);
      mesh.setColorAt(ii, c);
      mesh.setMatrixAt(ii, ZERO_SCALE);
    });
    mesh.instanceColor.needsUpdate = true;
    mesh.userData.objs = objs;
    scene.add(mesh);
    return { mesh, objs };
  });
}

// Selection marker + orbit line
const marker = new THREE.Mesh(
  new THREE.RingGeometry(0.12, 0.15, 32),
  new THREE.MeshBasicMaterial({ color: 0xffb84d, side: THREE.DoubleSide, depthTest: false }));
marker.visible = false;
marker.renderOrder = 10;
scene.add(marker);

let orbitLine = null;

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
// CelesTrak rate-limits repeated queries (HTTP 403 for ~2 h), so cache each
// group in localStorage and refetch at most once per TTL. A stale cache is
// still used if the network/CelesTrak refuses.
const CACHE_TTL_MS = 2 * 3600 * 1000;

function cacheGet(id) {
  try {
    const raw = localStorage.getItem(`tle:${id}`);
    if (!raw) return null;
    const { t, text } = JSON.parse(raw);
    return { fresh: Date.now() - t < CACHE_TTL_MS, text };
  } catch { return null; }
}

function cachePut(id, text) {
  // localStorage is only ~5 MB; the big constellations (Starlink, active) have
  // local files in data/ as their fallback, so don't waste quota caching them.
  if (text.length > 400_000) return;
  try { localStorage.setItem(`tle:${id}`, JSON.stringify({ t: Date.now(), text })); }
  catch { /* quota full — fine, we just refetch or use the local file */ }
}

async function fetchGroupText(group) {
  const cached = cacheGet(group.id);
  if (cached?.fresh) return cached.text;
  // Don't hammer CelesTrak while it's rate-limiting us (403s extend the block)
  const blockedUntil = parseInt(localStorage.getItem(`tleblock:${group.id}`) || "0", 10);
  if (Date.now() < blockedUntil) {
    group.offline = !cached;
    return cached?.text || (await fetchLocalFile(group.id)) || FALLBACK_TLES[group.id] || "";
  }
  try {
    const res = await fetch(TLE_URL(group.id));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    cachePut(group.id, text);
    return text;
  } catch (e) {
    console.warn(`Fetch failed for ${group.id}:`, e);
    if (String(e).includes("403")) {
      try { localStorage.setItem(`tleblock:${group.id}`, String(Date.now() + 30 * 60000)); } catch {}
    }
    group.offline = !cached;
    return cached?.text || (await fetchLocalFile(group.id)) || FALLBACK_TLES[group.id] || "";
  }
}

// Locally stored snapshot (data/<group>.tle) — manually downloaded copies used
// when CelesTrak is rate-limiting live fetches.
async function fetchLocalFile(id) {
  try {
    const res = await fetch(`data/${id}.tle`);
    if (!res.ok) return null;
    const text = await res.text();
    return text.startsWith("1 ") || /\n1 /.test(text.slice(0, 500)) || text.length > 100 ? text : null;
  } catch { return null; }
}

const seenNoradIds = new Set(); // groups overlap (e.g. Starlink ⊂ active) — first parse wins

function parseTLEs(text, groupIdx) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length);
  for (let i = 0; i + 2 < lines.length + 1; ) {
    let name = "UNKNOWN", l1, l2;
    if (lines[i].startsWith("1 ") && lines[i + 1]?.startsWith("2 ")) {
      l1 = lines[i]; l2 = lines[i + 1]; i += 2;
    } else {
      name = lines[i]; l1 = lines[i + 1]; l2 = lines[i + 2]; i += 3;
    }
    if (!l1?.startsWith("1 ") || !l2?.startsWith("2 ")) continue;
    const noradId = l1.slice(2, 7).trim();
    if (seenNoradIds.has(noradId)) continue;
    seenNoradIds.add(noradId);
    const satrec = satellite.twoline2satrec(l1, l2);
    if (satrec.error) continue;
    objects.push({
      name: name.trim(),
      noradId,
      satrec, groupIdx,
      idx: objects.length,
      alive: true,
      visible: true,
      inclination: parseFloat(l2.slice(8, 16)),
      periodMin: 1440 / parseFloat(l2.slice(52, 63)),
      pos: new THREE.Vector3(),
      altKm: 0, velKmS: 0,
    });
  }
}

async function loadAll() {
  const loadingText = document.getElementById("loading-text");
  let done = 0;
  // Fetch all groups in parallel, but parse strictly in GROUPS order so the
  // named constellation groups claim their satellites before the catch-all.
  const texts = await Promise.all(GROUPS.map(async (g) => {
    const t = await fetchGroupText(g);
    loadingText.textContent = `Fetched ${++done}/${GROUPS.length} catalogs…`;
    return t;
  }));
  texts.forEach((text, i) => parseTLEs(text, i));
  loadingText.textContent = `Loaded ${objects.length.toLocaleString()} objects…`;
  buildInstancedMeshes();
  buildGroupToggles();
  document.getElementById("loading").remove();
}

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------
const tmpV = new THREE.Vector3();

function propagateAll(date, nowSec) {
  const gmst = satellite.gstime(date);
  earthGroup.rotation.y = gmst;
  const sunDir = sunDirectionECI(date);
  sun.position.copy(sunDir).multiplyScalar(100);
  earthMat.uniforms.sunDir.value.copy(sunDir); // scene frame = ECI, so no rotation needed

  for (const o of objects) {
    if (!o.alive) { continue; }
    const pv = satellite.propagate(o.satrec, date);
    if (!pv || !pv.position) { o.alive = false; hideObject(o); continue; }
    const p = pv.position; // ECI km
    // ECI (x,y,z) -> three.js (x, z, -y): keep Earth's pole on +Y
    o.pos.set(p.x * SCALE, p.z * SCALE, -p.y * SCALE);
    o.altKm = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) - EARTH_RADIUS_KM;
    if (pv.velocity) {
      const v = pv.velocity;
      o.velKmS = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    }
    const show = GROUPS[o.groupIdx].on && o.altKm >= altMin && o.altKm <= altMax;
    o.visible = show;
    const mesh = meshes[o.meshIdx].mesh;
    if (show) {
      // Keep objects readable at any zoom: scale with camera distance, but stay
      // small relative to Earth (radius 6.37u) so the swarm never buries it.
      const dist = camera.position.distanceTo(o.pos);
      const s = THREE.MathUtils.clamp(dist * 0.0016, 0.004, 0.05) * o.scaleVar * pointScale;
      const ang = o.rotPhase + nowSec * o.rotSpeed;
      dummy.position.copy(o.pos);
      dummy.quaternion.setFromAxisAngle(o.rotAxis, ang);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      mesh.setMatrixAt(o.instId, dummy.matrix);
    } else {
      mesh.setMatrixAt(o.instId, ZERO_SCALE);
    }
  }
  for (const m of meshes) m.mesh.instanceMatrix.needsUpdate = true;
}

function hideObject(o) {
  if (o.meshIdx !== undefined) {
    meshes[o.meshIdx].mesh.setMatrixAt(o.instId, ZERO_SCALE);
  }
}

// Orbit path for the selected object: one full period sampled in ECI
function buildOrbitLine(o) {
  if (orbitLine) { scene.remove(orbitLine); orbitLine.geometry.dispose(); orbitLine = null; }
  if (!document.getElementById("show-orbits").checked) return;
  const samples = 180;
  const pts = [];
  const periodMs = o.periodMin * 60000;
  for (let i = 0; i <= samples; i++) {
    const t = new Date(simTime.getTime() + (i / samples) * periodMs);
    const pv = satellite.propagate(o.satrec, t);
    if (!pv || !pv.position) continue;
    pts.push(new THREE.Vector3(pv.position.x * SCALE, pv.position.z * SCALE, -pv.position.y * SCALE));
  }
  if (pts.length < 2) return;
  orbitLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: GROUPS[o.groupIdx].color, transparent: true, opacity: 0.55 }));
  scene.add(orbitLine);
}

// ---------------------------------------------------------------------------
// UI — group toggles & stats
// ---------------------------------------------------------------------------
function buildGroupToggles() {
  const container = document.getElementById("group-toggles");
  container.innerHTML = "";
  GROUPS.forEach((g, gi) => {
    const count = objects.filter((o) => o.groupIdx === gi).length;
    const label = document.createElement("label");
    label.className = "group-toggle";
    label.title = g.desc + (g.offline ? " (offline fallback)" : "");
    label.innerHTML = `
      <input type="checkbox" ${g.on ? "checked" : ""} />
      <span class="swatch" style="background:#${g.color.toString(16).padStart(6, "0")}"></span>
      <span>${g.name}</span>
      <span class="count">${count.toLocaleString()}</span>`;
    label.querySelector("input").addEventListener("change", (e) => {
      g.on = e.target.checked;
    });
    container.appendChild(label);
  });
}

function updateStats() {
  let visible = 0, leo = 0, meo = 0, geoPlus = 0;
  for (const o of objects) {
    if (!o.alive || !o.visible) continue;
    visible++;
    if (o.altKm < 2000) leo++;
    else if (o.altKm < 35000) meo++;
    else geoPlus++;
  }
  document.getElementById("stats").innerHTML =
    `Tracked objects: <b>${objects.length.toLocaleString()}</b><br>` +
    `Visible now:     <b>${visible.toLocaleString()}</b><br>` +
    `LEO (&lt;2000 km): <b>${leo.toLocaleString()}</b><br>` +
    `MEO:             <b>${meo.toLocaleString()}</b><br>` +
    `GEO &amp; beyond:  <b>${geoPlus.toLocaleString()}</b>`;
}

// ---------------------------------------------------------------------------
// SATCAT enrichment — catalog metadata + plain-English descriptions
// ---------------------------------------------------------------------------
const OWNERS = {
  US: "United States", CIS: "Russia/CIS", PRC: "China", ISS: "ISS partnership",
  ESA: "European Space Agency", JPN: "Japan", IND: "India", FR: "France",
  UK: "United Kingdom", GER: "Germany", CA: "Canada", IT: "Italy", SPN: "Spain",
  SKOR: "South Korea", NKOR: "North Korea", TWN: "Taiwan", AUS: "Australia",
  BRAZ: "Brazil", ARGN: "Argentina", TURK: "Turkey", UAE: "UAE", ISRA: "Israel",
  IRAN: "Iran", NETH: "Netherlands", NOR: "Norway", SWED: "Sweden",
  EUTE: "Eutelsat", SES: "SES (Luxembourg)", GLOB: "Globalstar", IRID: "Iridium",
  ORB: "Orbcomm", O3B: "SES O3b", ITSO: "Intelsat", IM: "Inmarsat",
  EUME: "EUMETSAT", AB: "Arabsat", STCT: "SingTel", THAI: "Thailand",
};
const LAUNCH_SITES = {
  AFETR: "Cape Canaveral, USA", AFWTR: "Vandenberg, USA", KSCUT: "Uchinoura, Japan",
  TYMSC: "Baikonur, Kazakhstan", PLMSC: "Plesetsk, Russia", VOSTO: "Vostochny, Russia",
  KYMSC: "Kapustin Yar, Russia", DLS: "Dombarovsky, Russia", SVOBO: "Svobodny, Russia",
  TAISC: "Taiyuan, China", XICLF: "Xichang, China", JSC: "Jiuquan, China",
  WENCH: "Wenchang, China", TANSC: "Tanegashima, Japan", SRILR: "Sriharikota, India",
  FRGUI: "Kourou, French Guiana", WLPIS: "Wallops Island, USA", KODAK: "Kodiak, USA",
  RLLB: "Mahia, New Zealand", SEAL: "Sea Launch platform", SNMLP: "San Marco, Kenya",
  ERAS: "Pegasus air-launch", SEM: "Semnan, Iran", YUN: "Yunsong, North Korea",
};
const TYPE_NAMES = { PAY: "Payload (satellite)", "R/B": "Rocket body", DEB: "Debris", UNK: "Unknown" };
const OPS_STATUS = {
  "+": "Operational", "-": "Non-operational", P: "Partially operational",
  B: "Backup/standby", S: "Spare", X: "Extended mission", D: "Decayed", "?": "Unknown",
};

// Pattern-matched blurbs for recognizable satellite families
const BLURBS = [
  [/^ISS|ZARYA|NAUKA/, "Module of the International Space Station, the largest crewed laboratory in orbit, continuously inhabited since November 2000."],
  [/^CSS|TIANHE|WENTIAN|MENGTIAN|TIANGONG/, "Module of China's Tiangong space station, crewed continuously since 2022."],
  [/^STARLINK/, "SpaceX Starlink broadband internet satellite — part of the largest constellation in orbit (7,000+ active)."],
  [/^ONEWEB/, "OneWeb (Eutelsat Group) low-Earth-orbit broadband internet satellite."],
  [/^IRIDIUM 33 DEB/, "Fragment of Iridium 33, destroyed on 10 Feb 2009 when defunct Cosmos 2251 hit it at 11.7 km/s over Siberia — the first accidental hypervelocity collision of two intact satellites."],
  [/^IRIDIUM/, "Iridium satellite-phone constellation spacecraft (66 active in polar LEO)."],
  [/^COSMOS 2251 DEB/, "Fragment of Cosmos 2251, a defunct Russian military comsat that collided with Iridium 33 in 2009, creating ~2,000 tracked fragments."],
  [/^COSMOS 1408 DEB/, "Fragment of Cosmos 1408, a dead Soviet signals-intelligence satellite destroyed by a Russian anti-satellite missile test on 15 Nov 2021; the debris forced ISS crews to shelter."],
  [/^FENGYUN 1C DEB/, "Fragment of Fengyun-1C, a Chinese weather satellite destroyed by China's 2007 anti-satellite missile test — the single worst debris event ever (~3,500 tracked fragments)."],
  [/^(NAVSTAR|GPS)/, "US GPS navigation satellite in 20,200 km medium Earth orbit."],
  [/^GLONASS|^COSMOS.*\(GLONASS/, "Russian GLONASS navigation satellite, GPS counterpart."],
  [/^GALILEO/, "European Galileo navigation satellite."],
  [/^BEIDOU/, "Chinese BeiDou navigation satellite."],
  [/^HST$/, "The Hubble Space Telescope, launched 1990 — arguably the most productive scientific instrument ever built."],
  [/^NOAA/, "US NOAA weather satellite."],
  [/^GOES/, "US geostationary weather satellite (NOAA GOES series)."],
  [/^METOP/, "European polar-orbiting weather satellite (EUMETSAT)."],
  [/^FENGYUN/, "Chinese Fengyun weather satellite."],
  [/^GAOFEN/, "Chinese Gaofen Earth-observation satellite."],
  [/^YAOGAN/, "Chinese Yaogan reconnaissance satellite series."],
  [/^COSMOS/, "Cosmos — generic designation the USSR/Russia uses for most military and experimental satellites."],
  [/^OBJECT [A-Z]/, "Recently catalogued object not yet formally identified."],
  [/\bDEB\b/, "Catalogued debris fragment, tracked because even centimeter-scale junk hits with rifle-bullet energy at orbital speeds."],
  [/\bR\/B\b|^CZ-|^SL-|^FALCON|^ATLAS|^DELTA|^ARIANE|^H-2|^PSLV|^GSLV/, "Spent rocket upper stage left in orbit after delivering its payload — one of the most common types of large space junk."],
];

function describeObject(o, sc) {
  for (const [re, text] of BLURBS) if (re.test(o.name)) return text;
  const t = sc?.OBJECT_TYPE;
  if (t === "DEB") return "Catalogued debris fragment.";
  if (t === "R/B") return "Spent rocket stage abandoned in orbit.";
  if (t === "PAY") return "Catalogued satellite payload.";
  return "Tracked orbital object; not yet identified in public records.";
}

async function fetchSatcat(noradId) {
  const key = `satcat:${noradId}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const { t, rec } = JSON.parse(raw);
      if (Date.now() - t < 30 * 86400e3) return rec;
    }
  } catch {}
  const res = await fetch(`https://celestrak.org/satcat/records.php?CATNR=${noradId}&FORMAT=json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rec = (await res.json())[0] || null;
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), rec })); } catch {}
  return rec;
}

function rcsClass(rcs) {
  if (rcs == null || rcs === "" || isNaN(rcs)) return null;
  const m2 = parseFloat(rcs);
  const label = m2 > 1 ? "large (>1 m²)" : m2 > 0.1 ? "medium" : "small (<0.1 m²)";
  return `${m2.toFixed(3)} m² — ${label}`;
}

// ---------------------------------------------------------------------------
// Selection & info panel
// ---------------------------------------------------------------------------
function select(o, flyTo = false) {
  selected = o;
  following = false;
  document.getElementById("follow-btn").classList.remove("active");
  document.getElementById("info-panel").classList.remove("hidden");
  document.getElementById("info-name").textContent = o.name || `NORAD ${o.noradId}`;
  document.getElementById("info-about").textContent = describeObject(o, o.satcat);
  if (o.satcat === undefined) {
    o.satcat = null; // mark as in-flight so we fetch only once
    fetchSatcat(o.noradId)
      .then((rec) => {
        o.satcat = rec;
        if (selected === o) {
          document.getElementById("info-about").textContent = describeObject(o, rec);
          updateInfoPanel();
        }
      })
      .catch((e) => { o.satcat = undefined; console.warn("SATCAT fetch failed:", e); });
  }
  buildOrbitLine(o);
  if (flyTo) {
    const dir = o.pos.clone().normalize();
    const dist = Math.max(o.pos.length() * 1.6, 10);
    camera.position.copy(dir.multiplyScalar(dist)).add(new THREE.Vector3(2, 2, 0));
    controls.target.set(0, 0, 0);
  }
  updateInfoPanel();
}

function deselect() {
  selected = null;
  following = false;
  marker.visible = false;
  document.getElementById("info-panel").classList.add("hidden");
  if (orbitLine) { scene.remove(orbitLine); orbitLine.geometry.dispose(); orbitLine = null; }
}

function updateInfoPanel() {
  if (!selected) return;
  const o = selected;
  const gp = satellite.eciToGeodetic(
    { x: o.pos.x / SCALE, y: -o.pos.z / SCALE, z: o.pos.y / SCALE },
    satellite.gstime(simTime));
  const lat = satellite.degreesLat(gp.latitude).toFixed(2);
  const lon = satellite.degreesLong(gp.longitude).toFixed(2);
  const sc = o.satcat;
  let extra = "";
  if (sc) {
    const owner = OWNERS[sc.OWNER] || sc.OWNER;
    const site = LAUNCH_SITES[sc.LAUNCH_SITE] || sc.LAUNCH_SITE;
    const type = TYPE_NAMES[sc.OBJECT_TYPE] || sc.OBJECT_TYPE;
    const ops = OPS_STATUS[sc.OPS_STATUS_CODE];
    const rcs = rcsClass(sc.RCS);
    extra =
      (sc.OBJECT_ID ? `<tr><td>Int'l designator</td><td>${sc.OBJECT_ID}</td></tr>` : "") +
      (type ? `<tr><td>Object type</td><td>${type}</td></tr>` : "") +
      (ops ? `<tr><td>Op. status</td><td>${ops}</td></tr>` : "") +
      (owner ? `<tr><td>Owner</td><td>${owner}</td></tr>` : "") +
      (sc.LAUNCH_DATE ? `<tr><td>Launched</td><td>${sc.LAUNCH_DATE}</td></tr>` : "") +
      (site ? `<tr><td>Launch site</td><td>${site}</td></tr>` : "") +
      (rcs ? `<tr><td>Radar size</td><td>${rcs}</td></tr>` : "") +
      (sc.APOGEE ? `<tr><td>Apogee / Perigee</td><td>${sc.APOGEE} / ${sc.PERIGEE} km</td></tr>` : "");
  }
  document.getElementById("info-table").innerHTML = extra + `
    <tr><td>NORAD ID</td><td>${o.noradId}</td></tr>
    <tr><td>Catalog</td><td>${GROUPS[o.groupIdx].name}</td></tr>
    <tr><td>Altitude</td><td>${o.altKm.toFixed(1)} km</td></tr>
    <tr><td>Velocity</td><td>${o.velKmS.toFixed(2)} km/s</td></tr>
    <tr><td>Lat / Lon</td><td>${lat}° / ${lon}°</td></tr>
    <tr><td>Inclination</td><td>${o.inclination.toFixed(2)}°</td></tr>
    <tr><td>Period</td><td>${o.periodMin.toFixed(1)} min</td></tr>
    <tr><td>Status</td><td>${o.alive ? (o.altKm < 2000 ? "LEO" : o.altKm < 35000 ? "MEO" : "GEO+") : "decayed"}</td></tr>`;
}

// Picking
renderer.domElement.addEventListener("pointermove", (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
});

function pickObject() {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(meshes.map((m) => m.mesh));
  for (const h of hits) {
    const o = h.object.userData.objs?.[h.instanceId];
    if (o && o.alive && o.visible) return o;
  }
  return null;
}

renderer.domElement.addEventListener("click", (e) => {
  if (e.detail === 0) return;
  const o = pickObject();
  if (o) select(o);
});

// Hover tooltip
const tooltip = document.getElementById("tooltip");
setInterval(() => {
  if (!meshes.length) return;
  const o = pickObject();
  if (o) {
    tooltip.textContent = `${o.name || "NORAD " + o.noradId} · ${o.altKm.toFixed(0)} km`;
    tooltip.classList.remove("hidden");
    tooltip.style.left = `${((pointer.x + 1) / 2) * innerWidth + 14}px`;
    tooltip.style.top = `${((1 - pointer.y) / 2) * innerHeight + 14}px`;
    document.body.style.cursor = "pointer";
  } else {
    tooltip.classList.add("hidden");
    document.body.style.cursor = "default";
  }
}, 120);

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");

searchInput.addEventListener("input", () => {
  const q = searchInput.value.trim().toUpperCase();
  if (q.length < 2) { searchResults.classList.add("hidden"); return; }
  const matches = objects
    .filter((o) => o.alive && (o.name.toUpperCase().includes(q) || o.noradId.includes(q)))
    .slice(0, 25);
  searchResults.innerHTML = "";
  for (const o of matches) {
    const row = document.createElement("div");
    row.innerHTML = `<span>${o.name || "UNKNOWN"}</span><span class="norad">${o.noradId}</span>`;
    row.addEventListener("click", () => {
      select(o, true);
      searchResults.classList.add("hidden");
      searchInput.value = "";
    });
    searchResults.appendChild(row);
  }
  searchResults.classList.toggle("hidden", matches.length === 0);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-box")) searchResults.classList.add("hidden");
});

// ---------------------------------------------------------------------------
// Controls wiring
// ---------------------------------------------------------------------------
document.getElementById("info-close").addEventListener("click", deselect);

document.getElementById("follow-btn").addEventListener("click", (e) => {
  following = !following;
  e.target.classList.toggle("active", following);
});

document.getElementById("btn-play").addEventListener("click", (e) => {
  playing = !playing;
  e.target.textContent = playing ? "⏸" : "▶";
});

document.getElementById("btn-now").addEventListener("click", () => {
  simTime = new Date();
});

document.getElementById("speed-group").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  speed = parseFloat(btn.dataset.speed);
  for (const b of e.currentTarget.children) b.classList.toggle("active", b === btn);
});

document.getElementById("alt-min").addEventListener("change", (e) => {
  altMin = Math.max(0, parseFloat(e.target.value) || 0);
});
document.getElementById("alt-max").addEventListener("change", (e) => {
  altMax = parseFloat(e.target.value) || 50000;
});

document.getElementById("point-size").addEventListener("input", (e) => {
  pointScale = parseFloat(e.target.value) / 3; // slider default 3 -> scale 1
});

document.getElementById("show-orbits").addEventListener("change", () => {
  if (selected) buildOrbitLine(selected);
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const clockEl = document.getElementById("sim-clock");
const fpsEl = document.getElementById("fps");
let last = performance.now();
let frames = 0, fpsTimer = 0, statsTimer = 0;

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - last) / 1000, 0.5);
  last = now;

  if (playing) simTime = new Date(simTime.getTime() + dt * speed * 1000);

  if (meshes.length) propagateAll(simTime, now / 1000);

  // Selected marker faces camera
  if (selected && selected.alive) {
    marker.visible = document.getElementById("show-labels").checked;
    marker.position.copy(selected.pos);
    marker.lookAt(camera.position);
    if (following) controls.target.lerp(selected.pos, 0.15);
    updateInfoPanel();
  }

  clockEl.textContent = simTime.toISOString().replace("T", " ").slice(0, 19) + " UTC";

  // FPS + stats (throttled)
  frames++; fpsTimer += dt; statsTimer += dt;
  if (fpsTimer >= 1) {
    fpsEl.textContent = `${Math.round(frames / fpsTimer)} fps`;
    frames = 0; fpsTimer = 0;
  }
  if (statsTimer >= 1 && meshes.length) { updateStats(); statsTimer = 0; }

  controls.update();
  composer.render();
}

loadAll();
requestAnimationFrame(animate);
