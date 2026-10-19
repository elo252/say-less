// Optional speech-to-text via OpenAI's transcription API.
// Without OPENAI_API_KEY the game falls back to the phone's built-in speech recognition.
//
// Whisper tends to tidy away "um"s and "uh"s. Seeding the prompt with filler-heavy text is a
// known way to coax it into keeping them — but test it with your own recordings before you
// rely on the scores.
const FILLER_PROMPT =
  "Umm, let me think, like, hmm... Okay, uh, here's what I'm, um, thinking. Erm, you know, so, uh, yeah.";

function extFor(mime = '') {
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}

/** Returns the transcript, or null when no API key is configured. Throws on API errors. */
async function transcribe(audio, mime) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const form = new FormData();
  form.append('file', new Blob([audio], { type: (mime || 'audio/webm').split(';')[0] }), `speech.${extFor(mime)}`);
  form.append('model', process.env.TRANSCRIBE_MODEL || 'whisper-1');
  form.append('prompt', FILLER_PROMPT);
  form.append('language', 'en');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return typeof json.text === 'string' ? json.text.trim() : null;
}

module.exports = { transcribe };
