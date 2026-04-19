/**
 * Model — authentication state.
 *
 * Stores the Ghost Agent session: API token, user info, teams,
 * and active team. Persists to preferences.json.
 */

import fs from 'fs';
import path from 'path';

import { app } from 'electron';

import { GHOST_AGENT_URL } from '../config';

const PREFS_FILE = path.join(app.getPath('userData'), 'audio-driver-preferences.json');
const API_BASE = GHOST_AGENT_URL;

interface Session {
  token:        string | null;
  user:         { id: string; name: string; email: string } | null;
  teams:        { id: string; name: string }[];
  activeTeamId: string | null;
  gateway:      { url: string; apiKey: string } | null;
}

let session: Session = {
  token:        null,
  user:         null,
  teams:        [],
  activeTeamId: null,
  gateway:      null,
};

function loadPrefs(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function savePrefs(prefs: Record<string, any>): void {
  try {
    const dir = path.dirname(PREFS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch { /* best effort */ }
}

function loadSession(): void {
  const prefs = loadPrefs();
  if (prefs.auth) {
    session = { ...session, ...prefs.auth };
  }
}

function saveSession(): void {
  const prefs = loadPrefs();
  prefs.auth = {
    token:        session.token,
    user:         session.user,
    teams:        session.teams,
    activeTeamId: session.activeTeamId,
    gateway:      session.gateway,
  };
  savePrefs(prefs);
}

export function getSession() {
  return {
    user:         session.user,
    teams:        session.teams,
    activeTeamId: session.activeTeamId,
    loggedIn:     !!session.token,
  };
}

export function getToken(): string | null {
  return session.token;
}

export function getApiBase(): string {
  return API_BASE;
}

export function setSession({ token, user, teams, gateway }: Partial<Session>): void {
  session.token = token || session.token;
  session.user = user || session.user;
  session.teams = teams || session.teams;
  session.gateway = gateway || session.gateway;
  if (!session.activeTeamId && session.teams.length > 0) {
    session.activeTeamId = session.teams[0].id;
  }
  saveSession();
}

export function setActiveTeamId(teamId: string): void {
  session.activeTeamId = teamId;
  saveSession();
}

export function getGateway() {
  return session.gateway || { url: null, apiKey: null };
}

export function clearSession(): void {
  session = { token: null, user: null, teams: [], activeTeamId: null, gateway: null };
  saveSession();
}

export function isLoggedIn(): boolean {
  return !!session.token;
}

// Load on import
loadSession();
