<div align="center">

<img src="icon.svg" alt="Playground & Park Finder logo" width="110" />

# Playground &amp; Park Finder

**Find playgrounds and parks with the features that actually matter —
fenced, shaded, bathrooms, parking, toddler-friendly, tennis — read from
real reviews by AI and verified against map data.**

### [▶ Try the live app &nbsp;→&nbsp; playground-finder-1.vercel.app](https://playground-finder-1.vercel.app)

[![Live Demo](https://img.shields.io/badge/Live_demo-playground--finder--1.vercel.app-ffb800?style=for-the-badge)](https://playground-finder-1.vercel.app)
&nbsp;
![PWA installable](https://img.shields.io/badge/PWA-installable-0d9b62?style=for-the-badge)
&nbsp;
![License: MIT](https://img.shields.io/badge/license-MIT-3aa9e8?style=for-the-badge)

</div>

---

## What it is

Map apps tell you a park *exists*. They don't tell you what a parent of a
little kid needs to know before loading everyone into the car: is it
**fenced** so a toddler can't bolt? Is there **shade** in July? A
**bathroom**? Somewhere to **park**? That information is buried in hundreds
of reviews nobody has time to read.

**Playground & Park Finder reads the reviews for you.** Search any address
(or use your location), and each nearby park shows clear answers for the six
things that matter most — pulled from real reviews and cross-checked against
public map data.

## Screenshots

<div align="center">
  <img src="docs/screenshot-results.png" alt="Search results — park cards with photos, ratings, open-now status, and at-a-glance feature icons" width="265" />
  &nbsp;&nbsp;
  <img src="docs/screenshot-map.png" alt="The search view — weather, feature filters, and a map of nearby San Francisco parks" width="265" />
</div>

## How it works

Behind every search:

1. **Find the parks.** The Google Places API returns nearby playgrounds and
   parks with photos, ratings, hours, and recent Google reviews.
2. **Read the reviews with AI.** Each park's reviews go to Google's
   **Gemini 2.5 Flash-Lite** model, which extracts structured yes/no answers
   to six specific questions and writes a one-line summary for each.
3. **Cross-verify against the map.** The same parks are looked up in
   OpenStreetMap, whose community has tagged real-world features (fences,
   restrooms, parking, splash pads…). Where the map confirms a feature, it's
   marked **verified**.
4. **Layer in Google's own facts.** Google publishes structured fields for
   some parks (has a restroom, good for children); these are treated as
   first-party truth.

Each feature shows one of two badges — **from reviews** (Gemini's read) or
**verified** (confirmed by map / Google data) — labeled honestly so you
always know the source.

## Features

- 🔒 Fenced · 🌳 Shade · 🚻 Bathrooms · 👶 Toddler-friendly · 🅿️ Parking · 🎾 Tennis — all filterable
- 🌤 Live weather + hourly rain outlook for the search area
- 🚗 Estimated drive time, for nap-window planning
- ⭐ Save favorites and private notes (stored on your device)
- 🔗 One-tap sharing of a single park or a whole collection
- 📱 Installable as an app (PWA), works offline

## Built with

- **Frontend:** HTML, CSS, and vanilla JavaScript written from scratch — no
  framework. Installable as a Progressive Web App.
- **Backend:** [Vercel](https://vercel.com/) serverless functions (Node) that
  keep API keys server-side.
- **AI:** [Google Gemini 2.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models).
- **Data:** [Google Places API](https://developers.google.com/maps/documentation/places/web-service/overview),
  [OpenStreetMap](https://www.openstreetmap.org/) (Overpass),
  [Open-Meteo](https://open-meteo.com/) (weather),
  [Nominatim](https://nominatim.org/) (address search).
- **Maps:** [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles.

## Running locally

A static site with serverless API functions, deployed on Vercel:

```bash
npm i -g vercel
vercel dev
```

Requires `GOOGLE_PLACES_API_KEY` and `GEMINI_API_KEY` as environment
variables. The frontend (`index.html` / `app.js` / `style.css`) is plain
static files.

## Privacy

No accounts, no tracking. Favorites, notes, recent searches, and your home
location live only in your browser — nothing is sent to a server or shared.

## About

A personal project by **Alex** — free to use, no ads. Built to learn by
shipping a real, end-to-end AI product. Feedback welcome via the in-app link.

MIT licensed — see [LICENSE](LICENSE).
