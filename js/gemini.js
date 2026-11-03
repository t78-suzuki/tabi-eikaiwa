// Gemini REST API（モデル一覧・テキスト生成）。APIキーは URL ではなくヘッダーで送る
const API = 'https://generativelanguage.googleapis.com/v1beta';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.isQuota = status === 429;
  }
}

async function toError(r) {
  let msg = `通信エラー (${r.status})`;
  try {
    const j = await r.json();
    if (j.error?.message) msg = j.error.message;
  } catch { /* 本文なし */ }
  if (r.status === 400 && /API key/i.test(msg)) msg = 'APIキーが正しくありません。';
  if (r.status === 429) msg = 'Gemini の利用上限に達しました。しばらく待つか、有料枠をご検討ください。';
  return new ApiError(msg, r.status);
}

export async function listModels(key) {
  const out = [];
  let token = '';
  do {
    const r = await fetch(`${API}/models?pageSize=1000${token ? `&pageToken=${token}` : ''}`, { headers: { 'x-goog-api-key': key } });
    if (!r.ok) throw await toError(r);
    const j = await r.json();
    out.push(...(j.models || []));
    token = j.nextPageToken || '';
  } while (token);
  return out;
}

const ver = (name) => Number(name.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] || 0);
const byNewest = (a, b) => ver(b) - ver(a) || (a.includes('preview') - b.includes('preview')) || a.length - b.length;

// 会話用：bidiGenerateContent に対応した音声モデル
export function liveModels(models) {
  return models
    .filter((m) => (m.supportedGenerationMethods || []).includes('bidiGenerateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /live|native-audio/.test(n) && !/transcribe|translate|tts|thinking/.test(n))
    .sort(byNewest);
}

// 採点用：軽量テキストモデル（Flash-Lite 系）
export function textModels(models) {
  const names = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini/.test(n) && !/tts|image|live|audio|embed|vision|thinking|exp/.test(n));
  const lite = names.filter((n) => n.includes('flash-lite')).sort(byNewest);
  const flash = names.filter((n) => n.includes('flash') && !n.includes('lite')).sort(byNewest);
  return { lite, flash };
}

export async function generateJSON(key, model, prompt, schema) {
  const r = await fetch(`${API}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.4 },
    }),
  });
  if (!r.ok) throw await toError(r);
  const j = await r.json();
  const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('AIの応答を読み取れませんでした。もう一度お試しください。', 0);
  }
}
