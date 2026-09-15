// Turns a driving instructor's spoken notes into a professional lesson breakdown,
// either by asking ChatGPT directly (with the user's own OpenAI API key) or by building
// a prompt to paste into the Claude / ChatGPT app.

export const DEFAULT_MODEL = 'gpt-5.6-luna';
const FALLBACK_MODEL = 'gpt-4o-mini';
const OPENER = "I'm a driving instructor.";

export function systemPrompt(extra = '') {
  const lines = [
    "You turn a driving instructor's rough, spoken notes about a lesson into a clear, professional lesson breakdown that can be shared with the student and their parents.",
    '',
    'Use this format, in plain text (no markdown, no asterisks, no # headings):',
    '',
    'Lesson Breakdown – <lesson date>',
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
    '- Use only what the instructor said or clearly implied. Never invent maneuvers, places, speeds or results.',
    '- Fix speech-to-text mistakes and drop filler words, but keep road and place names.',
    '- Professional, encouraging and specific, in plain language a parent understands.',
    '- Use the student\'s first name if the instructor mentions it; otherwise say "the student".',
    '- Keep it concise, usually 100 to 180 words.',
  ];
  if (extra.trim()) lines.push('', `The instructor's own preferences (follow these): ${extra.trim()}`);
  return lines.join('\n');
}

export function userMessage({ dateLabel, raw }) {
  return `Lesson date: ${dateLabel}\n\nMy notes (dictated, so expect typos and rambling):\n"""\n${raw.trim()}\n"""`;
}

export function copyPrompt({ dateLabel, raw, extra }) {
  return [
    `${OPENER} Please write up a lesson breakdown from my notes below.`,
    '',
    systemPrompt(extra),
    '',
    userMessage({ dateLabel, raw }),
    '',
    'Reply with the breakdown only, no intro or sign-off.',
  ].join('\n');
}

export const looksLikeOurPrompt = (text) => String(text).trim().startsWith(OPENER);

// Strip any markdown the AI adds anyway, and any "Here's your breakdown:" preamble.
export function cleanReply(text) {
  let t = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^(\s*)[-*•]\s+/gm, '$1• ')
    .trim();
  const start = t.search(/^lesson breakdown/im);
  if (start > 0) t = t.slice(start);
  return t.replace(/\n{3,}/g, '\n\n').trim();
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
