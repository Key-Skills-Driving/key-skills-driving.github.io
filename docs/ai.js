// Turns a driving instructor's spoken notes into a professional lesson breakdown,
// either by asking an AI directly (Google Gemini on its free tier, or ChatGPT with the
// user's own OpenAI key) or by building a prompt to paste into the Claude / ChatGPT app.

export const DEFAULT_MODEL = 'gpt-5.6-luna';
const FALLBACK_MODEL = 'gpt-4o-mini';
const OPENER = "I'm a driving instructor.";

export function systemPrompt(extra = '') {
  const lines = [
    "You turn a driving instructor's rough, spoken notes about a lesson into a clear, professional lesson breakdown that can be shared with the student and their parents.",
    '',
    'Use this format, in plain text (no markdown, no asterisks, no # headings):',
    '',
    '<One sentence summing up the lesson.>',
    '',
    'Covered today:',
    '- <skill or activity>',
    '',
    'How it went:',
    '- <Skill>: <specifically what the student did well or struggled with>',
    '',
    'Focus for next lesson:',
    '- <what to practice next>',
    '',
    'Rules:',
    '- Start straight with the summary sentence. No title, heading or date line.',
    '- Use only what the instructor said or clearly implied. Never invent maneuvers, places, speeds or results.',
    '- Fix speech-to-text mistakes and drop filler words, but keep road and place names.',
    '- Professional, encouraging and specific, in plain language a parent understands.',
    '- Never use anyone\'s name. Wherever the notes name the student, write "the student" instead ("The student" at the start of a sentence). Refer to anyone else by their role, like "the parent".',
    '- If the notes say the student has finished (for example, they passed or completed their driving test, or it was their last lesson), leave out the whole "Focus for next lesson" section, because there is no next lesson. If they didn\'t pass and will keep having lessons, include it.',
    '- Keep it concise, usually 100 to 180 words.',
  ];
  if (extra.trim()) lines.push('', `The instructor's own preferences (follow these): ${extra.trim()}`);
  return lines.join('\n');
}

export function userMessage({ raw }) {
  return `My notes (dictated, so expect typos and rambling):\n"""\n${raw.trim()}\n"""`;
}

// Asks for small changes to an existing breakdown, with the original notes for context.
export function modifyMessage({ raw, current, change }) {
  return [
    raw?.trim() ? `My original notes (dictated):\n"""\n${raw.trim()}\n"""` : '',
    `The current lesson breakdown:\n"""\n${current.trim()}\n"""`,
    `Change it like this: ${change.trim()}`,
    'Only make the changes I asked for and keep everything else the same. Reply with the full updated breakdown only, in the same format.',
  ].filter(Boolean).join('\n\n');
}

export function copyPrompt({ raw, extra }) {
  return [
    `${OPENER} Please write up a lesson breakdown from my notes below.`,
    '',
    systemPrompt(extra),
    '',
    userMessage({ raw }),
    '',
    'Reply with the breakdown only, no intro or sign-off.',
  ].join('\n');
}

export const looksLikeOurPrompt = (text) => String(text).trim().startsWith(OPENER);

const TITLE = /^lesson (?:breakdown|notes|summary|recap)\b/i;
const DATE_ONLY = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i;

