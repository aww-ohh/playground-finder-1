// api/signals.js — Vercel serverless function
// Accepts a list of parks (each with placeId, name, and review texts) and
// returns Gemini-extracted signals keyed by placeId. Called by the front end
// AFTER /api/places returns, so cards can render immediately and signals
// stream in shortly after.
module.exports = async function handler(req, res) {
  // ---- 1. Only POST ----
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ---- 2. Parse body (Vercel auto-parses JSON, but be defensive) ----
  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || !Array.isArray(body.parks)) {
    return res.status(400).json({ error: 'Missing or invalid parks array' });
  }
  var parks = body.parks;
  if (parks.length === 0) {
    return res.status(200).json({ signals: {} });
  }

  // ---- 3. Check Gemini key ----
  var geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    // No key — return empty signals so the frontend falls back to defaults.
    return res.status(200).json({ signals: {} });
  }

  // ---- 4. Build the batch prompt ----
  var parkSections = [];
  var parkIds = []; // tracks which placeIds we actually included
  parks.forEach(function (p) {
    if (!p || !p.placeId || !Array.isArray(p.reviews) || p.reviews.length === 0) return;
    var reviewText = p.reviews.filter(function (r) { return r && r.length > 0; }).join('\n');
    if (reviewText.length === 0) return;
    parkSections.push('PARK ' + (parkSections.length + 1) + ': ' + (p.name || 'Unknown') + '\n' + reviewText);
    parkIds.push(p.placeId);
  });

  if (parkSections.length === 0) {
    return res.status(200).json({ signals: {} });
  }

  var prompt = 'You are analyzing reviews of multiple parks and playgrounds. '
    + 'For each park below, extract information about five dimensions from its reviews.\n\n'
    + 'Dimensions:\n'
    + '1. fenced - Is the area fenced? Values: "yes", "no", or "not_mentioned"\n'
    + '2. shade - Is there shade available? Values: "yes", "no", or "not_mentioned"\n'
    + '3. bathrooms - Are there bathrooms or restrooms? Values: "yes", "no", or "not_mentioned"\n'
    + '4. ageSuitability - What ages is it suitable for? Values: "toddler", "older", "both", or "not_mentioned"\n'
    + '5. parking - What parking is available? Values: "lot", "street", "both", or "not_mentioned"\n\n'
    + 'Rules:\n'
    + '- If reviews are contradictory or vague about a dimension, return "not_mentioned"\n'
    + '- If reviews do not discuss a dimension at all, return "not_mentioned"\n'
    + '- When value is "not_mentioned", set summary to null\n'
    + '- When value is not "not_mentioned", provide a brief one-sentence summary in your own words\n'
    + '- Respond with ONLY valid JSON, no markdown fences, no other text\n\n'
    + 'Here are the parks and their reviews:\n\n'
    + parkSections.join('\n\n---\n\n')
    + '\n\nRespond with a JSON array where each element corresponds to a park in the same order:\n'
    + '[\n'
    + '  {\n'
    + '    "fenced": { "value": "...", "summary": "..." },\n'
    + '    "shade": { "value": "...", "summary": "..." },\n'
    + '    "bathrooms": { "value": "...", "summary": "..." },\n'
    + '    "ageSuitability": { "value": "...", "summary": "..." },\n'
    + '    "parking": { "value": "...", "summary": "..." }\n'
    + '  },\n'
    + '  ...\n'
    + ']';

  // ---- 5. Call Gemini ----
  var geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + geminiKey;
  try {
    var geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json'
        }
      })
    });
    if (!geminiRes.ok) {
      // Gemini failed — return empty so frontend falls back.
      return res.status(200).json({ signals: {} });
    }
    var geminiData = await geminiRes.json();
    var text = geminiData.candidates
      && geminiData.candidates[0]
      && geminiData.candidates[0].content
      && geminiData.candidates[0].content.parts
      && geminiData.candidates[0].content.parts[0]
      && geminiData.candidates[0].content.parts[0].text;
    if (!text) {
      return res.status(200).json({ signals: {} });
    }
    var cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
    var parsed = JSON.parse(cleaned);

    var out = {};
    if (Array.isArray(parsed)) {
      parkIds.forEach(function (placeId, i) {
        if (parsed[i]) {
          out[placeId] = validateSignals(parsed[i]);
        }
      });
    }
    return res.status(200).json({ signals: out });
  } catch (err) {
    return res.status(200).json({ signals: {} });
  }
};

// ---- Helper: validate and normalize Gemini's response ----
// Each signal is tagged with source: 'gemini' when value is real (not 'not_mentioned').
function validateSignals(parsed) {
  var booleanDimensions = ['fenced', 'shade', 'bathrooms'];
  var booleanAllowed = ['yes', 'no', 'not_mentioned'];
  var ageAllowed = ['toddler', 'older', 'both', 'not_mentioned'];
  var parkingAllowed = ['lot', 'street', 'both', 'not_mentioned'];

  var result = {};

  booleanDimensions.forEach(function (dim) {
    if (parsed[dim] && booleanAllowed.indexOf(parsed[dim].value) !== -1) {
      var v = parsed[dim].value;
      result[dim] = {
        value: v,
        summary: v === 'not_mentioned' ? null : (parsed[dim].summary || null),
        source: v === 'not_mentioned' ? null : 'gemini'
      };
    } else {
      result[dim] = { value: 'not_mentioned', summary: null, source: null };
    }
  });

  if (parsed.ageSuitability && ageAllowed.indexOf(parsed.ageSuitability.value) !== -1) {
    var av = parsed.ageSuitability.value;
    result.ageSuitability = {
      value: av,
      summary: av === 'not_mentioned' ? null : (parsed.ageSuitability.summary || null),
      source: av === 'not_mentioned' ? null : 'gemini'
    };
  } else {
    result.ageSuitability = { value: 'not_mentioned', summary: null, source: null };
  }

  if (parsed.parking && parkingAllowed.indexOf(parsed.parking.value) !== -1) {
    var pv = parsed.parking.value;
    result.parking = {
      value: pv,
      summary: pv === 'not_mentioned' ? null : (parsed.parking.summary || null),
      source: pv === 'not_mentioned' ? null : 'gemini'
    };
  } else {
    result.parking = { value: 'not_mentioned', summary: null, source: null };
  }

  return result;
}
