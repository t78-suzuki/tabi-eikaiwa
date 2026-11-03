// Gemini に渡す指示文（会話用・ヒント用・採点用）
import { levelOf } from './data.js';

const SPEED = [
  'Speak very slowly and clearly, with short pauses between phrases. Use only very simple words and 3-6 word sentences.',
  'Speak slowly and clearly. Use simple words and short sentences.',
  'Speak at a slightly slow, natural pace. Use everyday expressions and short sentences.',
  'Speak at a natural pace with everyday expressions. Occasionally rephrase in simpler words if the learner seems lost.',
  'Speak at natural native speed with idioms and contractions, like a real person in this job.',
];

export const CONTROL = {
  start: '[APP] Start the role-play now. Greet the learner in character and open the scene with your first line.',
  slower: '[APP] The learner pressed "Slower, please". From now on speak noticeably slower and simpler. Acknowledge it briefly in character (e.g. "Sure, I\'ll slow down.") and repeat your last line more slowly.',
  repeat: '[APP] The transcript of the learner\'s last utterance was wrong. Ignore it and, in character, ask the learner politely to say it again.',
  wrapUp: '[APP] Time is almost up. Bring the scene to a natural close within one or two short turns.',
};

export function stageOf(scene, noSupport) {
  if (noSupport) return 'free';
  return levelOf(scene.lv).stage;
}

// 会話AI（Live API）のシステム指示
export function liveSystemPrompt({ scene, stage, speed, isTest, dueCards = [] }) {
  const L = levelOf(scene.lv);
  const lines = [
    `You are role-playing a travel English conversation with a Japanese adult learner (target level: CEFR ${L.cefr}).`,
    `Your role: ${scene.role}. Your name is ${scene.aiName}.`,
    `Situation: ${scene.setup}`,
    `The learner's goal: ${scene.goalEn}`,
  ];
  if (scene.hidden) lines.push(`Hidden condition (known only to you; let it emerge naturally, never announce it): ${scene.hidden}`);
  lines.push(
    `Speaking style: ${SPEED[Math.max(0, Math.min(4, speed))]}`,
    'Always stay in character as a real person in this place. Keep each of your turns short (1-2 sentences) and end most turns with something the learner should respond to.',
    'Let the learner do most of the talking. Never give grammar lectures during the conversation.',
    'Messages that start with [APP] come from the app, not from the learner. Follow them silently and never mention them.',
    'When the learner has achieved the goal, close the scene naturally in character (for example "Have a nice day!").',
  );
  if (stage === 'full' && !isTest) {
    lines.push(
      'Support mode (beginner): If the learner makes a mistake, naturally recast the correct sentence in your reply in a kind way (e.g. "Oh, a medium latte? Sure!"), without stopping the scene.',
      'If the learner speaks Japanese or asks how to say something (e.g. "〜って何て言うの？"), briefly teach the English phrase in very simple English (you may repeat the Japanese word once to confirm), ask them to try saying it, then continue the role-play.',
      'If the learner is silent or stuck, offer a simple choice question (e.g. "Hot or iced?").',
    );
  } else if (stage === 'assist' && !isTest) {
    lines.push(
      'Support mode (intermediate): Do not correct mistakes during the conversation. If the learner speaks Japanese, answer only in simple English and encourage them to try in English, offering one key word if needed.',
    );
  } else {
    lines.push(
      'Independent mode: Never use Japanese. Do not simplify much. Include one or two unexpected questions, ask for clarification when the learner is unclear, and react flexibly to what they say, so every conversation unfolds differently.',
    );
  }
  if (isTest) lines.push('This is a level test. Do not give hints or teach phrases. Behave exactly like a real person in this job.');
  if (dueCards.length) {
    lines.push(`Review: during the scene, create natural chances for the learner to use these expressions (do not say them for the learner first): ${dueCards.map((c) => `"${c.better}"`).join(', ')}.`);
  }
  lines.push('Wait for the [APP] start message before speaking.');
  return lines.join('\n');
}

