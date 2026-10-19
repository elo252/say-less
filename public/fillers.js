// Filler-word detection and fluency scoring.
// Shared by the server (scoring) and the phone (live "ums" counter while recording).
(function (root) {
  // Hesitation fillers, plus "you know" and a "like" that sits between commas ("it was, like, huge").
  // Plain "like" is not counted: "I like pizza" is a real word, not a filler.
  const FILLER_RE = new RegExp(
    [
      String.raw`\b(?:u+m+|u+h+m*|e+r+m+|er+|a+h+|h+m+|m{2,}|mhm+)\b`,
      String.raw`\byou know\b`,
      String.raw`(?<=(?:^|[,.!?…])\s*)like(?=\s*,)`,
    ].join('|'),
    'gi'
  );

  // Default bust threshold. Research (Laske & DiGennaro Reed, 2024) found audiences start to
  // mark speakers down somewhere above ~5 fillers per minute, so the buzzer goes off there.
  const DEFAULT_BUST_PER_MIN = 5;
  const MAX_FLUENCY_POINTS = 300;

  /** Split a transcript into text and filler segments, and count the fillers. */
  function analyze(text) {
    const segments = [];
    let count = 0;
    let last = 0;
    const src = String(text || '');
    for (const m of src.matchAll(FILLER_RE)) {
      if (m.index > last) segments.push({ t: 'text', s: src.slice(last, m.index) });
      segments.push({ t: 'filler', s: m[0] });
      count++;
      last = m.index + m[0].length;
    }
    if (last < src.length) segments.push({ t: 'text', s: src.slice(last) });
    return { count, segments };
  }

  /**
   * Turn a filler count into fluency points.
   * - Scaled per minute, so a 45-second speech isn't judged like a 10-second one.
   * - Short speeches earn proportionally less (you can't win by saying nothing).
   * - Bust = at least 3 fillers AND above the per-minute threshold → 0 points + buzzer.
   */
  function score(count, durationSec, bustPerMin = DEFAULT_BUST_PER_MIN) {
    const d = Math.max(Number(durationSec) || 0, 1);
    const perMin = (count / d) * 60;
    const bust = count >= 3 && perMin > bustPerMin;
    const lengthFactor = Math.min(1, d / 30);
    const points = bust ? 0 : Math.max(0, Math.round(lengthFactor * (MAX_FLUENCY_POINTS - 30 * perMin)));
    return { perMin: Math.round(perMin * 10) / 10, bust, points };
  }

  const api = { analyze, score, DEFAULT_BUST_PER_MIN, MAX_FLUENCY_POINTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Fillers = api;
})(typeof window !== 'undefined' ? window : globalThis);
