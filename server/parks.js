// Known parks: ThemeParks.wiki entity IDs + geofence for GPS auto-detection.
// timezone decides where a park's day starts, which the history archive is keyed by.
// Add more parks by appending entries here (id from https://api.themeparks.wiki/v1/destinations).
export const PARKS = [
  {
    id: '75ea578a-adc8-4116-a54d-dccb60765ef9',
    name: 'Magic Kingdom',
    timezone: 'America/New_York',
    lat: 28.4177,
    lng: -81.5812,
    radiusKm: 2.0,
  },
  {
    id: '47f90d2c-e191-4239-a466-5892ef59a88b',
    name: 'EPCOT',
    timezone: 'America/New_York',
    lat: 28.3747,
    lng: -81.5494,
    radiusKm: 2.0,
  },
  {
    id: '288747d1-8b4f-4a64-867e-ea7c9b27bad8',
    name: 'Hollywood Studios',
    timezone: 'America/New_York',
    lat: 28.3575,
    lng: -81.5583,
    radiusKm: 1.5,
  },
  {
    id: '1c84a229-8862-4648-9c71-378ddd2c7693',
    name: 'Animal Kingdom',
    timezone: 'America/New_York',
    lat: 28.3553,
    lng: -81.5901,
    radiusKm: 2.0,
  },
  {
    id: '7340550b-c14d-4def-80bb-acdb51d49a66',
    name: 'Disneyland (CA)',
    timezone: 'America/Los_Angeles',
    lat: 33.8121,
    lng: -117.919,
    radiusKm: 1.0,
  },
  {
    id: '832fcd51-ea19-4e77-85c7-75d5843b127c',
    name: 'California Adventure',
    timezone: 'America/Los_Angeles',
    lat: 33.806,
    lng: -117.9223,
    radiusKm: 1.0,
  },
];

export function getPark(id) {
  return PARKS.find((p) => p.id === id) || null;
}
