// eslint-disable-next-line import/no-unresolved, import/extensions
import confetti from 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.module.mjs';

const COLORS = ['#3b63fb', '#8a5cf6', '#eb1000', '#ffb400', '#2fbf71', '#ffffff'];

function burst() {
  const defaults = { colors: COLORS, zIndex: 10, ticks: 250 };
  confetti({
    ...defaults, particleCount: 120, spread: 90, origin: { y: 0.6 },
  });
  confetti({
    ...defaults, particleCount: 60, angle: 60, spread: 60, origin: { x: 0, y: 0.75 },
  });
  confetti({
    ...defaults, particleCount: 60, angle: 120, spread: 60, origin: { x: 1, y: 0.75 },
  });
}

function rain(durationMs = 2500) {
  const end = Date.now() + durationMs;
  (function frame() {
    confetti({
      colors: COLORS, particleCount: 4, angle: 60, spread: 55, origin: { x: 0, y: 0.6 },
    });
    confetti({
      colors: COLORS, particleCount: 4, angle: 120, spread: 55, origin: { x: 1, y: 0.6 },
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  }());
}

document.querySelector('.ty-btn').addEventListener('click', () => {
  burst();
  setTimeout(() => rain(), 400);
});
