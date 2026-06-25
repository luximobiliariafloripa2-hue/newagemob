/**
 * AGEMOB SoundManager — Efeitos sonoros premium via Web Audio API
 * Sem arquivos externos. Sons gerados programaticamente.
 * Volume e ativação controláveis em um único local.
 */
const SoundManager = (() => {
  // ── Configuração central ──
  const CFG = {
    enabled: true,       // true = sons ativos
    masterVolume: 1.0,   // multiplicador global (0.0 a 1.0)
    volumes: {
      click:        0.12,
      success:      0.20,
      notification: 0.18,
      error:        0.15,
    }
  };

  let ctx = null;
  let unlocked = false;

  // Inicializa AudioContext na primeira interação do usuário
  function unlock() {
    if (unlocked) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      unlocked = true;
    } catch(e) {}
  }

  document.addEventListener('click', unlock, { once: true });
  document.addEventListener('touchstart', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });

  // ── Engine de síntese ──
  function tone(params) {
    if (!CFG.enabled || !unlocked || !ctx) return;
    try {
      const { freqs, duration, type = 'sine', vol = 0.2, attack = 0.005, decay = 0.05, shape } = params;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      const v = vol * CFG.masterVolume;

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(v, now + attack);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      (Array.isArray(freqs) ? freqs : [freqs]).forEach((f, i) => {
        const osc = ctx.createOscillator();
        osc.type = type;
        if (shape) osc.setPeriodicWave(shape);
        if (typeof f === 'object') {
          osc.frequency.setValueAtTime(f.from, now);
          osc.frequency.exponentialRampToValueAtTime(f.to, now + duration * (f.t || 1));
        } else {
          osc.frequency.setValueAtTime(f, now + (i * 0.03));
        }
        osc.connect(gain);
        osc.start(now + (i * 0.03));
        osc.stop(now + duration + 0.05);
      });
    } catch(e) {}
  }

  // ── Sons ──

  // Clique — pulso muito curto e sutil
  function click() {
    tone({
      freqs: 880,
      type: 'sine',
      vol: CFG.volumes.click * CFG.masterVolume,
      duration: 0.08,
      attack: 0.002,
    });
  }

  // Sucesso — dois tons ascendentes, limpos
  function success() {
    tone({
      freqs: [{ from: 523, to: 523, t: 0 }, { from: 659, to: 659, t: 0 }, { from: 784, to: 784, t: 0 }],
      type: 'sine',
      vol: CFG.volumes.success * CFG.masterVolume,
      duration: 0.35,
      attack: 0.005,
    });
  }

  // Erro — tom descendente breve
  function error() {
    tone({
      freqs: [{ from: 380, to: 280 }],
      type: 'sine',
      vol: CFG.volumes.error * CFG.masterVolume,
      duration: 0.18,
      attack: 0.003,
    });
  }

  // Notificação — dois pings suaves
  function notification() {
    [0, 0.12].forEach(delay => {
      setTimeout(() => {
        tone({
          freqs: 1046,
          type: 'sine',
          vol: CFG.volumes.notification * CFG.masterVolume,
          duration: 0.22,
          attack: 0.004,
        });
      }, delay * 1000);
    });
  }

  // ── API pública ──
  return {
    click,
    success,
    error,
    notification,
    enable()  { CFG.enabled = true; },
    disable() { CFG.enabled = false; },
    setVolume(v) { CFG.masterVolume = Math.max(0, Math.min(1, v)); },
    toggle()  { CFG.enabled = !CFG.enabled; return CFG.enabled; },
    isEnabled() { return CFG.enabled; }
  };
})();
