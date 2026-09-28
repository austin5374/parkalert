// Every setting read from the environment, in one place. None is required;
// the README describes each. Read once, when the server starts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

export const PORT = env.PORT || 3000;

// Data lives on an attached volume when one exists (Railway injects
// RAILWAY_VOLUME_MOUNT_PATH automatically), falling back to ./data locally.
export const DATA_DIR =
  env.DATA_DIR ||
  env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

export const NTFY_BASE = env.NTFY_BASE || 'https://ntfy.sh';

// Tapping an alert opens the app instead of the ntfy inbox. Railway sets
// RAILWAY_PUBLIC_DOMAIN; PUBLIC_URL overrides it anywhere else.
export const APP_URL =
  env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null);

// Overridable so tests (or a caching mirror) can stand in for the real API.
export const THEMEPARKS_BASE = env.THEMEPARKS_BASE || 'https://api.themeparks.wiki/v1';
export const THEMEPARKS_API_KEY = env.THEMEPARKS_API_KEY || null;

// Live airport weather reports (NOAA's Aviation Weather Center) and their
// archive (Iowa State's ASOS archive), both free with no key.
export const WEATHER_BASE = env.WEATHER_BASE || 'https://aviationweather.gov/api/data';
export const WEATHER_ARCHIVE = env.WEATHER_ARCHIVE || 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py';

// How far back to backfill history. The archive refuses anything older than
// the key allows (7 days anonymous, 30 with a free key), so this is a ceiling.
export const HISTORY_DAYS = Number(env.HISTORY_DAYS) || (THEMEPARKS_API_KEY ? 30 : 7);
