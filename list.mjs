import { createDshAuth } from './src/transport/dsh-auth.js'
import crypto from 'node:crypto'
const baseUrl='http://127.0.0.1:62447'
const auth = createDshAuth({ baseUrl })
const headers = { 'content-type': 'application/json' }
const c = auth.cookieHeader(); if (c) headers.cookie = c
const res = await fetch(`${baseUrl}/api/pluginManager/listPlugins`, { method:'POST', headers, body: JSON.stringify({ type:'client-request', rpcId:crypto.randomUUID(), method:'pluginManager/listPlugins', payload:{args:{}} }) })
const j = await res.json()
const rows = j.result?.value ?? []
for (const r of rows) if (String(r.entryId).includes('preset') || String(r.moduleName).includes('preset')) console.log(r.entryId, r.enabled, r.fiberPhase, JSON.stringify(r.warnings??'').slice(0,120))
