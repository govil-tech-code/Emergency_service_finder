const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.static('public'));
app.use(express.json());
app.get('/api/nearby', async (req, res) => {
  try {
    const { lat, lon, category } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({ status: 'error', message: 'Latitude and Longitude are required.' });
    }

    // Map category aliases to exact OSM tags
    const categoryMap = {
      hospital: 'hospital',
      hospitals: 'hospital',
      police: 'police',
      pharmacy: 'pharmacy',
      pharmacies: 'pharmacy',
      fire: 'fire_station',
      fire_station: 'fire_station',
      'fire station': 'fire_station'
    };

    const amenityTag = categoryMap[category.toLowerCase()] || category.toLowerCase();

    // Increase radius to 10,000 meters (10km) so police/fire stations in broader areas are found
    const overpassQuery = `
      [out:json][timeout:25];
      (
        node["amenity"="${amenityTag}"](around:10000, ${lat}, ${lon});
        way["amenity"="${amenityTag}"](around:10000, ${lat}, ${lon});
      );
      out center;
    `;

    // Multiple mirrors in case overpass-api.de rate limits
    const mirrors = [
      `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`,
      `https://overpass.kumi.systems/api/interpreter?data=${encodeURIComponent(overpassQuery)}`
    ];

    let response = null;
    for (const url of mirrors) {
      try {
        response = await axios.get(url, {
          headers: {
            'User-Agent': 'EmergencyServiceFinder/1.0 (contact@example.com)'
          },
          timeout: 10000
        });
        if (response.data && response.data.elements) break;
      } catch (err) {
        console.warn(`Mirror failed (${url}), trying next...`);
      }
    }

    if (!response || !response.data) {
      throw new Error("All Overpass servers failed to respond.");
    }

    const places = response.data.elements.map(item => {
      const rawName = item.tags ? (item.tags.name || item.tags['name:en'] || item.tags.operator) : null;
      const formattedCategory = amenityTag.replace('_', ' ').toUpperCase();

      return {
        id: item.id,
        name: rawName || `${formattedCategory} (Unnamed)`,
        type: amenityTag,
        lat: item.lat || (item.center && item.center.lat),
        lon: item.lon || (item.center && item.center.lon),
        address: item.tags 
          ? (item.tags['addr:street'] || item.tags['addr:full'] || item.tags['addr:city'] || 'Address unavailable') 
          : 'Address unavailable'
      };
    });

    res.status(200).json({ status: 'success', count: places.length, data: places });

  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({ status: 'error', message: 'Failed to fetch services.' });
  }
});