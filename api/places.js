// api/places.js — Vercel serverless function
// Accepts lat/lng from the front end, calls Google Places API (New),
// and returns a cleaned list of nearby parks and playgrounds.
module.exports = async function handler(req, res) {
  // ---- 1. Validate query parameters ----
  var lat = parseFloat(req.query.lat);
  var lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'Missing or invalid lat/lng parameters' });
  }
  // ---- 1b. Validate radius parameter ----
  var allowedRadii = [0.5, 1, 2, 5];
  var radiusMiles = parseFloat(req.query.radius);
  if (req.query.radius !== undefined && allowedRadii.indexOf(radiusMiles) === -1) {
    return res.status(400).json({ error: 'Invalid radius parameter' });
  }
  if (isNaN(radiusMiles) || allowedRadii.indexOf(radiusMiles) === -1) {
    radiusMiles = 2; // default
  }
  var radiusMeters = radiusMiles * 1609.344;
  // ---- 2. Check for the API key ----
  var apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }
  // ---- 3. Call Google Places API (New) — Nearby Search ----
  var googleUrl = 'https://places.googleapis.com/v1/places:searchNearby';
  var requestBody = {
    includedTypes: ['park', 'playground'],
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: radiusMeters
      }
    },
    maxResultCount: 20
  };
  var fieldMask = [
    'places.id',
    'places.displayName',
    'places.types',
    'places.location',
    'places.rating',
    'places.userRatingCount',
    'places.photos'
  ].join(',');
  try {
    var response = await fetch(googleUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask
      },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to fetch places' });
    }
    var data = await response.json();
    // ---- 4. Handle empty results ----
    if (!data.places || data.places.length === 0) {
      return res.status(200).json({ results: [] });
    }
    // ---- 4b. Fetch photo URLs in parallel ----
    // For each place that has at least one photo, call the photo media
    // endpoint with skipHttpRedirect=true to get a short-lived CDN URL.
    // Each call is wrapped so a failure resolves to null instead of
    // crashing the whole batch.
    var photoPromises = data.places.map(function (place) {
      if (!place.photos || place.photos.length === 0) {
        return Promise.resolve(null);
      }
      var firstPhoto = place.photos[0];
      var photoMediaUrl = 'https://places.googleapis.com/v1/'
        + firstPhoto.name
        + '/media?maxHeightPx=400&skipHttpRedirect=true&key=' + apiKey;
      return fetch(photoMediaUrl)
        .then(function (photoRes) {
          if (!photoRes.ok) return null;
          return photoRes.json().then(function (photoData) {
            return {
              photoUrl: photoData.photoUri || null,
              photoAttribution: getAttribution(firstPhoto)
            };
          });
        })
        .catch(function () {
          return null;
        });
    });
    var photoResults = await Promise.all(photoPromises);
    // ---- 5. Clean and transform each result ----
    var results = data.places.map(function (place, index) {
      var placeLat = place.location.latitude;
      var placeLng = place.location.longitude;
      var photo = photoResults[index];
      return {
        name: place.displayName.text,
        type: place.types.includes('playground') ? 'playground' : 'park',
        lat: placeLat,
        lng: placeLng,
        distance: haversine(lat, lng, placeLat, placeLng),
        rating: place.rating || null,
        reviewCount: place.userRatingCount || 0,
        placeId: place.id,
        photoUrl: photo ? photo.photoUrl : null,
        photoAttribution: photo ? photo.photoAttribution : null
      };
    });
    // ---- 6. Sort by distance, closest first ----
    results.sort(function (a, b) { return a.distance - b.distance; });
    return res.status(200).json({ results: results });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to fetch places' });
  }
};
// ---- Helper: extract attribution from a photo object ----
// Returns { name, url } or null if no attribution is available.
function getAttribution(photo) {
  if (!photo.authorAttributions || photo.authorAttributions.length === 0) {
    return null;
  }
  var author = photo.authorAttributions[0];
  return {
    name: author.displayName || null,
    url: author.uri || null
  };
}
// ---- Haversine formula ----
// Calculates the straight-line distance between two lat/lng points
// on Earth's surface. Returns distance in miles.
function haversine(lat1, lng1, lat2, lng2) {
  var R = 3958.8; // Earth's radius in miles
  var dLat = toRad(lat2 - lat1);
  var dLng = toRad(lng2 - lng1);
  var a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100; // rounded to 2 decimal places
}
function toRad(deg) {
  return deg * (Math.PI / 180);
}
