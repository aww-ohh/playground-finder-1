// api/photo.js — Vercel serverless function
// Resolves ONE Google photo "name" into a real image URL, on demand.
//
// Why this exists: resolving a photo name costs money (~$7 per 1000), but the
// names themselves are free. /api/places ships the extra photo names with each
// park, and the frontend only calls this endpoint when the user actually taps
// the "more photos" badge on a card. That way photo costs scale with taps,
// not with searches.
//
// SECURITY: the `name` parameter goes straight into a Google URL alongside our
// API key, so we validate it STRICTLY — it must look exactly like a Places
// photo resource name (places/<id>/photos/<id>). Otherwise someone could use
// this endpoint to make our key fetch arbitrary Google URLs.
module.exports = async function handler(req, res) {
  // ---- 1. Validate the photo name ----
  var name = req.query.name;
  var namePattern = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;
  if (typeof name !== 'string' || name.length > 600 || !namePattern.test(name)) {
    return res.status(400).json({ error: 'Invalid photo name' });
  }

  // ---- 2. Optional max height (carousel shows photos bigger than the
  // 300px hero thumbnail, so default to 600) ----
  var allowedHeights = [300, 600];
  var h = parseInt(req.query.h, 10);
  if (isNaN(h) || allowedHeights.indexOf(h) === -1) {
    h = 600;
  }

  // ---- 3. Check for API key ----
  var apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    // No key — tell the frontend "no photo" rather than erroring loudly.
    return res.status(200).json({ url: null });
  }

  // ---- 4. Ask Google to turn the name into a googleusercontent URL ----
  var photoMediaUrl = 'https://places.googleapis.com/v1/' + name
    + '/media?maxHeightPx=' + h + '&skipHttpRedirect=true&key=' + apiKey;
  try {
    var response = await fetch(photoMediaUrl);
    if (!response.ok) {
      // Photo gone or quota hiccup — frontend treats null as "unavailable".
      return res.status(200).json({ url: null });
    }
    var photoData = await response.json();
    // Cache for a day: the same photo name always resolves to the same image,
    // so repeat taps (or other users tapping the same park) are free.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).json({ url: photoData.photoUri || null });
  } catch (err) {
    return res.status(200).json({ url: null });
  }
};
