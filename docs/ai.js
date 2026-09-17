// Turns a driving instructor's spoken notes into a professional lesson breakdown,
// either by asking an AI directly (Google Gemini on its free tier, or ChatGPT with the
// user's own OpenAI key) or by building a prompt to paste into the Claude / ChatGPT app.

export const DEFAULT_MODEL = 'gpt-5.6-luna';
const FALLBACK_MODEL = 'gpt-4o-mini';
const OPENER = "I'm a driving instructor.";

// ---------- the instructor's own style ----------

export const STYLE_LIMITS = { examples: 3, exampleChars: 1500, signoff: 80 };

// Keeps only what the prompt understands (tone and length are fixed: warm and detailed).
// The school server runs it on whatever a phone sends.
export function normalizeStyle(value) {
  const o = value && typeof value === 'object' ? value : {};
  const pick = (v, allowed) => (allowed.includes(v) ? v : '');
  const examples = (Array.isArray(o.examples) ? o.examples : [])
    .map((e) => (typeof e === 'string' ? { text: e } : e))
    .filter((e) => e && typeof e.text === 'string' && e.text.trim())
    .slice(-STYLE_LIMITS.examples)
    .map((e) => ({
      text: e.text.trim().slice(0, STYLE_LIMITS.exampleChars),
      itemId: typeof e.itemId === 'string' ? e.itemId : '',
      addedAt: Number(e.addedAt) || 0,
    }));
  return {
    polish: pick(o.polish, ['close', 'tidy']) || 'tidy',
    signoff: typeof o.signoff === 'string' ? o.signoff.trim().slice(0, STYLE_LIMITS.signoff) : '',
    examples,
  };
}

export const styleIsSet = (style) => {
  const s = normalizeStyle(style);
  return !!(s.signoff || s.examples.length);
};

// The examples set the voice; the rules above them still set the floor.
function styleLines(style) {
  const s = normalizeStyle(style);
  const lines = [];
  if (s.signoff) lines.push(`- End with this sign-off on its own line, exactly as written: ${s.signoff}`);
  if (s.examples.length) {
    lines.push(s.polish === 'close'
      ? "- Match the instructor's voice in the examples below as closely as you can: their phrasing, sentence length and habits. Change as little as possible beyond fixing dictation errors and keeping the format."
      : "- Write in the instructor's voice from the examples below (their phrasing, sentence length and habits), but keep it professional: tighten rambling, add the specifics the notes give, and keep the format.");
    s.examples.forEach((e, i) => lines.push('', `Example ${i + 1} of the instructor's own writing (match the voice, never the content):`, '"""', e.text, '"""'));
  }
  return lines.length ? ['', "This instructor's style:", ...lines] : [];
}

