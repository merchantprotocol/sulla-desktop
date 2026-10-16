import { resolve } from 'node:path';
export interface Config { port: number; databaseUrl: string; chunkRoot: string; internalToken?: string }
export function loadConfig():Config { const databaseUrl = process.env.SULLA_FILES_DATABASE_URL; if (!databaseUrl) throw new Error('SULLA_FILES_DATABASE_URL is required'); return { port: Number(process.env.SULLA_FILES_PORT ?? 8792), databaseUrl, chunkRoot: resolve(process.env.SULLA_FILES_CHUNK_ROOT ?? '/var/lib/sulla-files/chunks'), internalToken: process.env.SULLA_FILES_INTERNAL_TOKEN } }
