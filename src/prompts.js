// Draws prompts from the bank in src/bank/. Edit those files to add your own.
const OBJECTS = require('./bank/objects');
const { SUMMARIES, CONCEPTS, AUDIENCES } = require('./bank/pitch');

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function draw(mode) {
  if (mode === 'link') {
    const a = rand(OBJECTS);
    let b = rand(OBJECTS);
    while (b === a) b = rand(OBJECTS);
    return { text: `${cap(a)} + ${b}`, parts: [cap(a), cap(b)], key: [a, b].sort().join('|') };
  }
  // One Line Pitch: about a third "Summarize…", the rest "Explain X to Y".
  if (Math.random() < 0.35) {
    const t = rand(SUMMARIES);
    return { text: t, key: t };
  }
  const t = `Explain ${rand(CONCEPTS)} to ${rand(AUDIENCES)}`;
  return { text: t, key: t };
}

/**
 * Pick a prompt for a mode, avoiding repeats within a game.
 * Returns { text, parts?, key } — `parts` holds the two objects for The Missing Link.
 */
function pickPrompt(mode, used = new Set()) {
  let prompt = draw(mode);
  for (let i = 0; i < 60 && used.has(prompt.key); i++) prompt = draw(mode);
  used.add(prompt.key);
  return prompt;
}

const bankSize = () => ({
  linkObjects: OBJECTS.length,
  linkPairs: (OBJECTS.length * (OBJECTS.length - 1)) / 2,
  pitchSummaries: SUMMARIES.length,
  pitchExplain: CONCEPTS.length * AUDIENCES.length,
});

module.exports = { pickPrompt, bankSize };
