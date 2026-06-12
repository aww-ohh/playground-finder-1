// api/osm.js — Vercel serverless function
// Queries the Overpass API (OpenStreetMap) for parks/playgrounds in a given area
// and returns extracted "verified" signals (fenced, shade, bathrooms, age, parking).
// The frontend matches these to Google's results by lat/lng proximity and overrides
// Gemini-extracted signals where OSM has data.

module.exports = async function handler(req, res) {
  // ---- Validate query parameters ----
  var lat = parseFloat(req.query.lat);
  var lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'Missing or invalid lat/lng' });
  }
  var radiusMiles = parseFloat(req.query.radius);
  if (isNaN(radiusMiles)) radiusMiles = 1;
  // Cap to prevent abusive Overpass queries that could hang the function.
  if (radiusMiles > 5) radiusMiles = 5;
  if (radiusMiles < 0.1) radiusMiles = 0.1;
  // OSM uses meters. Add a small buffer so we catch parks near the edge.
  var radiusMeters = Math.round(radiusMiles * 1609.344) + 100;

  // ---- Build Overpass QL query ----
  // Find parks/playgrounds near the given point, plus nearby toilets and parking
  // (used for indirect signal extraction).
  var query = '[out:json][timeout:20];'
    + '('
    +   'way[leisure~"park|playground"](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    +   'node[leisure~"park|playground"](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    +   'relation[leisure~"park|playground"](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    +   'node[amenity=toilets](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    +   'node[amenity=parking](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    // V5: tennis courts. OSM tags these with leisure=pitch + sport=tennis.
    // We grab them as ways AND nodes within the same area, then below we
    // mark a park as having tennis if any pitch sits within 80m of its center.
    +   'way[leisure=pitch][sport~"tennis"](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    +   'node[leisure=pitch][sport~"tennis"](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    // V6 F4: fun-amenity badges. Mappers tag these a few different ways in
    // the wild, so we ask for the common variants — a tag that doesn't exist
    // anywhere simply returns no elements, which is harmless.
    +   'node[playground=splash_pad](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    +   'way[playground=splash_pad](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    +   'node[amenity=drinking_water](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    +   'node[leisure=picnic_table](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    +   'way[leisure=picnic_table](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    +   'node[amenity=picnic_table](around:' + radiusMeters + ',' + lat + ',' + lng + ');'
    + ');'
    + 'out tags center;';

  try {
    // Overpass requires a User-Agent header — they reject default fetch User-Agent with 406
    var overpassRes = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'PlaygroundFinder/1.0 (https://playground-finder-1.vercel.app)'
      },
      body: 'data=' + encodeURIComponent(query)
    });
    if (!overpassRes.ok) {
      // Overpass overloaded or failing — return empty so the app gracefully ignores OSM
      return res.status(200).json({ parks: [] });
    }
    var data = await overpassRes.json();
    if (!data || !Array.isArray(data.elements)) {
      return res.status(200).json({ parks: [] });
    }

    // Split elements into parks and supporting amenities (toilets, parking, tennis)
    var parks = [];
    var toilets = [];
    var parkings = [];
    var tennisCourts = [];
    // V6 F4: amenity collections for the badge row
    var splashPads = [];
    var picnicTables = [];
    var drinkingWater = [];
    data.elements.forEach(function (el) {
      var pos = elementCenter(el);
      if (!pos) return;
      var tags = el.tags || {};
      // V6 F4: splash pads are checked OUTSIDE the else-if chain because an
      // element can be both a playground AND a splash pad — it should count
      // as both, not get swallowed by the park branch below.
      if (tags.playground === 'splash_pad') {
        splashPads.push({ lat: pos.lat, lng: pos.lng });
      }
      if (tags.leisure === 'park' || tags.leisure === 'playground') {
        parks.push({ lat: pos.lat, lng: pos.lng, tags: tags, name: tags.name || '' });
      } else if (tags.amenity === 'toilets') {
        toilets.push({ lat: pos.lat, lng: pos.lng });
      } else if (tags.amenity === 'parking') {
        parkings.push({ lat: pos.lat, lng: pos.lng });
      } else if (tags.leisure === 'pitch' && tags.sport && tags.sport.indexOf('tennis') !== -1) {
        tennisCourts.push({ lat: pos.lat, lng: pos.lng });
      } else if (tags.leisure === 'picnic_table' || tags.amenity === 'picnic_table') {
        // V6 F4: note this can't collide with the tennis branch above —
        // tennis pitches are leisure=pitch, picnic tables are leisure=picnic_table.
        picnicTables.push({ lat: pos.lat, lng: pos.lng });
      } else if (tags.amenity === 'drinking_water') {
        drinkingWater.push({ lat: pos.lat, lng: pos.lng });
      }
    });

    // For each park, derive signals from its tags + nearby amenities
    var enriched = parks.map(function (p) {
      return {
        lat: p.lat,
        lng: p.lng,
        name: p.name,
        signals: extractOsmSignals(p, toilets, parkings, tennisCourts),
        // V6 F4: display-only amenity badges (not filters). Splash pads get a
        // wider 120m net because they're often mapped as a separate feature
        // inside a bigger park; tables and fountains use the tighter 100m
        // radius we already trust for toilets.
        amenities: {
          splashPad: anyWithinMeters(p.lat, p.lng, splashPads, 120),
          picnicTables: anyWithinMeters(p.lat, p.lng, picnicTables, 100),
          drinkingWater: anyWithinMeters(p.lat, p.lng, drinkingWater, 100)
        }
      };
    });

    return res.status(200).json({ parks: enriched });
  } catch (err) {
    return res.status(200).json({ parks: [] });
  }
};

// Get the lat/lng of an OSM element (node, way, or relation)
function elementCenter(el) {
  if (typeof el.lat === 'number' && typeof el.lon === 'number') {
    return { lat: el.lat, lng: el.lon };
  }
  if (el.center && typeof el.center.lat === 'number') {
    return { lat: el.center.lat, lng: el.center.lon };
  }
  return null;
}

// Map OSM tags + nearby amenities to our 6-dimension signal schema.
// Only returns 'yes' / 'toddler' / 'lot' values — OSM rarely encodes negatives.
// Each returned signal has source: 'osm' so the frontend knows it's verified.
function extractOsmSignals(park, toilets, parkings, tennisCourts) {
  var t = park.tags;
  var out = {};

  // Fenced — multiple possible tags
  if (t.barrier === 'fence' || t['playground:fenced'] === 'yes' || t.fence === 'yes' || t.fenced === 'yes') {
    out.fenced = { value: 'yes', source: 'osm', summary: null };
  }

  // Bathrooms — direct tag or amenity=toilets within 100m
  if (t.toilets === 'yes' || t['playground:toilets'] === 'yes') {
    out.bathrooms = { value: 'yes', source: 'osm', summary: null };
  } else if (anyWithinMeters(park.lat, park.lng, toilets, 100)) {
    out.bathrooms = { value: 'yes', source: 'osm', summary: null };
  }

  // Age suitability
  if (t['playground:age'] === 'toddler' || t['min_age'] === '0' || t['min_age'] === '1' || t['min_age'] === '2') {
    out.ageSuitability = { value: 'toddler', source: 'osm', summary: null };
  } else if (t['playground:age'] === 'all' || t['playground:max_age']) {
    out.ageSuitability = { value: 'both', source: 'osm', summary: null };
  }

  // Parking — direct tag or amenity=parking within 200m
  if (t.parking === 'yes' || anyWithinMeters(park.lat, park.lng, parkings, 200)) {
    out.parking = { value: 'lot', source: 'osm', summary: null };
  }

  // Shade — rarely tagged, but check the obvious ones
  if (t.shade === 'yes' || t['playground:shade'] === 'yes') {
    out.shade = { value: 'yes', source: 'osm', summary: null };
  }

  // V5: Tennis courts. A tennis pitch counts if it sits within 80m of the
  // park center — close enough to credit the park, far enough that we don't
  // pick up the city tennis club across the street. OSM has near-complete
  // tennis tagging in North America, so this signal will be mostly green-verified.
  if (tennisCourts && anyWithinMeters(park.lat, park.lng, tennisCourts, 80)) {
    out.tennisCourts = { value: 'yes', source: 'osm', summary: null };
  }

  return out;
}

// Are any of the points in `arr` within `meters` of (lat, lng)?
function anyWithinMeters(lat, lng, arr, meters) {
  for (var i = 0; i < arr.length; i++) {
    if (haversineMeters(lat, lng, arr[i].lat, arr[i].lng) <= meters) return true;
  }
  return false;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  var R = 6371000; // meters
  var toRad = function (d) { return d * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1);
  var dLng = toRad(lng2 - lng1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
    * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