// Strip any markdown the AI adds anyway, plus anything it puts before the notes themselves:
// a "Here's your breakdown:" preamble, a "Lesson Breakdown – date" title, or a bare date.
export function cleanReply(text) {
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^(\s*)[-*•]\s+/gm, '$1• ')
    .split('\n');
  while (lines.length) {
    const line = lines[0].trim();
    const titled = line.match(/^lesson (?:breakdown|notes|summary|recap)\b[^:]*:\s*(.*)$/i);
    if (titled && titled[1] && !DATE_ONLY.test(titled[1])) {
      lines[0] = titled[1]; // "Lesson summary: Maya did well…" keeps the sentence
      break;
    }
    if (!line || titled || TITLE.test(line) || DATE_ONLY.test(line) || /^here(?:'s| is| are)\b.*:$/i.test(line)) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

class FriendlyError extends Error {}

async function callChat({ apiKey, model, system, user, lowEffort, signal }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (lowEffort) body.reasoning_effort = 'low';
  return fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
}

function explain(status, err) {
  const code = err?.error?.code || '';
  if (status === 401) return 'OpenAI didn\'t accept your API key. Check it in Settings.';
  if (code === 'insufficient_quota') return 'Your OpenAI account is out of credit. Add some at platform.openai.com under Billing.';
  if (status === 429) return 'ChatGPT is busy right now. Wait a few seconds and try again.';
  if (status === 404 || code === 'model_not_found') return 'That ChatGPT model isn\'t available on your account. Check the model in Settings.';
  if (status >= 500) return 'ChatGPT is having problems right now. Try again, or use Copy for ChatGPT.';
  return err?.error?.message || `ChatGPT returned an error (${status}).`;
}

export async function writeWithChatGPT({ apiKey, model = DEFAULT_MODEL, system, user }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    let usedModel = model || DEFAULT_MODEL;
    let lowEffort = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await callChat({ apiKey, model: usedModel, system, user, lowEffort, signal: controller.signal });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) throw new FriendlyError('ChatGPT sent back an empty answer. Try again.');
        return text;
      }
      const message = `${data?.error?.param || ''} ${data?.error?.message || ''}`;
      // Older models don't take reasoning_effort; retry without it.
      if (res.status === 400 && lowEffort && /reasoning/i.test(message)) {
        lowEffort = false;
        continue;
      }
      // If the default model isn't on this account, fall back to an older small one.
      if ((res.status === 404 || data?.error?.code === 'model_not_found') && usedModel === DEFAULT_MODEL) {
        usedModel = FALLBACK_MODEL;
        continue;
      }
      throw new FriendlyError(explain(res.status, data));
    }
    throw new FriendlyError('ChatGPT couldn\'t write the breakdown. Try again.');
  } catch (err) {
    if (err instanceof FriendlyError) throw err;
    if (err?.name === 'AbortError') throw new Error('ChatGPT took too long. Try again.');
    if (!navigator.onLine) throw new Error('No signal. Try again when you have one, or use Copy for ChatGPT.');
    // OpenAI hides its error replies (bad key, no credit) from web pages, so they surface here
    // as a failed request. The model lookup does come back readable, so use it to find out why.
    const check = await checkKey(apiKey, model || DEFAULT_MODEL);
    if (!check.ok) throw new Error(check.message);
    throw new Error("ChatGPT didn't answer. If it keeps happening, check that your OpenAI account has credit (platform.openai.com, under Billing).");
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Google Gemini, free tier ----------

// Best free model first. Each model has its own free daily allowance, so when one is used
// up (429), busy (5xx) or retired (404), the next one usually still works.
export const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_BLOCKED = "Gemini wouldn't write this one. Try rewording it, or use Copy for ChatGPT.";

function geminiProblem(status, data) {
  const e = data?.error || {};
  const detail = `${e.status || ''} ${e.message || ''} ${JSON.stringify(e.details || '')}`;
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(detail)) return "Google didn't accept your Gemini key. Check it in Settings.";
  if (/location is not supported|not available in your country/i.test(detail)) return "Gemini's free tier isn't available where you are.";
  if (status === 403) return "That key isn't allowed to use Gemini. Create a new one at aistudio.google.com/apikey.";
  if (status === 429) return "You've reached Google's free limit for now. Wait a minute and try again, or use Copy for ChatGPT.";
  if (status >= 500) return 'Gemini is busy right now. Try again in a moment.';
  return e.message || `Gemini returned an error (${status}).`;
}

export async function writeWithGemini({ apiKey, system, user }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  let problem = null;
  try {
    for (const model of GEMINI_MODELS) {
      let lowThinking = true;
      for (let attempt = 0; attempt < 2; attempt++) {
        const body = {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
        };
        // Rewriting notes doesn't need deep thought; low keeps answers quick.
        if (lowThinking) body.generationConfig = { thinkingConfig: { thinkingLevel: 'low' } };
        const res = await fetch(`${GEMINI_API}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          if (data?.promptFeedback?.blockReason) throw new FriendlyError(GEMINI_BLOCKED);
          const candidate = data?.candidates?.[0];
          const text = (candidate?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
          if (text) return text;
          if (candidate?.finishReason === 'SAFETY') throw new FriendlyError(GEMINI_BLOCKED);
          problem = 'Gemini sent back an empty answer. Try again.';
          break;
        }
        // A model that doesn't take the thinking setting: ask again without it.
        if (res.status === 400 && lowThinking && /thinking/i.test(data?.error?.message || '')) {
          lowThinking = false;
          continue;
        }
        problem = geminiProblem(res.status, data);
        // A bad key or blocked account won't be fixed by trying another model.
        if (res.status === 400 || res.status === 401 || res.status === 403) throw new FriendlyError(problem);
        break;
      }
    }
    throw new FriendlyError(problem || "Gemini couldn't write the breakdown. Try again.");
  } catch (err) {
    if (err instanceof FriendlyError) throw err;
    if (err?.name === 'AbortError') throw new Error('Gemini took too long. Try again.');
    throw new Error('No connection to Gemini. Try again when you have signal, or use Copy for ChatGPT.');
  } finally {
    clearTimeout(timer);
  }
}

// Free check that the key works (looking up a model doesn't use any of the free allowance).
export async function checkGeminiKey(apiKey) {
  for (const model of GEMINI_MODELS) {
    let res;
    try {
      res = await fetch(`${GEMINI_API}/${model}`, { headers: { 'x-goog-api-key': apiKey } });
    } catch {
      return { ok: false, message: 'No connection. Check your signal and try again.' };
    }
    if (res.ok) return { ok: true };
    if (res.status !== 404) return { ok: false, message: geminiProblem(res.status, await res.json().catch(() => null)) };
  }
  return { ok: false, message: "Google didn't recognise any of the free Gemini models. Try again later." };
}

// ---------- key check for ChatGPT ----------

// Free check that the key works and can use the model (listing a model costs nothing).
export async function checkKey(apiKey, model = DEFAULT_MODEL) {
  let res;
  try {
    res = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return { ok: false, message: 'No connection. Check your signal and try again.' };
  }
  if (res.ok) return { ok: true };
  const data = await res.json().catch(() => null);
  if (res.status === 404 && model === DEFAULT_MODEL) return { ok: true, note: `Using ${FALLBACK_MODEL}, since ${DEFAULT_MODEL} isn't on your account yet.` };
  return { ok: false, message: explain(res.status, data) };
}
