(() => {
  const canvas = document.getElementById('gl-bg');
  if (!canvas || typeof THREE === 'undefined') return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 80);
  camera.position.z = 18;

  const COUNT = reduce ? 80 : 220;
  const pos = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 28;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 18;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 16;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      color: 0x7aa8ff,
      size: 0.085,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    }),
  );
  scene.add(pts);

  const linePos = [];
  for (let i = 0; i < COUNT; i++) {
    const ax = pos[i * 3];
    const ay = pos[i * 3 + 1];
    const az = pos[i * 3 + 2];
    for (let j = i + 1; j < COUNT; j++) {
      const dx = ax - pos[j * 3];
      const dy = ay - pos[j * 3 + 1];
      const dz = az - pos[j * 3 + 2];
      if (dx * dx + dy * dy + dz * dz < 9) {
        linePos.push(ax, ay, az, pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
      }
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(linePos, 3),
  );
  const lines = new THREE.LineSegments(
    lineGeo,
    new THREE.LineBasicMaterial({
      color: 0x4f8cff,
      transparent: true,
      opacity: 0.12,
    }),
  );
  scene.add(lines);

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  const clock = new THREE.Clock();
  function tick() {
    const t = clock.getElapsedTime();
    pts.rotation.y = t * 0.04;
    pts.rotation.x = Math.sin(t * 0.12) * 0.08;
    scene.children[1].rotation.copy(pts.rotation);
    renderer.render(scene, camera);
    if (!reduce) requestAnimationFrame(tick);
  }
  tick();
})();
