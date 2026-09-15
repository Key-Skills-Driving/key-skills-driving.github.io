// Builds the text you paste into Claude or ChatGPT, and reads the reply back into note sections.

export const SECTIONS = [
  {
    key: 'practiced', label: 'Practiced', heading: 'PRACTICED',
    aliases: ['practiced', 'practised', 'practice', 'what we practiced', 'what we practised', 'covered', 'skills practiced', 'skills covered'],
  },
  {
    key: 'wentWell', label: 'Went well', heading: 'WENT WELL',
    aliases: ['went well', 'what went well', 'strengths', 'positives', 'did well'],
  },
  {
    key: 'workOn', label: 'Work on', heading: 'WORK ON',
    aliases: ['work on', 'to work on', 'needs work', 'needs improvement', 'areas to improve', 'areas for improvement', 'improve'],
  },
  {
    key: 'nextTime', label: 'Next time', heading: 'NEXT TIME',
    aliases: ['next time', 'next lesson', 'plan for next lesson', 'plan for next time', 'next steps'],
  },
];

const OPENER = "I'm a driving instructor.";
const BULLET = /^\s*(?:[-*•–—]|\d+[.)])\s+/;

export function buildPrompt({ studentName, lessonNumber, dateLabel, minutes, previous, raw }) {
  const lines = [
    `${OPENER} Turn my voice notes from today's lesson into clear, short lesson notes.`,
    '',
    `Student: ${studentName}`,
    `Lesson ${lessonNumber}: ${dateLabel}, ${minutes} minutes`,
  ];
  const plan = previous && oneLine(previous.nextTime || previous.workOn);
  if (plan) lines.push(`Plan from their last lesson (${previous.dateLabel}): ${plan}`);
  lines.push(
    '',
    'My notes (dictated, so expect typos and rambling):',
    '"""',
    raw.trim(),
    '"""',
    '',
    'Reply in plain text using exactly these four headings, in this order, each followed by short bullet points that start with "- ":',
    '',
    ...SECTIONS.map((s) => `${s.heading}:`),
    '',
    "Only use what I said or clearly implied - don't invent details. If my notes say how they did on last lesson's plan, include that. Make NEXT TIME a concrete plan for the next lesson. No intro, no sign-off, no bold or other formatting.",
  );
  return lines.join('\n');
}

export const looksLikeOurPrompt = (text) => String(text).trim().startsWith(OPENER);

export function parseReply(text) {
  const result = { practiced: '', wentWell: '', workOn: '', nextTime: '', notes: '', matched: false };
  const buckets = {};
  let current = null;
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const heading = readHeading(line);
    if (heading) {
      current = heading.key;
      result.matched = true;
      buckets[current] ??= [];
      if (heading.rest) buckets[current].push(heading.rest);
    } else if (current) {
      buckets[current].push(line);
    }
    // Anything before the first heading is a preamble ("Here are your notes:") and is dropped.
  }
  if (!result.matched) {
    result.notes = tidy(text);
    return result;
  }
  for (const s of SECTIONS) if (buckets[s.key]) result[s.key] = tidy(buckets[s.key].join('\n'));
  return result;
}

export function shareText({ studentName, dateLabel, lesson }) {
  const parts = [`${studentName} – lesson on ${dateLabel} (${lesson.minutes} min)`];
  for (const s of SECTIONS) if (lesson[s.key]?.trim()) parts.push(`${s.label}:\n${lesson[s.key].trim()}`);
  if (lesson.notes?.trim()) parts.push(`Notes:\n${lesson.notes.trim()}`);
  if (parts.length === 1 && lesson.raw?.trim()) parts.push(lesson.raw.trim());
  return parts.join('\n\n');
}

function readHeading(line) {
  const s = line.trim().replace(/^#{1,6}\s*/, '').replace(/[*_]/g, '').trim();
  if (!s) return null;
  const colon = s.indexOf(':');
  const label = (colon === -1 ? s : s.slice(0, colon)).toLowerCase().replace(/\s+/g, ' ').trim();
  const section = SECTIONS.find((x) => x.aliases.includes(label));
  return section ? { key: section.key, rest: colon === -1 ? '' : s.slice(colon + 1).trim() } : null;
}

function tidy(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trimEnd().replace(BULLET, '• ').replace(/\*\*(.+?)\*\*/g, '$1'))
    .filter((l) => l.trim())
    .join('\n')
    .trim();
}

function oneLine(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(BULLET, '').trim())
    .filter(Boolean)
    .join('; ');
}
