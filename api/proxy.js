// Vercel Node.js Function — OpenRouter 버전
export const config = { maxDuration: 300 };

// OpenRouter 무료 비전 모델 화이트리스트 (2026년 5월 기준 확인된 모델)
const ALLOWED_MODELS = new Set([
  'openrouter/free',                          // 자동 선택: 가용 무료 비전 모델 중 최적 자동 배정
  'google/gemma-4-27b-it:free',               // Gemma 4 27B — 비전+추론 강함
  'google/gemma-4-31b-it:free',               // Gemma 4 31B — 대안
  'nvidia/nemotron-nano-12b-v2-vl:free',      // NVIDIA VL — OCR/차트 특화
]);
const DEFAULT_MODEL = 'openrouter/free'; // 자동 선택으로 모델 단종 문제 방지

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { apiKey, system, messages, model: reqModel } = body;

    const key = apiKey || process.env.OPENROUTER_API_KEY;
    if (!key) return res.status(400).json({ error: { message: 'OpenRouter API Key 없음' } });
    if (!messages || !Array.isArray(messages))
      return res.status(400).json({ error: { message: 'messages 형식 오류' } });

    const model = (reqModel && ALLOWED_MODELS.has(reqModel)) ? reqModel : DEFAULT_MODEL;

    // Anthropic 형식 → OpenRouter(OpenAI 호환) 형식 변환
    const orMessages = [];

    // system 프롬프트 추가
    if (system) {
      orMessages.push({ role: 'system', content: system });
    }

    // user 메시지 변환 (이미지 포함)
    for (const msg of messages) {
      const content = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: String(msg.content || '') }];

      const orContent = [];
      for (const part of content) {
        if (part.type === 'text') {
          orContent.push({ type: 'text', text: part.text || '' });
        } else if (part.type === 'image') {
          // base64 이미지를 OpenAI 형식으로 변환
          const mediaType = part.source?.media_type || 'image/jpeg';
          const data = part.source?.data || '';
          orContent.push({
            type: 'image_url',
            image_url: { url: `data:${mediaType};base64,${data}` }
          });
        } else if (part.type === 'document') {
          // PDF는 텍스트 추출 불가능하므로 안내 메시지로 대체
          orContent.push({ type: 'text', text: '[PDF 문서가 첨부되었습니다]' });
        }
      }

      orMessages.push({ role: msg.role || 'user', content: orContent });
    }

    const orBody = {
      model,
      messages: orMessages,
      max_tokens: 8000,
      temperature: 0,
      top_p: 1.0,
    };

    const apiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer': 'https://physics-analyzer.vercel.app',
        'X-Title': 'Physics Analyzer',
      },
      body: JSON.stringify(orBody),
    });

    const resText = await apiRes.text();

    if (!apiRes.ok) {
      let errMsg = `OpenRouter API 오류 (${apiRes.status})`;
      let retryAfter = 65;
      try {
        const j = JSON.parse(resText);
        errMsg = j.error?.message || errMsg;
        // 429일 때 retry-after 헤더 확인
        const ra = apiRes.headers.get('retry-after');
        if (ra) retryAfter = parseInt(ra) + 2;
      } catch { errMsg = resText.slice(0, 300) || errMsg; }
      return res.status(apiRes.status).json({ error: { message: errMsg }, retryAfter });
    }

    let text = '';
    try {
      const d = JSON.parse(resText);
      text = d.choices?.[0]?.message?.content || '';
    } catch {}

    return res.status(200).json({ content: [{ type: 'text', text }] });

  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: { message: e.message || '서버 오류' } });
  }
}