// 返答候補とAI発話の日本語訳（Lv1-3は毎ターン、Lv4-7はヒントボタン時）
export const HELP_SCHEMA = {
  type: 'OBJECT',
  properties: {
    ja: { type: 'STRING', description: 'Natural Japanese translation of the last line of the clerk' },
    replies: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { en: { type: 'STRING' }, ja: { type: 'STRING' } }, required: ['en', 'ja'] },
    },
  },
  required: ['ja', 'replies'],
};

export function helpPrompt({ scene, transcript }) {
  const L = levelOf(scene.lv);
  return `You help a Japanese beginner (CEFR ${L.cefr}) in an English role-play.
Scene: ${scene.setup}
Learner's goal: ${scene.goalEn}
Conversation so far (AI = ${scene.roleJa}, ME = learner):
${formatTranscript(transcript)}

Return JSON:
- "ja": a natural Japanese translation of the AI's last line.
- "replies": exactly 3 short, natural English replies the learner could say next that move toward the goal, from simplest to most natural, each with a Japanese translation. Keep each reply under ${Math.max(4, L.wordsTarget + 4)} words.`;
}

// 採点（仕様書 6.1）：目的達成30・伝わりやすさ20・文法語彙20 をAIが判定
export const SCORE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    goalAchieved: { type: 'BOOLEAN' },
    goal: { type: 'INTEGER', description: '0-30' },
    clarity: { type: 'INTEGER', description: '0-20' },
    grammar: { type: 'INTEGER', description: '0-20' },
    japaneseTurns: { type: 'INTEGER', description: 'number of learner turns spoken mainly in Japanese' },
    summaryJa: { type: 'STRING' },
    nextTaskJa: { type: 'STRING' },
    corrections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { you: { type: 'STRING' }, better: { type: 'STRING' }, noteJa: { type: 'STRING' } },
        required: ['you', 'better', 'noteJa'],
      },
    },
    usedReviewIds: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['goalAchieved', 'goal', 'clarity', 'grammar', 'japaneseTurns', 'summaryJa', 'nextTaskJa', 'corrections', 'usedReviewIds'],
};

const STRICT = {
  gentle: 'Be encouraging and lenient: only count errors that change the meaning.',
  normal: 'Be fair: minor slips lose few points; errors that change meaning or sound rude lose more.',
  strict: 'Be strict: also deduct for unnatural phrasing, missing articles and wrong tense.',
};

export function scorePrompt({ scene, transcript, strict, dueCards = [], detailed }) {
  const L = levelOf(scene.lv);
  return `You are an English speaking examiner for a Japanese adult learner practicing travel English (level target CEFR ${L.cefr}).
Scene: ${scene.title} / ${scene.setup}
Learner's goal: ${scene.goalEn}
${STRICT[strict] || STRICT.normal}
The transcript comes from speech recognition, so ignore spelling and punctuation; judge what was said.

Transcript (AI = ${scene.roleJa}, ME = learner):
${formatTranscript(transcript)}

Score:
- goal (0-30): did the learner achieve the goal? goalAchieved = true only if the essential goal was completed.
- clarity (0-20): could the other person understand without asking again? Deduct for each clarification request caused by the learner.
- grammar (0-20): errors that change meaning, vocabulary fitting the scene. Appropriate for CEFR ${L.cefr}.
- japaneseTurns: count learner turns spoken mainly in Japanese.
- corrections: up to ${detailed ? 8 : 4} of the learner's utterances that would sound more natural another way. "you" = what they said, "better" = a natural phrase at their level, "noteJa" = one short Japanese explanation. Skip trivial ones. If the learner said almost nothing, suggest key phrases they could have used, with "you" as "(言えなかった)".
- summaryJa: 2 sentences in Japanese on what went well and what to improve.${detailed ? ' Also mention pronunciation-related hints that can be inferred from recognition errors.' : ''}
- nextTaskJa: one concrete task for next time, in Japanese.
- usedReviewIds: ids from this list that the learner used correctly: ${dueCards.length ? dueCards.map((c) => `${c.id}="${c.better}"`).join('; ') : '(none)'}.`;
}

export function formatTranscript(t) {
  return t.filter((x) => x.text.trim()).map((x) => `${x.who === 'ai' ? 'AI' : 'ME'}: ${x.text.trim()}`).join('\n') || '(no conversation)';
}
