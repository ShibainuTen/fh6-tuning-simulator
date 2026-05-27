module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { car, specs, feedback, resumeData } = body;
  if (!car) return res.status(400).json({ error: 'car data required' });

  const specLines = [
    specs?.power      ? `出力: ${specs.power} kW`           : '出力: 不明（AI推定）',
    specs?.torque     ? `トルク: ${specs.torque} Nm`         : 'トルク: 不明（AI推定）',
    specs?.weight     ? `車重: ${specs.weight} kg`           : '車重: 不明（AI推定）',
    specs?.frontBias  ? `フロント配分: ${specs.frontBias}%`  : 'フロント配分: 不明（AI推定）',
    specs?.tires      ? `タイヤ: ${specs.tires}`             : 'タイヤ: 不明（AI推定）',
    specs?.drivetrain ? `駆動系: ${specs.drivetrain}`        : '駆動系: 不明（AI推定）',
    specs?.purpose    ? `用途: ${specs.purpose}`             : '用途: 不明（AI推定）',
    specs?.gearCount  ? `ギア数: ${specs.gearCount}速`       : 'ギア数: 不明（AI推定）',
  ].join('\n');

  const feedbackSection = feedback
    ? `\n【前回セッティングへのフィードバック】\nハンドリング: ${feedback.handling || '-'}\nブレーキ: ${feedback.braking || '-'}\n速度特性: ${feedback.speed || '-'}`
    : '';

  const resumeSection = resumeData
    ? `\n【前回セッティング（ベースとして使用）】\n${JSON.stringify(resumeData, null, 2)}`
    : '';

  const carClass = car.cls || car.class || '不明';

  const prompt = `あなたはForza Horizon 6の熟練チューナーです。以下の車両・スペックに基づき、最適なチューニングセッティングを提案してください。

【車両情報】
メーカー: ${car.make}
モデル: ${car.model}
年式: ${car.year}
クラス: ${carClass}

【スペック】
${specLines}
${feedbackSection}
${resumeSection}

以下のJSON形式のみで回答してください。余分なテキスト・コードブロック記号は不要です：

{
  "arb": {
    "front": { "value": <数値mm>, "note": "<説明>" },
    "rear":  { "value": <数値mm>, "note": "<説明>" }
  },
  "springs": {
    "front": { "value": <kgf/mm>, "percent": <0-100>, "note": "<説明>" },
    "rear":  { "value": <kgf/mm>, "percent": <0-100>, "note": "<説明>" }
  },
  "damping": {
    "frontBump":    { "value": <1-20>, "percent": <0-100>, "note": "<説明>" },
    "rearBump":     { "value": <1-20>, "percent": <0-100>, "note": "<説明>" },
    "frontRebound": { "value": <1-20>, "percent": <0-100>, "note": "<説明>" },
    "rearRebound":  { "value": <1-20>, "percent": <0-100>, "note": "<説明>" }
  },
  "alignment": {
    "frontCamber": { "value": <度>, "note": "<説明>" },
    "rearCamber":  { "value": <度>, "note": "<説明>" },
    "frontToe":    { "value": <度>, "note": "<説明>" },
    "rearToe":     { "value": <度>, "note": "<説明>" },
    "caster":      { "value": <度>, "note": "<説明>" }
  },
  "aero": {
    "frontDownforce": { "value": <kg>, "percent": <0-100>, "note": "<説明>" },
    "rearDownforce":  { "value": <kg>, "percent": <0-100>, "note": "<説明>" }
  },
  "brakes": {
    "balance":  { "value": <前%>, "note": "<説明>" },
    "pressure": { "value": <1-200>, "percent": <0-100>, "note": "<説明>" }
  },
  "diff": {
    "frontAccel":    { "value": <0-100>, "note": "<説明>" },
    "frontDecel":    { "value": <0-100>, "note": "<説明>" },
    "rearAccel":     { "value": <0-100>, "note": "<説明>" },
    "rearDecel":     { "value": <0-100>, "note": "<説明>" },
    "centerBalance": { "value": <0-100>, "note": "<説明>" }
  },
  "gears": {
    "finalDrive": { "value": <比>, "note": "<説明>" },
    "ratios": [<指定ギア数分の数値配列。ギア数未指定なら車両クラスに適した段数で>]
  },
  "summary": "<全体的なセッティング方針（日本語200字程度）>"
}`;

  // ── Claude 試行 ──────────────────────────────────────────
  if (claudeKey) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': claudeKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          max_tokens: 2048,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      // 429 / 529 以外のエラーはそのまま Gemini へ
      const shouldFallback = r.status === 429 || r.status === 529;

      if (r.ok) {
        const data = await r.json();
        const text = (data.content && data.content[0] && data.content[0].text) || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const tuning = JSON.parse(jsonMatch[0]);
          return res.status(200).json({ tuning, model: 'claude' });
        }
        // JSON 抽出失敗 → Gemini へ
      } else if (!shouldFallback) {
        const errText = await r.text();
        return res.status(r.status).json({ error: errText });
      }
      // shouldFallback または JSON 抽出失敗 → 下の Gemini 処理へ続く
    } catch (err) {
      // ネットワークエラーなど → Gemini へ
    }
  }

  // ── Gemini フォールバック ────────────────────────────────
  if (!geminiKey) {
    return res.status(503).json({ error: 'Claude rate limit exceeded and GEMINI_API_KEY is not set' });
  }

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
        }),
      }
    );

    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).json({ error: 'Gemini error: ' + errText });
    }

    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'Gemini response did not contain valid JSON', raw: text });
    }

    const tuning = JSON.parse(jsonMatch[0]);
    return res.status(200).json({ tuning, model: 'gemini' });

  } catch (err) {
    return res.status(500).json({ error: 'Gemini error: ' + err.message });
  }
};
