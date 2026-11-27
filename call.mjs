import { createDshAuth } from './src/transport/dsh-auth.js'
import crypto from 'node:crypto'
const [baseUrl, method, argJson] = process.argv.slice(2)
const auth = createDshAuth({ baseUrl })
const headers = { 'content-type': 'application/json' }
const c = auth.cookieHeader(); if (c) headers.cookie = c
const res = await fetch(`${baseUrl}/api/${method}`, {
  method: 'POST', headers,
  body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: JSON.parse(argJson || '{}') } }),
})
console.log(res.status, (await res.text()).slice(0, 900))
