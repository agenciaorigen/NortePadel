// ============================================================
// Polish puramente visual/de instalación -- vive separado de app.js a
// propósito para no mezclarse con la lógica de datos/Supabase. Nada de lo
// que hay acá lee ni escribe partidos, torneos ni jugadores.
// ============================================================

(function heroBallTrail() {
  const canvas = document.getElementById("heroTrail");
  const hero = canvas ? canvas.closest(".hero-club") : null;
  if (!canvas || !hero) return;
  const ctx = canvas.getContext("2d");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function size() {
    const r = hero.getBoundingClientRect();
    canvas.width = r.width;
    canvas.height = r.height;
  }
  size();
  window.addEventListener("resize", size);

  if (reduced) {
    // sin animación: un solo punto quieto en vez del trazo -- transmite la
    // misma idea de marca sin mover nada en pantalla
    const draw = () => {
      const w = canvas.width, h = canvas.height;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.arc(w * 0.82, h * 0.22, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#b4ff39";
      ctx.fill();
    };
    draw();
    window.addEventListener("resize", draw);
    return;
  }

  let t = 0;
  const trail = [];
  let raf = null;
  function frame() {
    const w = canvas.width, h = canvas.height;
    if (w && h) {
      ctx.clearRect(0, 0, w, h);
      const x = w * 0.08 + w * 0.55 * (0.5 - 0.5 * Math.cos(t * 0.016));
      const y = h * 0.65 - Math.abs(Math.sin(t * 0.032)) * h * 0.42;
      trail.push({ x, y });
      if (trail.length > 28) trail.shift();
      trail.forEach((p, i) => {
        const a = i / trail.length;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5 * a + 0.5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(180,255,57,${a * 0.4})`;
        ctx.fill();
      });
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#b4ff39";
      ctx.shadowColor = "#b4ff39";
      ctx.shadowBlur = 14;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    t++;
    raf = requestAnimationFrame(frame);
  }
  // pausa cuando la pestaña no está visible -- no gasta batería de más en un celular
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    } else if (!raf) {
      frame();
    }
  });
  frame();
})();

(function heroSpotlight() {
  const hero = document.querySelector(".hero-club");
  if (!hero) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!window.matchMedia("(pointer: fine)").matches) return; // en touch no hay cursor que seguir
  hero.addEventListener("pointermove", (e) => {
    const r = hero.getBoundingClientRect();
    hero.style.setProperty("--mx", ((e.clientX - r.left) / r.width) * 100 + "%");
    hero.style.setProperty("--my", ((e.clientY - r.top) / r.height) * 100 + "%");
  });
})();

(function instalarApp() {
  const sheet = document.getElementById("installSheet");
  const btnInstalar = document.getElementById("btnInstalarApp");
  const btnAhoraNo = document.getElementById("btnInstalarAhoraNo");
  const texto = document.getElementById("installSheetTexto");
  if (!sheet || !btnInstalar || !btnAhoraNo) return;

  const YA_INSTALADA =
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  if (YA_INSTALADA) return;

  const KEY = "np_install_dismiss";
  const COOLDOWN_DIAS = 14;
  function descartadaHacePoco() {
    const v = Number(localStorage.getItem(KEY) || 0);
    return Date.now() - v < COOLDOWN_DIAS * 24 * 60 * 60 * 1000;
  }
  function ocultar() {
    sheet.classList.add("saliendo");
    setTimeout(() => { sheet.hidden = true; sheet.classList.remove("saliendo"); }, 250);
  }
  function descartar() {
    localStorage.setItem(KEY, String(Date.now()));
    ocultar();
  }
  btnAhoraNo.addEventListener("click", descartar);

  const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const esSafari = esIOS && /safari/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (!descartadaHacePoco()) mostrar();
  });

  btnInstalar.addEventListener("click", async () => {
    if (!deferredPrompt) { ocultar(); return; }
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (e) {}
    deferredPrompt = null;
    ocultar();
  });

  function mostrar() {
    if (esIOS && esSafari) {
      texto.textContent = 'Tocá compartir (el cuadrado con la flecha) y elegí "Agregar a pantalla de inicio".';
      btnInstalar.style.display = "none";
    }
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.remove("saliendo"));
  }

  // iOS/Safari nunca dispara beforeinstallprompt -- se muestra igual, con
  // instrucciones manuales, después de un rato para no interrumpir la
  // primera impresión de la app.
  if (esIOS && esSafari && !descartadaHacePoco()) {
    setTimeout(mostrar, 8000);
  }
})();
