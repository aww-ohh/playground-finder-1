// api/yelp.js — Vercel serverless function
// Accepts a list of parks (placeId, name, lat, lng) and returns matching Yelp
// businesses (rating, review count, URL) keyed by Google placeId. The frontend
// uses this as a cross-source rating signal and caches matches in localStorage.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ---- Parse body ----
  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || !Array.isArray(body.parks)) {
    return res.status(400).json({ error: 'Missing or invalid parks array' });
  }
  if (body.parks.length === 0) {
    return res.status(200).json({ yelp: {} });
  }

  // ---- Check Yelp key ----
  var yelpKey = process.env.YELP_API_KEY;
  if (!yelpKey) {
    // No key configured — return empty so the frontend silently skips Yelp display
    return res.status(200).json({ yelp: {} });
  }

  // ---- For each park, search Yelp in parallel ----
  var lookups = body.parks.map(function (p) {
    if (!p || !p.placeId || !p.name || typeof p.lat !== 'number' || typeof p.lng !== 'number') {
      return Promise.resolve({ placeId: p && p.placeId, match: null });
    }
    var url = 'https://api.yelp.com/v3/businesses/search'
      + '?term=' + encodeURIComponent(p.name)
      + '&latitude=' + p.lat
      + '&longitude=' + p.lng
      + '&radius=400'
      + '&limit=3'
      + '&sort_by=distance';
    return fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + yelpKey,
        'Accept': 'application/json'
      }
    })
      .then(function (yelpRes) {
        if (!yelpRes.ok) return null;
        return yelpRes.json();
      })
      .then(function (data) {
        if (!data || !Array.isArray(data.businesses) || data.businesses.length === 0) {
          return { placeId: p.placeId, match: null };
        }
        // Pick the best name match among the top 3
        var best = pickBestMatch(p.name, data.businesses);
        if (!best) return { placeId: p.placeId, match: null };
        return {
          placeId: p.placeId,
          match: {
            yelpId: best.id,
            yelpName: best.name,
            rating: typeof best.rating === 'number' ? best.rating : null,
            reviewCount: typeof best.review_count === 'number' ? best.review_count : 0,
            yelpUrl: best.url || null
          }
        };
      })
      .catch(function () { return { placeId: p.placeId, match: null }; });
  });

  try {
    var results = await Promise.all(lookups);
    var out = {};
    results.forEach(function (r) {
      if (r && r.placeId && r.match) {
        out[r.placeId] = r.match;
      }
    });
    return res.status(200).json({ yelp: out });
  } catch (err) {
    return res.status(200).json({ yelp: {} });
  }
};

// ---- Name matching: pick the closest match among Yelp results ----
// Compares normalized names; falls back to the top result if reasonable similarity.
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickBestMatch(googleName, businesses) {
  var target = normalize(googleName);
  if (!target) return businesses[0] || null;
  var targetWords = target.split(' ').filter(function (w) { return w.length > 2; });

  var best = null;
  var bestScore = 0;
  businesses.forEach(function (b) {
    var n = normalize(b.name);
    if (!n) return;
    var score = 0;
    // Strong score if substring match either direction
    if (n.indexOf(target) !== -1 || target.indexOf(n) !== -1) score += 5;
    // Add 1 per shared meaningful word
    var bWords = n.split(' ');
    targetWords.forEach(function (w) {
      if (bWords.indexOf(w) !== -1) score += 1;
    });
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  });

  // Require at least some signal of similarity to avoid false positives
  if (bestScore >= 2) return best;
  return null;
}