export function systemPrompt(extra = '', style = null) {
  const lines = [
    "You turn a driving instructor's rough, spoken notes about a lesson into a clear, professional lesson breakdown that can be shared with the student and their parents.",
    '',
    'Use this format, in plain text (no markdown, no asterisks, no # headings):',
    '',
    'Covered today:',
    '- <skill or activity>',
    '',
    "<A personal message from the instructor about how the lesson went: one to three short paragraphs, written as if to the student and their parents, in the instructor's own voice. Say specifically what went well and what needs work. No heading for this part.>",
    '',
    'Focus for next lesson:',
    '- <what to practice next>',
    '',
    'Rules:',
    '- Start straight with "Covered today:". No title or date line. Keep that list bare: skill names only, no detail.',
    '- The message is the heart of the breakdown. Talk the lesson through the way the instructor would in person, with the specifics from the notes. Never restate the "Covered today" list inside it.',
    '- Use only what the instructor said or clearly implied. Never invent maneuvers, places, speeds or results.',
    '- Fix speech-to-text mistakes and drop filler words, but keep road and place names.',
    "- Warm and encouraging, like a coach who is on the student's side, and specific, in plain language a parent understands.",
    '- Never use anyone\'s name. Wherever the notes name the student, write "the student" instead ("The student" at the start of a sentence). Refer to anyone else by their role, like "the parent".',
    '- If the notes say the student has finished (for example, they passed or completed their driving test, or it was their last lesson), leave out the whole "Focus for next lesson" section, because there is no next lesson. If they didn\'t pass and will keep having lessons, include it.',
    '- Detailed: a message that walks through each skill with its specifics, about 150 to 220 words in all.',
    ...styleLines(style),
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

export function copyPrompt({ raw, extra, style }) {
  return [
    `${OPENER} Please write up a lesson breakdown from my notes below.`,
    '',
    systemPrompt(extra, style),
    '',
    userMessage({ raw }),
    '',
    'Reply with the breakdown only, nothing before or after it.',
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

// `signal` lets the app cancel a request (New lesson, Cancel) on top of the 90-second timeout.
function abortable(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', () => controller.abort(), { once: true });
  return { controller, timer };
}

export const CANCELLED = 'Cancelled';

export async function writeWithChatGPT({ apiKey, model = DEFAULT_MODEL, system, user, signal }) {
  const { controller, timer } = abortable(signal);
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
    if (signal?.aborted) throw new Error(CANCELLED);
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

export async function writeWithGemini({ apiKey, system, user, signal }) {
  const { controller, timer } = abortable(signal);
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
    if (signal?.aborted) throw new Error(CANCELLED);
    if (err?.name === 'AbortError') throw new Error('Gemini took too long. Try again.');
    throw new Error('No connection to Gemini. Try again when you have signal, or use Copy for ChatGPT.');
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Claude (Anthropic), with the instructor's own key ----------

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';
const ANTHROPIC_API = 'https://api.anthropic.com/v1';
// The direct-browser-access header is what Anthropic asks for when the key belongs to the person
// using the browser, which is the case here: their own key, on their own phone.
const anthropicHeaders = (apiKey) => ({
  'Content-Type': 'application/json',
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
});

function claudeProblem(status, data) {
  const type = data?.error?.type || '';
  const message = data?.error?.message || '';
  if (status === 401 || type === 'authentication_error') return "Anthropic didn't accept your Claude key. Check it in Settings.";
  if (/credit balance|billing|purchase/i.test(message)) return 'Your Anthropic account is out of credit. Add some at console.anthropic.com under Billing.';
  if (status === 429) return 'Claude is busy right now. Wait a few seconds and try again.';
  if (status === 404 || type === 'not_found_error') return "That Claude model isn't available on your account. Check the model in Settings.";
  if (status >= 500 || type === 'overloaded_error') return 'Claude is having problems right now. Try again, or use Copy for Claude.';
  return message || `Claude returned an error (${status}).`;
}

export async function writeWithClaude({ apiKey, model = DEFAULT_CLAUDE_MODEL, system, user, signal }) {
  const { controller, timer } = abortable(signal);
  try {
    // Newer models take adaptive thinking and server-side fallbacks; if the chosen model rejects
    // either, ask again without it rather than fail.
    const use = { fallbacks: true, thinking: true };
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = {
        model: model || DEFAULT_CLAUDE_MODEL,
        max_tokens: 8192,
        system,
        messages: [{ role: 'user', content: user }],
      };
      if (use.thinking) {
        body.thinking = { type: 'adaptive' };
        body.output_config = { effort: 'low' }; // a rewrite doesn't need deep thought; keeps it quick and cheap
      }
      const headers = anthropicHeaders(apiKey);
      if (use.fallbacks) {
        // If Claude declines the request, Anthropic answers with a fallback model instead of failing.
        headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
        body.fallbacks = 'default';
      }
      const res = await fetch(`${ANTHROPIC_API}/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        if (data?.stop_reason === 'refusal') throw new FriendlyError("Claude wouldn't write this one. Try rewording it, or use Copy for Claude.");
        const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        if (!text) throw new FriendlyError('Claude sent back an empty answer. Try again.');
        return text;
      }
      const message = data?.error?.message || '';
      if (res.status === 400 && use.fallbacks && /fallback|beta/i.test(message)) {
        use.fallbacks = false;
        continue;
      }
      if (res.status === 400 && use.thinking && /thinking|effort|output_config/i.test(message)) {
        use.thinking = false;
        continue;
      }
      throw new FriendlyError(claudeProblem(res.status, data));
    }
    throw new FriendlyError("Claude couldn't write the breakdown. Try again.");
  } catch (err) {
    if (err instanceof FriendlyError) throw err;
    if (signal?.aborted) throw new Error(CANCELLED);
    if (err?.name === 'AbortError') throw new Error('Claude took too long. Try again.');
    throw new Error('No connection to Claude. Try again when you have signal, or use Copy for Claude.');
  } finally {
    clearTimeout(timer);
  }
}

// Free check that the key works and can use the model (looking a model up costs nothing).
export async function checkClaudeKey(apiKey, model = DEFAULT_CLAUDE_MODEL) {
  let res;
  try {
    res = await fetch(`${ANTHROPIC_API}/models/${encodeURIComponent(model || DEFAULT_CLAUDE_MODEL)}`, { headers: anthropicHeaders(apiKey) });
  } catch {
    return { ok: false, message: 'No connection. Check your signal and try again.' };
  }
  if (res.ok) return { ok: true };
  return { ok: false, message: claudeProblem(res.status, await res.json().catch(() => null)) };
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
